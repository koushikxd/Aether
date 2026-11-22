import { useEffect, useMemo, useState } from "react";
import { useNotes } from "../context/NotesContext";
import { useTabs } from "../context/TabsContext";
import type { NoteMetadata } from "../types/note";

const RECENT_LIMIT = 20;

export interface NoteNavigation {
  /** Opened notes, newest first, that still exist. Saved per notes folder. */
  recentNotes: NoteMetadata[];
  /** The open note's page, when it is a sub-page. */
  parentPageId: string | null;
  /** The active tab's back; unset when there is nothing to go back to. */
  goBack?: () => void;
  /** The active tab's forward; unset when there is nothing to go forward to. */
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

/**
 * Recent notes, fed by the selected note, and the active tab's back/forward.
 * Call once, in App, and pass the result down.
 */
export function useNoteNavigation(): NoteNavigation {
  const { notes, notesFolder, selectedNoteId } = useNotes();
  const { goBack, goForward } = useTabs();
  const storageKey = notesFolder && `aether:recentNotes:${notesFolder}`;
  const [recentIds, setRecentIds] = useState(() => loadRecentIds(storageKey));

  const [prevKey, setPrevKey] = useState(storageKey);
  if (storageKey !== prevKey) {
    setPrevKey(storageKey);
    setRecentIds(loadRecentIds(storageKey));
  }

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

  return useMemo(
    () => ({
      recentNotes,
      parentPageId,
      goBack,
      goForward,
    }),
    [recentNotes, parentPageId, goBack, goForward],
  );
}
