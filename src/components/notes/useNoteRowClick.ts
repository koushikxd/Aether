import { useCallback } from "react";
import { useNotes } from "../../context/NotesContext";
import { useTabs } from "../../context/TabsContext";

export type SetNoteIds = React.Dispatch<React.SetStateAction<Set<string>>>;

/**
 * Click handler for a sidebar note row. `orderedIds` is the order the rows
 * show in, for Shift+click ranges. `selecting` is selection mode.
 */
export function useNoteRowClick(
  orderedIds: readonly string[],
  selecting: boolean,
  setSelectedIds: SetNoteIds,
) {
  const { selectedNoteId, selectNote } = useNotes();
  const { openInNewTab } = useTabs();
  return useCallback(
    (noteId: string, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        openInNewTab(noteId);
        return;
      }
      if (event.shiftKey) {
        const from = selectedNoteId ? orderedIds.indexOf(selectedNoteId) : -1;
        const to = orderedIds.indexOf(noteId);
        setSelectedIds(
          new Set(
            from === -1
              ? [noteId]
              : orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1),
          ),
        );
        return;
      }
      if (selecting) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (!next.delete(noteId)) next.add(noteId);
          return next;
        });
        return;
      }
      void selectNote(noteId);
    },
    [
      orderedIds,
      selecting,
      selectedNoteId,
      selectNote,
      openInNewTab,
      setSelectedIds,
    ],
  );
}
