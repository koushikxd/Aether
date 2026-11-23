import { useCallback, useMemo, useEffect, useState } from "react";
import { useNotes } from "../../context/NotesContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui";
import { useDeleteNoteWarning } from "../../lib/folderTree";
import * as notesService from "../../services/notes";
import { FolderTreeView } from "./FolderTreeView";
import type { SetNoteIds } from "./useNoteRowClick";
import type { Settings } from "../../types/note";

interface NoteListProps {
  multiSelectedNoteIds: Set<string>;
  setMultiSelectedNoteIds: SetNoteIds;
}

export function NoteList({
  multiSelectedNoteIds,
  setMultiSelectedNoteIds,
}: NoteListProps) {
  const { notes, deleteNote, isLoading } = useNotes();

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const deleteWarning = useDeleteNoteWarning(
    deleteDialogOpen ? noteToDelete : null,
  );
  const [settings, setSettings] = useState<Settings | null>(null);

  // Load settings when notes change
  useEffect(() => {
    notesService
      .getSettings()
      .then(setSettings)
      .catch((error) => {
        console.error("Failed to load settings:", error);
      });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- notes is an intentional refetch trigger: pins change alongside note mutations
  }, [notes]);

  // Calculate pinned IDs set for efficient lookup
  const pinnedIds = useMemo(
    () => new Set(settings?.pinnedNoteIds || []),
    [settings],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (noteToDelete) {
      try {
        await deleteNote(noteToDelete);
        setNoteToDelete(null);
        setDeleteDialogOpen(false);
      } catch (error) {
        console.error("Failed to delete note:", error);
      }
    }
  }, [noteToDelete, deleteNote]);

  const openDeleteDialogForNote = useCallback((noteId: string) => {
    setNoteToDelete(noteId);
    setDeleteDialogOpen(true);
  }, []);

  const selectOnly = useCallback(
    (id: string) => setMultiSelectedNoteIds(new Set([id])),
    [setMultiSelectedNoteIds],
  );

  useEffect(() => {
    const handleRequestDelete = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const noteId: unknown = event.detail;
      if (typeof noteId !== "string" || !noteId) return;
      openDeleteDialogForNote(noteId);
    };

    window.addEventListener("request-delete-note", handleRequestDelete);
    return () =>
      window.removeEventListener("request-delete-note", handleRequestDelete);
  }, [openDeleteDialogForNote]);

  if (isLoading && notes.length === 0) {
    return (
      <div className="p-4 text-center text-text-muted select-none">
        Loading...
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-text-muted select-none">
        No notes yet
      </div>
    );
  }

  return (
    <>
      <FolderTreeView
        pinnedIds={pinnedIds}
        multiSelectedNoteIds={multiSelectedNoteIds}
        setMultiSelectedNoteIds={setMultiSelectedNoteIds}
        onSelectMultiple={selectOnly}
      />

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteWarning.text}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!deleteWarning.ready}
              onClick={handleDeleteConfirm}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
