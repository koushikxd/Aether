/**
 * Note changes that NotesContext announces to the tabs. Each is emitted
 * before the selection changes, so listeners see it first.
 */
export type NoteEvent =
  /** A note was just created and is about to be selected. */
  | { type: "created"; id: string }
  /** Notes were renamed or moved: maps an old id to its new id. */
  | { type: "moved"; newIdOf: (id: string) => string }
  /** Notes were deleted: matches every deleted id. */
  | { type: "deleted"; isDeleted: (id: string) => boolean };

const listeners = new Set<(event: NoteEvent) => void>();

export function emitNoteEvent(event: NoteEvent) {
  listeners.forEach((listener) => listener(event));
}

/** Returns the unsubscribe function. */
export function onNoteEvent(listener: (event: NoteEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
