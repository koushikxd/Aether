import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNotes } from "./NotesContext";
import { onNoteEvent } from "../lib/noteEvents";

export interface Tab {
  id: string;
  /** Notes opened in this tab; the open one is `ids[index]`. */
  history: { ids: string[]; index: number };
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Closed tabs, newest last, for Cmd+Shift+T. Not saved. */
  closed: { noteId: string; index: number }[];
}

interface TabsContextValue {
  tabs: Tab[];
  activeTabId: string | null;
  /** Focuses the note's tab, or opens the note in a new tab. */
  openInNewTab: (noteId: string) => void;
  activateTab: (tabId: string) => void;
  /** Index into the strip; -1 is the last tab. Out of range does nothing. */
  activateIndex: (index: number) => void;
  cycleTab: (step: 1 | -1) => void;
  closeTab: (tabId: string) => void;
  /** Closes the active tab. Returns false, closing nothing, on the last tab. */
  closeActiveTab: () => boolean;
  reopenClosedTab: () => void;
  moveTab: (tabId: string, toIndex: number) => void;
  /** Unset when the active tab has nothing to go back to. */
  goBack?: () => void;
  /** Unset when the active tab has nothing to go forward to. */
  goForward?: () => void;
  /** The scroll position to restore for this note, once, after a tab switch. */
  takeScrollRestore: (noteId: string) => number | undefined;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export const tabNoteId = (tab: Tab) => tab.history.ids[tab.history.index];

const newTab = (noteId: string): Tab => ({
  id: crypto.randomUUID(),
  history: { ids: [noteId], index: 0 },
});

const EMPTY: TabsState = { tabs: [], activeTabId: null, closed: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function loadTabs(key: string | null): TabsState {
  if (!key) return EMPTY;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!isRecord(saved) || !Array.isArray(saved.tabs)) return EMPTY;
    const tabs = saved.tabs.flatMap((t: unknown): Tab[] =>
      isRecord(t) && typeof t.id === "string" && typeof t.noteId === "string"
        ? [{ id: t.id, history: { ids: [t.noteId], index: 0 } }]
        : [],
    );
    const active = tabs.find((t) => t.id === saved.activeTabId) ?? tabs[0];
    return { tabs, activeTabId: active?.id ?? null, closed: [] };
  } catch {
    return EMPTY;
  }
}

/** Removes tabs, activating the right neighbor of a removed active tab, else the left. */
function removeTabs(
  state: TabsState,
  remove: (tab: Tab) => boolean,
): TabsState {
  const tabs = state.tabs.filter((t) => !remove(t));
  if (tabs.length === state.tabs.length) return state;
  if (tabs.some((t) => t.id === state.activeTabId)) {
    return { ...state, tabs };
  }
  const at = state.tabs.findIndex((t) => t.id === state.activeTabId);
  let next = state.tabs.slice(at + 1).find((t) => tabs.includes(t));
  for (let i = at - 1; !next && i >= 0; i--) {
    if (tabs.includes(state.tabs[i])) next = state.tabs[i];
  }
  return { ...state, tabs, activeTabId: next?.id ?? null };
}

/** Shows `noteId`: in its own tab if it has one, else in a new or the active tab. */
function placeNote(
  state: TabsState,
  noteId: string,
  inNewTab: boolean,
): TabsState {
  const existing = state.tabs.find((t) => tabNoteId(t) === noteId);
  if (existing) return { ...state, activeTabId: existing.id };
  const at = state.tabs.findIndex((t) => t.id === state.activeTabId);
  if (inNewTab || at < 0) {
    const tab = newTab(noteId);
    const tabs = [...state.tabs];
    tabs.splice(at + 1, 0, tab);
    return { ...state, tabs, activeTabId: tab.id };
  }
  const tabs = state.tabs.map((t, i) => {
    if (i !== at) return t;
    const ids = [...t.history.ids.slice(0, t.history.index + 1), noteId];
    return { ...t, history: { ids, index: ids.length - 1 } };
  });
  return { ...state, tabs };
}

/** Index of the first entry from `start`, stepping by `step`, that passes `ok`; -1 if none. */
function nearest(
  ids: string[],
  start: number,
  step: 1 | -1,
  ok: (id: string) => boolean,
): number {
  for (let i = start; i >= 0 && i < ids.length; i += step) {
    if (ok(ids[i])) return i;
  }
  return -1;
}

