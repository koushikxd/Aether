import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotes } from "../context/NotesContext";
import type { NoteMetadata } from "../types/note";

const RECENT_LIMIT = 20;

export interface NoteNavigation {
  /** Opened notes, newest first, that still exist. Saved per notes folder. */
  recentNotes: NoteMetadata[];
  /** The open note's page, when it is a sub-page. */
  parentPageId: string | null;
  /** Unset when there is nothing to go back to. */
  goBack?: () => void;
  /** Unset when there is nothing to go forward to. */
  goForward?: () => void;
}

function loadRecentIds(key: string | null): string[] {
  if (!key) return [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** Index of the first entry from `start`, stepping by `step`, that passes `exists`; -1 if none. */
function nearest(
  ids: string[],
  start: number,
  step: 1 | -1,
  exists: (id: string) => boolean,
): number {
  for (let i = start; i >= 0 && i < ids.length; i += step) {
    if (exists(ids[i])) return i;
  }
  return -1;
}

/**
 * Recent notes and session back/forward history, both fed by the selected
 * note. Call once, in App, and pass the result down.
 */
export function useNoteNavigation(): NoteNavigation {
  const { notes, notesFolder, selectedNoteId, selectNote } = useNotes();
  const storageKey = notesFolder && `aether:recentNotes:${notesFolder}`;
  const [recentIds, setRecentIds] = useState(() => loadRecentIds(storageKey));
  const [history, setHistory] = useState({ ids: [] as string[], index: -1 });

  const [prevKey, setPrevKey] = useState(storageKey);
  if (storageKey !== prevKey) {
    setPrevKey(storageKey);
    setRecentIds(loadRecentIds(storageKey));
    setHistory({ ids: [], index: -1 });
  }

  // Back and forward set the history index before selecting, so they don't push
  const [prevSelectedId, setPrevSelectedId] = useState(selectedNoteId);
  if (selectedNoteId !== prevSelectedId) {
    setPrevSelectedId(selectedNoteId);
    if (selectedNoteId) {
      setRecentIds((ids) =>
        [selectedNoteId, ...ids.filter((id) => id !== selectedNoteId)].slice(
          0,
          RECENT_LIMIT,
        ),
      );
      if (history.ids[history.index] !== selectedNoteId) {
        setHistory({
          ids: [...history.ids.slice(0, history.index + 1), selectedNoteId],
          index: history.index + 1,
        });
      }
    }
  }

  useEffect(() => {
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(recentIds));
  }, [storageKey, recentIds]);

  const notesById = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes],
  );

  const recentNotes = useMemo(
    () => recentIds.flatMap((id) => notesById.get(id) ?? []),
    [recentIds, notesById],
  );

  // A page's sub-pages live in the folder named after it: `Page/Child.md`
  const parentId = selectedNoteId?.includes("/")
    ? selectedNoteId.slice(0, selectedNoteId.lastIndexOf("/"))
    : null;
  const parentPageId = parentId && notesById.has(parentId) ? parentId : null;

  // Entries for deleted or renamed notes are skipped
  const exists = (id: string) => notesById.has(id);
  const backIndex = nearest(history.ids, history.index - 1, -1, exists);
  const forwardIndex = nearest(history.ids, history.index + 1, 1, exists);

  const goTo = useCallback(
    (index: number) => {
      setHistory((h) => ({ ...h, index }));
      void selectNote(history.ids[index]);
    },
    [history.ids, selectNote],
  );

  return useMemo(
    () => ({
      recentNotes,
      parentPageId,
      goBack: backIndex >= 0 ? () => goTo(backIndex) : undefined,
      goForward: forwardIndex >= 0 ? () => goTo(forwardIndex) : undefined,
    }),
    [recentNotes, parentPageId, backIndex, forwardIndex, goTo],
  );
}
