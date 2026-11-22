import { useCallback, useMemo, memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useNotes } from "../../context/NotesContext";
import {
  ListItem,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui";
import { cleanTitle } from "../../lib/utils";
import { useDeleteNoteWarning } from "../../lib/folderTree";
import * as notesService from "../../services/notes";
import { FolderTreeView } from "./FolderTreeView";
import { PinIcon, CopyIcon, TrashIcon } from "../icons";
import { useVault } from "../../context/VaultContext";
import { PrivacyMenuItem } from "../vault/PrivacyMenuItem";
import type { Settings } from "../../types/note";

const menuItemClass =
  "px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2 rounded-sm";

const menuSeparatorClass = "h-px bg-border my-1";

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();

  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);

  if (date >= startOfToday) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (date >= startOfYesterday) {
    return "Yesterday";
  }

  const daysAgo =
    Math.floor((startOfToday.getTime() - date.getTime()) / 86400000) + 1;
  if (daysAgo <= 6) {
    return `${daysAgo} days ago`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Memoized note item component (used in flat list)
interface NoteItemProps {
  id: string;
  title: string;
  preview?: string;
  modified: number;
  isSelected: boolean;
  isPinned: boolean;
  isPrivate: boolean;
  onSelect: (id: string) => void;
  depth?: number;
  showFolderPrefix?: boolean;
}

export const NoteItem = memo(function NoteItem({
  id,
  title,
  preview,
  modified,
  isSelected,
  isPinned,
  isPrivate,
  onSelect,
  depth,
  showFolderPrefix = true,
}: NoteItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const handleClick = useCallback(() => onSelect(id), [onSelect, id]);

  useEffect(() => {
    if (isSelected) {
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isSelected]);

  const folder =
    showFolderPrefix && id.includes("/")
      ? id.substring(0, id.lastIndexOf("/"))
      : null;
  const displayPreview = folder
    ? preview
      ? `${folder}/ · ${preview}`
      : `${folder}/`
    : preview;

  return (
    <div
      ref={ref}
      style={depth != null ? { paddingLeft: `${depth * 12}px` } : undefined}
    >
      <ListItem
        title={cleanTitle(title)}
        subtitle={displayPreview}
        meta={formatDate(modified)}
        isSelected={isSelected}
        isPinned={isPinned}
        isPrivate={isPrivate}
        onClick={handleClick}
      />
    </div>
  );
});

// Note item wrapped with Radix context menu
interface NoteItemWithMenuProps {
  id: string;
  title: string;
  preview?: string;
  modified: number;
  isSelected: boolean;
  isPinned: boolean;
  isPrivate: boolean;
  onSelect: (id: string) => void;
  onPin: (id: string) => Promise<void>;
  onUnpin: (id: string) => Promise<void>;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRefreshSettings: () => Promise<void> | void;
}

const NoteItemWithMenu = memo(function NoteItemWithMenu({
  id,
  title,
  preview,
  modified,
  isSelected,
  isPinned,
  isPrivate,
  onSelect,
  onPin,
  onUnpin,
  onDuplicate,
  onDelete,
  onRefreshSettings,
}: NoteItemWithMenuProps) {
  const handlePin = useCallback(async () => {
    try {
      await (isPinned ? onUnpin(id) : onPin(id));
      await onRefreshSettings();
    } catch (error) {
      console.error("Failed to pin/unpin note:", error);
    }
  }, [id, isPinned, onPin, onUnpin, onRefreshSettings]);

  const handleCopyFilepath = useCallback(async () => {
    try {
      const folder = await notesService.getNotesFolder();
      if (folder) {
        const filepath = `${folder}/${id}.md`;
        await invoke("copy_to_clipboard", { text: filepath });
      }
    } catch (error) {
      console.error("Failed to copy filepath:", error);
    }
  }, [id]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div>
          <NoteItem
            id={id}
            title={title}
            preview={preview}
            modified={modified}
            isSelected={isSelected}
            isPinned={isPinned}
            isPrivate={isPrivate}
            onSelect={onSelect}
          />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-44 bg-bg border border-border rounded-md shadow-lg py-1 z-50">
          <ContextMenu.Item className={menuItemClass} onSelect={handlePin}>
            <PinIcon className="w-4 h-4 stroke-[1.6]" />
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onDuplicate(id)}
          >
            <CopyIcon className="w-4 h-4 stroke-[1.6]" />
            Duplicate
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={handleCopyFilepath}
          >
            <CopyIcon className="w-4 h-4 stroke-[1.6]" />
            Copy Filepath
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparatorClass} />
          <PrivacyMenuItem
            id={id}
            title={cleanTitle(title)}
            className={menuItemClass}
          />
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ContextMenu.Item
            className={
              menuItemClass +
              " text-red-500 hover:text-red-500 focus:text-red-500"
            }
            onSelect={() => onDelete(id)}
          >
            <TrashIcon className="w-4 h-4 stroke-[1.6]" />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

interface NoteListProps {
  multiSelectedNoteIds: Set<string>;
  setMultiSelectedNoteIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  lastClickedNoteId: string | null;
  setLastClickedNoteId: React.Dispatch<React.SetStateAction<string | null>>;
}

export function NoteList({
  multiSelectedNoteIds,
  setMultiSelectedNoteIds,
  lastClickedNoteId,
  setLastClickedNoteId,
}: NoteListProps) {
  const {
    notes,
    selectedNoteId,
    selectNote,
    deleteNote,
    duplicateNote,
    pinNote,
    unpinNote,
    isLoading,
  } = useNotes();
  const { privateIds } = useVault();

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const deleteWarning = useDeleteNoteWarning(
    deleteDialogOpen ? noteToDelete : null,
  );
  const [settings, setSettings] = useState<Settings | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load settings when notes change
  useEffect(() => {
    notesService
      .getSettings()
      .then(setSettings)
      .catch((error) => {
        console.error("Failed to load settings:", error);
      });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- notes is an intentional refetch trigger: pins and folder settings change alongside note mutations
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

  const refreshSettings = useCallback(() => {
    void notesService.getSettings().then(setSettings);
  }, []);

  // Listen for focus request from editor (when Escape is pressed)
  useEffect(() => {
    const handleFocusNoteList = () => {
      containerRef.current?.focus();
    };

    window.addEventListener("focus-note-list", handleFocusNoteList);
    return () =>
      window.removeEventListener("focus-note-list", handleFocusNoteList);
  }, []);

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

  const foldersEnabled = settings?.foldersEnabled === true;

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

  // Show folder tree view when folders enabled
  if (foldersEnabled) {
    return (
      <>
        <FolderTreeView
          pinnedIds={pinnedIds}
          settings={settings}
          multiSelectedNoteIds={multiSelectedNoteIds}
          setMultiSelectedNoteIds={setMultiSelectedNoteIds}
          lastClickedNoteId={lastClickedNoteId}
          setLastClickedNoteId={setLastClickedNoteId}
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

  return (
    <>
      <div
        ref={containerRef}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard focus target for note navigation (focus-note-list event, arrow keys handled in App)
        tabIndex={0}
        data-note-list
        className="group/notelist flex flex-col gap-1 p-1.5 outline-none"
      >
        {notes.map((item) => (
          <NoteItemWithMenu
            key={item.id}
            id={item.id}
            title={item.title}
            preview={item.preview}
            modified={item.modified}
            isSelected={selectedNoteId === item.id}
            isPinned={pinnedIds.has(item.id)}
            isPrivate={privateIds.has(item.id)}
            onSelect={selectNote}
            onPin={pinNote}
            onUnpin={unpinNote}
            onDuplicate={duplicateNote}
            onDelete={openDeleteDialogForNote}
            onRefreshSettings={refreshSettings}
          />
        ))}
      </div>

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