function scrollTop() {
  return document.querySelector("[data-editor-scroll]")?.scrollTop ?? 0;
}

/**
 * Open tabs, each with its own back/forward history. The active tab follows
 * the selected note: a plain open replaces the active tab's note, and the
 * active tab's note is selected when tabs change. Saved per notes folder.
 */
export function TabsProvider({ children }: { children: ReactNode }) {
  const { notes, notesFolder, selectedNoteId, selectNote } = useNotes();
  const storageKey = notesFolder && `aether:tabs:${notesFolder}`;
  const [state, setState] = useState(() => loadTabs(storageKey));
  // The id of a note just created, which opens in a new tab
  const [createdId, setCreatedId] = useState<string | null>(null);
  const scrollsRef = useRef(new Map<string, number>());
  const restoreRef = useRef<{ noteId: string; top: number } | null>(null);

  // Updates during render are functional: one render can apply several
  const [prevKey, setPrevKey] = useState(storageKey);
  if (storageKey !== prevKey) {
    setPrevKey(storageKey);
    setState(loadTabs(storageKey));
  }

  const [prevSelectedId, setPrevSelectedId] = useState(selectedNoteId);
  if (selectedNoteId !== prevSelectedId) {
    setPrevSelectedId(selectedNoteId);
    if (selectedNoteId) {
      const inNewTab = selectedNoteId === createdId;
      setState((s) => placeNote(s, selectedNoteId, inNewTab));
    }
    if (createdId) setCreatedId(null);
  }

  // Notes deleted outside the app lose their tabs. The selected note keeps
  // its tab: a just-renamed or just-created note may be missing from a stale list.
  const notesById = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes],
  );
  const [prevNotes, setPrevNotes] = useState(notes);
  if (notes !== prevNotes) {
    setPrevNotes(notes);
    setState((s) =>
      removeTabs(s, (t) => {
        const id = tabNoteId(t);
        return id !== selectedNoteId && !notesById.has(id);
      }),
    );
  }

  useEffect(() => {
    if (!storageKey) return;
    const saved = {
      tabs: state.tabs.map((t) => ({ id: t.id, noteId: tabNoteId(t) })),
      activeTabId: state.activeTabId,
    };
    localStorage.setItem(storageKey, JSON.stringify(saved));
  }, [storageKey, state]);

  // Tab changes (switch, close, open, back) select the active tab's note
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  const activeNoteId = activeTab ? tabNoteId(activeTab) : null;
  useEffect(() => {
    if (
      activeNoteId &&
      activeNoteId !== selectedNoteId &&
      notesById.has(activeNoteId)
    ) {
      void selectNote(activeNoteId);
    }
  }, [activeNoteId, selectedNoteId, notesById, selectNote]);

  useEffect(
    () =>
      onNoteEvent((event) => {
        if (event.type === "created") {
          setCreatedId(event.id);
        } else if (event.type === "moved") {
          const { newIdOf } = event;
          setState((s) => ({
            ...s,
            tabs: s.tabs.map((t) => ({
              ...t,
              history: { ...t.history, ids: t.history.ids.map(newIdOf) },
            })),
            closed: s.closed.map((c) => ({ ...c, noteId: newIdOf(c.noteId) })),
          }));
        } else {
          const { isDeleted } = event;
          setState((s) => removeTabs(s, (t) => isDeleted(tabNoteId(t))));
        }
      }),
    [],
  );

  // Every tab switch goes through here, so the tab left behind keeps its scroll
  const update = useCallback(
    (next: (s: TabsState) => TabsState) => {
      const leaving = state.activeTabId;
      const result = next(state);
      if (result === state) return;
      if (leaving && result.activeTabId !== leaving) {
        scrollsRef.current.set(leaving, scrollTop());
        const entering = result.tabs.find((t) => t.id === result.activeTabId);
        const top = entering && scrollsRef.current.get(entering.id);
        restoreRef.current =
          entering && top !== undefined
            ? { noteId: tabNoteId(entering), top }
            : null;
      }
      setState(result);
    },
    [state],
  );

  const openInNewTab = useCallback(
    (noteId: string) => update((s) => placeNote(s, noteId, true)),
    [update],
  );

  const activateTab = useCallback(
    (tabId: string) =>
      update((s) =>
        s.tabs.some((t) => t.id === tabId) ? { ...s, activeTabId: tabId } : s,
      ),
    [update],
  );

  const activateIndex = useCallback(
    (index: number) => {
      const tab = state.tabs[index < 0 ? state.tabs.length + index : index];
      if (tab) activateTab(tab.id);
    },
    [state.tabs, activateTab],
  );

  const cycleTab = useCallback(
    (step: 1 | -1) => {
      const count = state.tabs.length;
      if (count < 2) return;
      const at = state.tabs.findIndex((t) => t.id === state.activeTabId);
      activateTab(state.tabs[(at + step + count) % count].id);
    },
    [state, activateTab],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const index = state.tabs.findIndex((t) => t.id === tabId);
      if (index < 0 || state.tabs.length < 2) return;
      scrollsRef.current.delete(tabId);
      update((s) => ({
        ...removeTabs(s, (t) => t.id === tabId),
        closed: [...s.closed, { noteId: tabNoteId(s.tabs[index]), index }],
      }));
    },
    [state.tabs, update],
  );

  const closeActiveTab = useCallback(() => {
    if (!state.activeTabId || state.tabs.length < 2) return false;
    closeTab(state.activeTabId);
    return true;
  }, [state, closeTab]);

  // Skips closed tabs whose note is gone or open again
  const reopenClosedTab = useCallback(() => {
    update((s) => {
      const open = new Set(s.tabs.map(tabNoteId));
      const closed = [...s.closed];
      for (let entry = closed.pop(); entry; entry = closed.pop()) {
        if (notesById.has(entry.noteId) && !open.has(entry.noteId)) {
          const tab = newTab(entry.noteId);
          const tabs = [...s.tabs];
          tabs.splice(Math.min(entry.index, tabs.length), 0, tab);
          return { tabs, activeTabId: tab.id, closed };
        }
      }
      return s.closed.length ? { ...s, closed } : s;
    });
  }, [notesById, update]);

  const moveTab = useCallback((tabId: string, toIndex: number) => {
    setState((s) => {
      const from = s.tabs.findIndex((t) => t.id === tabId);
      if (from < 0 || from === toIndex) return s;
      const tabs = [...s.tabs];
      tabs.splice(toIndex, 0, ...tabs.splice(from, 1));
      return { ...s, tabs };
    });
  }, []);

  // Back and forward skip notes that are gone or open in another tab
  const openElsewhere = new Set(
    state.tabs.filter((t) => t !== activeTab).map(tabNoteId),
  );
  const canVisit = (id: string) => notesById.has(id) && !openElsewhere.has(id);
  const history = activeTab?.history;
  const backIndex = history
    ? nearest(history.ids, history.index - 1, -1, canVisit)
    : -1;
  const forwardIndex = history
    ? nearest(history.ids, history.index + 1, 1, canVisit)
    : -1;

  const goTo = useCallback(
    (index: number) =>
      setState((s) => ({
        ...s,
        tabs: s.tabs.map((t) =>
          t.id === s.activeTabId
            ? { ...t, history: { ...t.history, index } }
            : t,
        ),
      })),
    [],
  );

  const takeScrollRestore = useCallback((noteId: string) => {
    const restore = restoreRef.current;
    if (restore?.noteId !== noteId) return undefined;
    restoreRef.current = null;
    return restore.top;
  }, []);

  const value = useMemo<TabsContextValue>(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      openInNewTab,
      activateTab,
      activateIndex,
      cycleTab,
      closeTab,
      closeActiveTab,
      reopenClosedTab,
      moveTab,
      goBack: backIndex >= 0 ? () => goTo(backIndex) : undefined,
      goForward: forwardIndex >= 0 ? () => goTo(forwardIndex) : undefined,
      takeScrollRestore,
    }),
    [
      state,
      openInNewTab,
      activateTab,
      activateIndex,
      cycleTab,
      closeTab,
      closeActiveTab,
      reopenClosedTab,
      moveTab,
      backIndex,
      forwardIndex,
      goTo,
      takeScrollRestore,
    ],
  );

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs() {
  const context = useContext(TabsContext);
  if (!context) throw new Error("useTabs must be used within a TabsProvider");
  return context;
}

/** Null outside a TabsProvider (the preview window has no tabs). */
export function useOptionalTabs() {
  return useContext(TabsContext);
}
