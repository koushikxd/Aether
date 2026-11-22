import { useEffect, useMemo, useState } from "react";
import { useNotesActions } from "../../context/NotesContext";
import { outermostIds, useDeleteNotesWarning } from "../../lib/folderTree";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "../ui";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement)
  );
}

interface SelectionBarProps {
  ids: Set<string>;
  onExit: () => void;
}

/** Shown in selection mode: the count, bulk delete, and Done. */
export function SelectionBar({ ids, onExit }: SelectionBarProps) {
  const { deleteNote } = useNotesActions();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Deleting a page takes its sub-pages, so selected sub-pages are skipped
  const targets = useMemo(() => outermostIds(ids), [ids]);
  const warning = useDeleteNotesWarning(confirming ? targets : null);

  // Capture phase, so this runs before the dialog's own Esc closes it
  useEffect(() => {
    if (confirming) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditable(e.target)) onExit();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [confirming, onExit]);

  const handleDelete = async () => {
    setDeleting(true);
    for (const id of targets) await deleteNote(id);
    onExit();
  };

  return (
    // pr-12 clears the floating settings button the footer shows without git
    <div
      data-selection-bar
      className="flex items-center gap-1.5 pl-4 pr-12 py-2 border-t border-border shrink-0"
    >
      <span className="flex-1 text-sm text-text">{ids.size} selected</span>
      <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <Button size="xs" onClick={onExit}>
        Done
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{warning.title}</AlertDialogTitle>
            <AlertDialogDescription>{warning.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting || !warning.ready}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
