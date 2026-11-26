import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { Note, NoteMetadata } from "../types/note";
import * as notesService from "../services/notes";
import { errorMessage } from "../services/export";
import { emitNoteEvent } from "../lib/noteEvents";

/** Maps `from` and everything under `from/` (a page's sub-pages) to `to`. */
const movedFrom = (from: string, to: string) => (id: string) =>
  id === from || id.startsWith(`${from}/`) ? to + id.slice(from.length) : id;

// Separate contexts to prevent unnecessary re-renders
// Data context: changes frequently, only subscribed by components that need the data
interface NotesDataContextValue {
  notes: NoteMetadata[];
  selectedNoteId: string | null;
  currentNote: Note | null;
  notesFolder: string | null;
  isLoading: boolean;
  error: string | null;
  hasExternalChanges: boolean;
  reloadVersion: number;
}

// Actions context: stable references, rarely causes re-renders
interface NotesActionsContextValue {
  selectNote: (id: string) => Promise<void>;
  /** Creates a top-level page and opens it. */
  createNote: () => Promise<void>;
  consumePendingNewNote: (id: string) => boolean;
  /** `onSaved` runs with the saved note before any state changes. */
  saveNote: (
    content: string,
    noteId?: string,
    onSaved?: (note: Note) => void,
  ) => Promise<void>;
  /** Registers the editor's flush, which moves await before paths change. */
  setPendingSaveFlush: (flush: (() => Promise<void>) | null) => void;
  deleteNote: (id: string) => Promise<void>;
  duplicateNote: (id: string) => Promise<void>;
  refreshNotes: () => Promise<void>;
  reloadCurrentNote: () => Promise<void>;
  setNotesFolder: (path: string) => Promise<void>;
  syncNotesFolder: (path: string) => Promise<void>;
  pinNote: (id: string) => Promise<void>;
  unpinNote: (id: string) => Promise<void>;
  createNoteInFolder: (folderPath: string) => Promise<void>;
  moveNote: (id: string, targetFolder: string) => Promise<void>;
}

const NotesDataContext = createContext<NotesDataContextValue | null>(null);
const NotesActionsContext = createContext<NotesActionsContextValue | null>(
  null,
);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [notesFolder, setNotesFolderState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasExternalChanges, setHasExternalChanges] = useState(false);
  // Increments when user manually refreshes, so Editor knows to reload content
  const [reloadVersion, setReloadVersion] = useState(0);

  // Track recently saved note IDs to ignore file-change events from our own saves
  const recentlySavedRef = useRef<Set<string>>(new Set());
  // In-app moves waiting on the backend. The watcher reports the new paths
  // before the move returns its ids, and a list with them then would close
  // the moved notes' tabs, so refreshes wait until the last move returns.
  const movesInFlightRef = useRef(0);
  const refreshDeferredRef = useRef(false);
  // Track pending refresh timeout to debounce refreshes during rapid saves
  const refreshTimeoutRef = useRef<number | null>(null);
  // Ref to access selectedNoteId in file watcher without re-registering listener
  const selectedNoteIdRef = useRef<string | null>(null);
  const currentNoteRef = useRef<Note | null>(null);
  // Layout effect so async callbacks see the new values as soon as they commit
  useLayoutEffect(() => {
    selectedNoteIdRef.current = selectedNoteId;
    currentNoteRef.current = currentNote;
  }, [selectedNoteId, currentNote]);
  // Monotonic counter to ignore stale async note selection responses.
  const selectRequestIdRef = useRef(0);
  // Tracks the ID of a newly created note so Editor can focus its title.
  const pendingNewNoteIdRef = useRef<string | null>(null);
  const flushPendingSaveRef = useRef<(() => Promise<void>) | null>(null);

  const refreshNotes = useCallback(async () => {
    if (!notesFolder) return;
    if (movesInFlightRef.current > 0) {
      refreshDeferredRef.current = true;
      return;
    }
    try {
      const notesList = await notesService.listNotes();
      setNotes(notesList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notes");
    }
  }, [notesFolder]);

  // The caller emits the move's `moved` event right after this returns, before
  // a refresh started here can list the new paths
  const whileMoving = useCallback(
    <T,>(move: () => Promise<T>): Promise<T> => {
      movesInFlightRef.current++;
      return move().finally(() => {
        movesInFlightRef.current--;
        if (movesInFlightRef.current === 0 && refreshDeferredRef.current) {
          refreshDeferredRef.current = false;
          void refreshNotes();
        }
      });
    },
    [refreshNotes],
  );

  // Debounced refresh - coalesces rapid saves into a single refresh
  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null;
      void refreshNotes();
    }, 300);
  }, [refreshNotes]);

  const selectNote = useCallback(async (id: string) => {
    const requestId = ++selectRequestIdRef.current;
    try {
      if (pendingNewNoteIdRef.current !== id) {
        pendingNewNoteIdRef.current = null;
      }
      // Set selected ID immediately for responsive UI
      setSelectedNoteId(id);
      setHasExternalChanges(false);
      // Expand parent folders so the note is visible in the tree
      const lastSlash = id.lastIndexOf("/");
      if (lastSlash > 0) {
        window.dispatchEvent(
          new CustomEvent("expand-folder", {
            detail: id.substring(0, lastSlash),
          }),
        );
      }
      const note = await notesService.readNote(id);
      if (requestId !== selectRequestIdRef.current) return;
      setCurrentNote(note);
    } catch (err) {
      if (requestId !== selectRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load note");
    }
  }, []);

  const reloadCurrentNote = useCallback(async () => {
    if (!selectedNoteIdRef.current) return;
    const requestId = selectRequestIdRef.current;
    try {
      const note = await notesService.readNote(selectedNoteIdRef.current);
      if (requestId !== selectRequestIdRef.current) return;
      setCurrentNote(note);
      setHasExternalChanges(false);
      setReloadVersion((v) => v + 1);
    } catch (err) {
      if (requestId !== selectRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to reload note");
    }
  }, []);

  const createNote = useCallback(async () => {
    try {
      const note = await notesService.createNote();
      selectRequestIdRef.current += 1;
      pendingNewNoteIdRef.current = note.id;
      // Mark as recently saved to ignore file-change events from our own creation
      recentlySavedRef.current.add(note.id);
      await refreshNotes();
      emitNoteEvent({ type: "created", id: note.id });
      setCurrentNote(note);
      setSelectedNoteId(note.id);
      setTimeout(() => {
        recentlySavedRef.current.delete(note.id);
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create note");
    }
  }, [refreshNotes]);

  const consumePendingNewNote = useCallback((id: string) => {
    if (pendingNewNoteIdRef.current !== id) {
      pendingNewNoteIdRef.current = null;
      return false;
    }
    pendingNewNoteIdRef.current = null;
    return true;
  }, []);

  // Moves change note ids and can rewrite links inside the open note:
  // follow it to its new id, or reload it when its file changed.
  const followSelectedNote = useCallback(
    async (newIdOf: (id: string) => string) => {
      const oldId = selectedNoteIdRef.current;
      if (!oldId) return;
      const id = newIdOf(oldId);
      const loaded = currentNoteRef.current?.content;
      const note = await notesService.readNote(id);
      if (selectedNoteIdRef.current !== oldId) return;
      // The file watcher reports these writes; they are not external edits
      recentlySavedRef.current.add(id);
      setTimeout(() => recentlySavedRef.current.delete(id), 1000);
      if (id !== oldId) {
        // A selectNote read for the old id must not replace this note
        selectRequestIdRef.current += 1;
        setSelectedNoteId(id);
        setCurrentNote(note);
      } else if (note.content !== loaded) {
        setCurrentNote(note);
        setReloadVersion((v) => v + 1);
      }
    },
    [],
  );

  const saveNote = useCallback(
    async (
      content: string,
      noteId?: string,
      onSaved?: (note: Note) => void,
    ) => {
      // Use provided noteId (for flush saves) or fall back to currentNote.id
      const savingNoteId = noteId || currentNote?.id;
      if (!savingNoteId) return;
      let updatedId: string | null = null;

      try {
        // Mark this note as recently saved to ignore file-change events from our own save
        recentlySavedRef.current.add(savingNoteId);

        const updated = await notesService.saveNote(savingNoteId, content);
        updatedId = updated.id;
        onSaved?.(updated);

        // If the note was renamed (ID changed), also mark the new ID.
        // The backend moved its pins, and its sub-pages' pins, along.
        if (updated.id !== savingNoteId) {
          recentlySavedRef.current.add(updated.id);
          emitNoteEvent({
            type: "moved",
            newIdOf: movedFrom(savingNoteId, updated.id),
          });
        }

        // Clear external changes flag - if it was set by our own save, we want to ignore it
        setHasExternalChanges(false);

        // Only update state if we're still on the same note we started saving
        // This prevents race conditions when user switches notes during save
        setSelectedNoteId((prevId) => {
          if (prevId === savingNoteId) {
            // Update to the new ID if the note was renamed
            setCurrentNote(updated);
            return updated.id;
          }
          // User switched to a different note, don't update current note
          return prevId;
        });

        // A renamed page took its sub-pages along, maybe the open one
        const prefix = `${savingNoteId}/`;
        if (
          updated.id !== savingNoteId &&
          selectedNoteIdRef.current?.startsWith(prefix)
        ) {
          await followSelectedNote(
            (selected) => `${updated.id}/${selected.slice(prefix.length)}`,
          );
        }

        // Schedule refresh with debounce - avoids blocking typing during rapid saves
        scheduleRefresh();

        // Clear the recently saved flag after a short delay
        // (longer than the file watcher debounce of 500ms)
        setTimeout(() => {
          recentlySavedRef.current.delete(savingNoteId);
          if (updatedId) recentlySavedRef.current.delete(updatedId);
        }, 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save note");
        // Clean up immediately on error to avoid leaving stale entries
        recentlySavedRef.current.delete(savingNoteId);
        if (updatedId) recentlySavedRef.current.delete(updatedId);
      }
    },
    [currentNote, scheduleRefresh, followSelectedNote],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      // A page's sub-pages are deleted with it
      const isDeleted = (noteId: string) =>
        noteId === id || noteId.startsWith(`${id}/`);
      try {
        await notesService.deleteNote(id);

        // Clean up pinned status for deleted notes
        const currentSettings = await notesService.getSettings();
        const pinnedIds = currentSettings.pinnedNoteIds || [];
        if (pinnedIds.some(isDeleted)) {
          const updatedSettings = {
            ...currentSettings,
            pinnedNoteIds: pinnedIds.filter((pinId) => !isDeleted(pinId)),
          };
          await notesService.updateSettings(updatedSettings);
        }

        emitNoteEvent({ type: "deleted", isDeleted });
        // Only clear selection if we're deleting the currently selected note
        setSelectedNoteId((prevId) => {
          if (prevId && isDeleted(prevId)) {
            setCurrentNote(null);
            return null;
          }
          return prevId;
        });
        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete note");
      }
    },
    [refreshNotes],
  );

  const duplicateNote = useCallback(
    async (id: string) => {
      try {
        const newNote = await notesService.duplicateNote(id);
        selectRequestIdRef.current += 1;
        // Mark as recently saved to ignore file-change events from our own creation
        recentlySavedRef.current.add(newNote.id);
        await refreshNotes();
        emitNoteEvent({ type: "created", id: newNote.id });
        setCurrentNote(newNote);
        setSelectedNoteId(newNote.id);
        setTimeout(() => {
          recentlySavedRef.current.delete(newNote.id);
        }, 1000);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to duplicate note",
        );
      }
    },
    [refreshNotes],
  );

  const pinNote = useCallback(
    async (id: string) => {
      try {
        const currentSettings = await notesService.getSettings();
        const pinnedIds = currentSettings.pinnedNoteIds || [];

        if (!pinnedIds.includes(id)) {
          const updatedSettings = {
            ...currentSettings,
            pinnedNoteIds: [...pinnedIds, id],
          };
          await notesService.updateSettings(updatedSettings);
          await refreshNotes();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to pin note");
      }
    },
    [refreshNotes],
  );

  const unpinNote = useCallback(
    async (id: string) => {
      try {
        const currentSettings = await notesService.getSettings();
        const pinnedIds = currentSettings.pinnedNoteIds || [];

        const updatedSettings = {
          ...currentSettings,
          pinnedNoteIds: pinnedIds.filter((pinId) => pinId !== id),
        };
        await notesService.updateSettings(updatedSettings);
        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to unpin note");
      }
    },
    [refreshNotes],
  );

  const createNoteInFolder = useCallback(
    async (folderPath: string) => {
      try {
        const note = await notesService.createNote(folderPath);
        selectRequestIdRef.current += 1;
        pendingNewNoteIdRef.current = note.id;
        recentlySavedRef.current.add(note.id);
        await refreshNotes();
        emitNoteEvent({ type: "created", id: note.id });
        setCurrentNote(note);
        setSelectedNoteId(note.id);
        setTimeout(() => {
          recentlySavedRef.current.delete(note.id);
        }, 1000);
      } catch (err) {
        toast.error(errorMessage(err, "Failed to create note"));
      }
    },
    [refreshNotes],
  );

  const setPendingSaveFlush = useCallback(
    (flush: (() => Promise<void>) | null) => {
      flushPendingSaveRef.current = flush;
    },
    [],
  );

  const moveNoteAction = useCallback(
    async (id: string, targetFolder: string) => {
      try {
        await flushPendingSaveRef.current?.();
        const newId = await whileMoving(() =>
          notesService.moveNote(id, targetFolder),
        );
        // A page's sub-pages move with it
        const newIdOf = movedFrom(id, newId);
        emitNoteEvent({ type: "moved", newIdOf });
        await followSelectedNote(newIdOf);
        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move note");
      }
    },
    [refreshNotes, followSelectedNote, whileMoving],
  );

  const setNotesFolder = useCallback(async (path: string) => {
    try {
      await notesService.setNotesFolder(path);
      setNotesFolderState(path);
      setSelectedNoteId(null);
      setCurrentNote(null);
      // Start file watcher after setting folder
      await notesService.startFileWatcher();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to set notes folder",
      );
    }
  }, []);

  // Update local state only (backend already initialized the folder).
  // Used when the CLI sets the notes folder and emits an event.
  const syncNotesFolder = useCallback(async (path: string) => {
    try {
      setNotesFolderState(path);
      setSelectedNoteId(null);
      setCurrentNote(null);
      const notesList = await notesService.listNotes();
      setNotes(notesList);
      await notesService.startFileWatcher();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to sync notes folder",
      );
    }
  }, []);

  // Load initial state
  useEffect(() => {
    async function init() {
      try {
        const folder = await notesService.getNotesFolder();
        setNotesFolderState(folder);
        if (folder) {
          const notesList = await notesService.listNotes();
          setNotes(notesList);
          // Start file watcher
          await notesService.startFileWatcher();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to initialize");
      } finally {
        setIsLoading(false);
      }
    }
    void init();
  }, []);

  // Listen for file change events and notify if current note changed externally
  useEffect(() => {
    let isCancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<{ changed_ids: string[] }>("file-change", (event) => {
      // Don't process if effect was cleaned up
      if (isCancelled) return;

      const changedIds = event.payload.changed_ids || [];

      // Filter out notes we recently saved ourselves
      const externalChanges = changedIds.filter(
        (id) => !recentlySavedRef.current.has(id),
      );

      // Only refresh if there are external changes
      if (externalChanges.length > 0) {
        void refreshNotes();

        // If the currently selected note was changed externally, set flag (don't auto-reload)
        const currentId = selectedNoteIdRef.current;
        if (currentId && externalChanges.includes(currentId)) {
          setHasExternalChanges(true);
        }
      }
    }).then((fn) => {
      if (isCancelled) {
        // Effect was cleaned up before listener registered, clean up immediately
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      isCancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [refreshNotes]);

  // Listen for "select-note" events from the backend (CLI, drag-drop, Open With, import from preview)
  useEffect(() => {
    const unlisten = listen<string>("select-note", (event) => {
      // Refresh the notes list so the sidebar shows the new note immediately
      void refreshNotes();
      void selectNote(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [selectNote, refreshNotes]);

  // The backend took in a settings file another program (the CLI) wrote.
  // The sidebar reads pins again when the notes list refreshes.
  useEffect(() => {
    const unlisten = listen("settings-changed", () => void refreshNotes());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  // Refresh notes when folder changes
  useEffect(() => {
    if (notesFolder) {
      // oxlint-disable-next-line react/set-state-in-effect -- false positive: refreshNotes only sets state after `await listNotes()`
      void refreshNotes();
    }
  }, [notesFolder, refreshNotes]);

  // Memoize data context value to prevent unnecessary re-renders
  const dataValue = useMemo<NotesDataContextValue>(
    () => ({
      notes,
      selectedNoteId,
      currentNote,
      notesFolder,
      isLoading,
      error,
      hasExternalChanges,
      reloadVersion,
    }),
    [
      notes,
      selectedNoteId,
      currentNote,
      notesFolder,
      isLoading,
      error,
      hasExternalChanges,
      reloadVersion,
    ],
  );

  // Memoize actions context value - these are stable callbacks
  const actionsValue = useMemo<NotesActionsContextValue>(
    () => ({
      selectNote,
      createNote,
      consumePendingNewNote,
      saveNote,
      setPendingSaveFlush,
      deleteNote,
      duplicateNote,
      refreshNotes,
      reloadCurrentNote,
      setNotesFolder,
      syncNotesFolder,
      pinNote,
      unpinNote,
      createNoteInFolder,
      moveNote: moveNoteAction,
    }),
    [
      selectNote,
      createNote,
      consumePendingNewNote,
      saveNote,
      setPendingSaveFlush,
      deleteNote,
      duplicateNote,
      refreshNotes,
      reloadCurrentNote,
      setNotesFolder,
      syncNotesFolder,
      pinNote,
      unpinNote,
      createNoteInFolder,
      moveNoteAction,
    ],
  );

  return (
    <NotesActionsContext.Provider value={actionsValue}>
      <NotesDataContext.Provider value={dataValue}>
        {children}
      </NotesDataContext.Provider>
    </NotesActionsContext.Provider>
  );
}

// Hook to get notes data (subscribes to data changes)
export function useNotesData() {
  const context = useContext(NotesDataContext);
  if (!context) {
    throw new Error("useNotesData must be used within a NotesProvider");
  }
  return context;
}

// Hook to get notes actions (stable references, rarely causes re-renders)
export function useNotesActions() {
  const context = useContext(NotesActionsContext);
  if (!context) {
    throw new Error("useNotesActions must be used within a NotesProvider");
  }
  return context;
}

// Combined hook for convenience (backward compatible)
export function useNotes() {
  const data = useNotesData();
  const actions = useNotesActions();
  return { ...data, ...actions };
}

// Optional hook that returns null when outside a NotesProvider (for preview mode)
export function useOptionalNotes() {
  const data = useContext(NotesDataContext);
  const actions = useContext(NotesActionsContext);
  if (!data || !actions) return null;
  return { ...data, ...actions };
}
