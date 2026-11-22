import { useCallback, useMemo, useState, useEffect, useRef, memo } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { useNotes } from "../../context/NotesContext";
import {
  buildFolderTree,
  countNotesInFolder,
  useDeleteNoteWarning,
  getVisibleItems,
  type TreeItem,
} from "../../lib/folderTree";
import { FolderNameDialog } from "./FolderNameDialog";
import { cleanTitle } from "../../lib/utils";
import { toast } from "sonner";
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
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  AddNoteIcon,
  FolderPlusIcon,
  PencilIcon,
  TrashIcon,
  NoteIcon,
  PinIcon,
  CopyIcon,
  ArrowUpIcon,
  DownloadIcon,
  LockIcon,
  CheckSquareIcon,
} from "../icons";
import { useNoteRowClick, type SetNoteIds } from "./useNoteRowClick";
import { useVault } from "../../context/VaultContext";
import { PrivacyMenuItem } from "../vault/PrivacyMenuItem";
import { ExportZipDialog } from "../vault/ExportZipDialog";
import * as notesService from "../../services/notes";
import { exportFolderZip } from "../../services/export";
import type { FolderNode, NoteMetadata, Settings } from "../../types/note";

const STORAGE_KEY = "aether:collapsedFolders";

const menuItemClass =
  "px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2 rounded-sm";

const menuSeparatorClass = "h-px bg-border my-1";

function loadCollapsedFolders(): Set<string> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch {
    return new Set();
  }
}

function itemKey(item: TreeItem) {
  return item.type === "note" ? `note:${item.id}` : `folder:${item.path}`;
}

function saveCollapsedFolders(folders: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...folders]));
  } catch {
    // Ignore localStorage errors
  }
}

// Compact file item for folder tree (VS Code / Obsidian style)
interface FileItemProps {
  note: NoteMetadata;
  depth: number;
  isSelected: boolean;
  /** Set only in selection mode: whether the row is selected. */
  isMultiSelected?: boolean;
  isPinned: boolean;
  isPrivate: boolean;
  onNoteClick: (id: string, event: React.MouseEvent) => void;
  onSelectMultiple: (id: string) => void;
  onPin: (id: string) => Promise<void>;
  onUnpin: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  onMoveToParent?: (id: string, targetFolder: string) => void;
  onNewSubPage: (id: string) => void;
  /** Set only for a page with sub-pages: whether they are shown. */
  subPagesExpanded?: boolean;
  onToggleSubPages: (id: string) => void;
  focusedItemKey?: string | null;
}

const FileItem = memo(function FileItem({
  note,
  depth,
  isSelected,
  isMultiSelected,
  isPinned,
  isPrivate,
  onNoteClick,
  onSelectMultiple,
  onPin,
  onUnpin,
  onDuplicate,
  onDelete,
  onMoveToParent,
  onNewSubPage,
  subPagesExpanded,
  onToggleSubPages,
  focusedItemKey,
}: FileItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const handleClick = useCallback(
    (e: React.MouseEvent) => onNoteClick(note.id, e),
    [onNoteClick, note.id],
  );

  // The parent folder for this note (empty string = root)
  const noteParentFolder = useMemo(() => {
    const lastSlash = note.id.lastIndexOf("/");
    return lastSlash > 0 ? note.id.substring(0, lastSlash) : "";
  }, [note.id]);

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `note:${note.id}`,
    data: { type: "note", id: note.id },
  });

  // Dropping onto a note makes the dropped item its sub-page
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-note:${note.id}`,
    data: { type: "folder", path: note.id },
  });

  useEffect(() => {
    if (isSelected) {
      itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isSelected]);

  const handlePin = useCallback(async () => {
    try {
      await (isPinned ? onUnpin(note.id) : onPin(note.id));
    } catch (error) {
      console.error("Failed to pin/unpin note:", error);
    }
  }, [note.id, isPinned, onPin, onUnpin]);

  const handleCopyFilepath = useCallback(async () => {
    try {
      const folder = await notesService.getNotesFolder();
      if (folder) {
        await invoke("copy_to_clipboard", { text: `${folder}/${note.id}.md` });
      }
    } catch (error) {
      console.error("Failed to copy filepath:", error);
    }
  }, [note.id]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- tabIndex -1 row; keyboard navigation is handled by the tree container, so per-row Enter/Space would double-handle */}
        <div
          ref={(el) => {
            setDragRef(el);
            setDropRef(el);
            itemRef.current = el;
          }}
          {...attributes}
          {...listeners}
          className={`flex items-center gap-1.5 py-1.5 cursor-pointer rounded-md select-none transition-colors ${
            isDragging
              ? "opacity-40"
              : isOver
                ? "bg-accent/10 ring-1 ring-accent"
                : isSelected &&
                    (!focusedItemKey || focusedItemKey === `note:${note.id}`)
                  ? "bg-bg-muted group-focus/notelist:ring-1 group-focus/notelist:ring-text-muted"
                  : isMultiSelected
                    ? "bg-bg-muted"
                    : "hover:bg-bg-muted"
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px`, paddingRight: "8px" }}
          onClick={handleClick}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native button changes click focus (WebKit focuses the tree container instead, showing its focus ring) and makes Space activate the row
          role="button"
          aria-pressed={isMultiSelected}
          aria-expanded={subPagesExpanded}
          tabIndex={-1}
        >
          {subPagesExpanded !== undefined && (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- mouse shortcut inside the row; the row itself carries aria-expanded
            <span
              data-sub-pages-toggle
              aria-hidden="true"
              className="shrink-0 rounded-sm hover:bg-bg-emphasis"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSubPages(note.id);
              }}
            >
              {subPagesExpanded ? (
                <ChevronDownIcon className="w-4 h-4 stroke-[1.6] text-text-muted/60" />
              ) : (
                <ChevronRightIcon className="w-4 h-4 stroke-[1.6] text-text-muted/60" />
              )}
            </span>
          )}
          {isPinned ? (
            <PinIcon className="w-4 h-4 stroke-[1.6] fill-current text-text-muted shrink-0" />
          ) : (
            subPagesExpanded === undefined && (
              <NoteIcon className="w-4 h-4 stroke-[1.6] opacity-50 shrink-0" />
            )
          )}
          <span className="text-sm text-text truncate">
            {cleanTitle(note.title)}
          </span>
          {isPrivate && (
            <span data-private-icon className="ml-auto shrink-0">
              <LockIcon className="w-3.5 h-3.5 stroke-[1.8] text-text-muted" />
            </span>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-44 bg-bg border border-border rounded-md shadow-lg py-1 z-50">
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onNewSubPage(note.id)}
          >
            <AddNoteIcon className="w-4 h-4 stroke-[1.6]" />
            New sub-page
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ContextMenu.Item className={menuItemClass} onSelect={handlePin}>
            <PinIcon className="w-4 h-4 stroke-[1.6]" />
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() =>
              void onDuplicate(note.id).catch((err) =>
                toast.error(`Failed to duplicate: ${err?.message || err}`),
              )
            }
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
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onSelectMultiple(note.id)}
          >
            <CheckSquareIcon className="w-4 h-4 stroke-[1.6]" />
            Select Multiple
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparatorClass} />
          <PrivacyMenuItem
            id={note.id}
            title={cleanTitle(note.title)}
            className={menuItemClass}
          />
          {noteParentFolder && onMoveToParent && (
            <>
              <ContextMenu.Separator className={menuSeparatorClass} />
              <ContextMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  const parentOfParent = noteParentFolder.includes("/")
                    ? noteParentFolder.substring(
                        0,
                        noteParentFolder.lastIndexOf("/"),
                      )
                    : "";
                  void Promise.resolve(
                    onMoveToParent(note.id, parentOfParent),
                  ).catch((err) =>
                    toast.error(`Failed to move: ${err?.message || err}`),
                  );
                }}
              >
                <ArrowUpIcon className="w-4 h-4 stroke-[1.6]" />
                Move to Parent Folder
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ContextMenu.Item
            className={
              menuItemClass +
              " text-red-500 hover:text-red-500 focus:text-red-500"
            }
            onSelect={() => onDelete(note.id)}
          >
            <TrashIcon className="w-4 h-4 stroke-[1.6]" />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

/** What every level of the tree passes down to the next. */
interface TreeProps {
  subPages: Map<string, FolderNode>;
  collapsedFolders: Set<string>;
  onToggleCollapse: (path: string) => void;
  selectedNoteId: string | null;
  pinnedIds: Set<string>;
  privateIds: Set<string>;
  multiSelectedNoteIds: Set<string>;
  onNoteClick: (id: string, event: React.MouseEvent) => void;
  onSelectMultiple: (id: string) => void;
  focusedItemKey: string | null;
  onCreateNoteHere: (path: string) => void;
  onNewSubfolder: (parentPath: string) => void;
  onRenameFolder: (path: string, currentName: string) => void;
  onExportFolder: (folder: FolderNode) => void;
  onDeleteFolder: (path: string) => void;
  onPinNote: (id: string) => Promise<void>;
  onUnpinNote: (id: string) => Promise<void>;
  onDuplicateNote: (id: string) => Promise<void>;
  onDeleteNote: (id: string) => void;
  onMoveNoteToParent: (id: string, targetFolder: string) => void;
  onMoveFolderToParent: (path: string, targetParent: string) => void;
}

interface FolderItemProps extends TreeProps {
  folder: FolderNode;
  depth: number;
}

/** A folder's subfolders and notes, at `depth`. */
function FolderContents({ folder, depth, ...tree }: FolderItemProps) {
  return (
    <div className="flex flex-col gap-0.5">
      {folder.children.map((child) => (
        <FolderItemComponent
          key={child.path}
          folder={child}
          depth={depth}
          {...tree}
        />
      ))}
      {folder.notes.map((note) => (
        <NoteItem key={note.id} note={note} depth={depth} {...tree} />
      ))}
    </div>
  );
}

/** A note row, followed by its sub-pages when it is an expanded page. */
function NoteItem({
  note,
  depth,
  ...tree
}: TreeProps & { note: NoteMetadata; depth: number }) {
  const subPages = tree.subPages.get(note.id);
  const selecting = tree.multiSelectedNoteIds.size > 0;
  const expanded = subPages ? !tree.collapsedFolders.has(note.id) : undefined;
  return (
    <>
      <FileItem
        note={note}
        depth={depth}
        isSelected={!selecting && tree.selectedNoteId === note.id}
        isMultiSelected={
          selecting ? tree.multiSelectedNoteIds.has(note.id) : undefined
        }
        isPinned={tree.pinnedIds.has(note.id)}
        isPrivate={tree.privateIds.has(note.id)}
        onNoteClick={tree.onNoteClick}
        onSelectMultiple={tree.onSelectMultiple}
        onPin={tree.onPinNote}
        onUnpin={tree.onUnpinNote}
        onDuplicate={tree.onDuplicateNote}
        onDelete={tree.onDeleteNote}
        onMoveToParent={tree.onMoveNoteToParent}
        onNewSubPage={tree.onCreateNoteHere}
        subPagesExpanded={expanded}
        onToggleSubPages={tree.onToggleCollapse}
        focusedItemKey={tree.focusedItemKey}
      />
      {subPages && expanded && (
        <FolderContents folder={subPages} depth={depth + 1} {...tree} />
      )}
    </>
  );
}

const FolderItemComponent = memo(function FolderItem({
  folder,
  depth,
  ...tree
}: FolderItemProps) {
  const {
    collapsedFolders,
    onToggleCollapse,
    focusedItemKey,
    onCreateNoteHere,
    onNewSubfolder,
    onRenameFolder,
    onExportFolder,
    onDeleteFolder,
    onMoveFolderToParent,
  } = tree;
  const isCollapsed = collapsedFolders.has(folder.path);
  const noteCount = countNotesInFolder(folder);
  const isEmpty = noteCount === 0 && folder.children.length === 0;
  const isFocused = focusedItemKey === `folder:${folder.path}`;

  const handleClick = useCallback(() => {
    onToggleCollapse(folder.path);
  }, [onToggleCollapse, folder.path]);

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `folder:${folder.path}`,
    data: { type: "folder", path: folder.path },
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-folder:${folder.path}`,
    data: { type: "folder", path: folder.path },
  });

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={setDragRef}
          {...attributes}
          {...listeners}
          className={isDragging ? "opacity-40" : ""}
        >
          {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- tabIndex -1 row; keyboard navigation is handled by the tree container, so per-row Enter/Space would double-handle */}
          <div
            ref={setDropRef}
            className={`flex items-center gap-1.5 py-1.5 cursor-pointer rounded-md select-none transition-colors ${
              isOver
                ? "bg-accent/10 ring-1 ring-accent"
                : isFocused
                  ? "bg-bg-muted/50 ring-1 ring-text-muted/30"
                  : "hover:bg-bg-muted"
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px`, paddingRight: "8px" }}
            onClick={handleClick}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native button changes click focus (WebKit focuses the tree container instead, showing its focus ring) and makes Space activate the row
            role="button"
            tabIndex={-1}
          >
            {isCollapsed ? (
              <ChevronRightIcon className="w-4 h-4 stroke-[1.6] text-text-muted/60 shrink-0" />
            ) : (
              <ChevronDownIcon className="w-4 h-4 stroke-[1.6] text-text-muted/60 shrink-0" />
            )}
            <span className="text-sm text-text-muted truncate">
              {folder.name}
            </span>
          </div>

          {!isCollapsed && (
            <>
              <FolderContents folder={folder} depth={depth + 1} {...tree} />
              {isEmpty && (
                <div
                  className="text-sm text-text-muted/50 py-1 select-none"
                  style={{ paddingLeft: `${(depth + 1) * 12 + 24}px` }}
                >
                  Empty
                </div>
              )}
            </>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-44 bg-bg border border-border rounded-md shadow-lg py-1 z-50">
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onCreateNoteHere(folder.path)}
          >
            <AddNoteIcon className="w-4 h-4 stroke-[1.6]" />
            New Note
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onNewSubfolder(folder.path)}
          >
            <FolderPlusIcon className="w-4 h-4 stroke-[1.6]" />
            New Subfolder
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              const parts = folder.path.split("/");
              onRenameFolder(folder.path, parts[parts.length - 1]);
            }}
          >
            <PencilIcon className="w-4 h-4 stroke-[1.6]" />
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onExportFolder(folder)}
          >
            <DownloadIcon className="w-4 h-4 stroke-[1.6]" />
            Export as Zip
          </ContextMenu.Item>
          {folder.path.includes("/") && (
            <>
              <ContextMenu.Separator className={menuSeparatorClass} />
              <ContextMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  const parentOfParent = folder.path.includes("/")
                    ? folder.path.substring(0, folder.path.lastIndexOf("/"))
                    : "";
                  const grandparent = parentOfParent.includes("/")
                    ? parentOfParent.substring(
                        0,
                        parentOfParent.lastIndexOf("/"),
                      )
                    : "";
                  void Promise.resolve(
                    onMoveFolderToParent(folder.path, grandparent),
                  ).catch((err) =>
                    toast.error(`Failed to move: ${err?.message || err}`),
                  );
                }}
              >
                <ArrowUpIcon className="w-4 h-4 stroke-[1.6]" />
                Move to Parent Folder
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ContextMenu.Item
            className={
              menuItemClass +
              " text-red-500 hover:text-red-500 focus:text-red-500"
            }
            onSelect={() => onDeleteFolder(folder.path)}
          >
            <TrashIcon className="w-4 h-4 stroke-[1.6]" />
            Delete Folder
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

interface FolderTreeViewProps {
  pinnedIds: Set<string>;
  settings: Settings | null;
  multiSelectedNoteIds: Set<string>;
  setMultiSelectedNoteIds: SetNoteIds;
  onSelectMultiple: (id: string) => void;
}

export function FolderTreeView({
  pinnedIds,
  settings: _settings,
  multiSelectedNoteIds,
  setMultiSelectedNoteIds,
  onSelectMultiple,
}: FolderTreeViewProps) {
  const {
    notes,
    selectedNoteId,
    selectNote,
    createNoteInFolder,
    createFolder,
    deleteFolder,
    renameFolder,
    pinNote,
    unpinNote,
    duplicateNote,
    deleteNote,
    moveNote,
    moveFolder,
  } = useNotes();
  const { privateIds } = useVault();

  const [collapsedFolders, setCollapsedFolders] =
    useState<Set<string>>(loadCollapsedFolders);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<string | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [folderToRename, setFolderToRename] = useState<string | null>(null);
  const [renameDefaultValue, setRenameDefaultValue] = useState("");
  const [folderToExport, setFolderToExport] = useState<FolderNode | null>(null);
  const [subfolderDialogOpen, setSubfolderDialogOpen] = useState(false);
  const [subfolderParent, setSubfolderParent] = useState("");
  const [noteDeleteDialogOpen, setNoteDeleteDialogOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const deleteWarning = useDeleteNoteWarning(
    noteDeleteDialogOpen ? noteToDelete : null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [knownFolders, setKnownFolders] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load known folders from disk (includes empty folders)
  useEffect(() => {
    notesService
      .listFolders()
      .then(setKnownFolders)
      .catch(() => setKnownFolders([]));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- notes is an intentional refetch trigger: folder create/rename/delete also changes notes
  }, [notes]);

  // Persist collapsed state
  useEffect(() => {
    saveCollapsedFolders(collapsedFolders);
  }, [collapsedFolders]);

  const tree = useMemo(
    () => buildFolderTree(notes, pinnedIds, knownFolders),
    [notes, pinnedIds, knownFolders],
  );

  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Expand a folder and all its ancestors
  const expandFolder = useCallback((folderPath: string) => {
    if (!folderPath) return;
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      // Expand this folder and every ancestor
      const parts = folderPath.split("/");
      for (let i = 1; i <= parts.length; i++) {
        next.delete(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, []);

  // Listen for expand-folder events (from drag-drop in Sidebar, or search navigation)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const path: unknown = e.detail;
      if (typeof path === "string" && path) expandFolder(path);
    };
    window.addEventListener("expand-folder", handler);
    return () => window.removeEventListener("expand-folder", handler);
  }, [expandFolder]);

  const handleNewSubfolder = useCallback((parentPath: string) => {
    setSubfolderParent(parentPath);
    setSubfolderDialogOpen(true);
  }, []);

  const handleRenameFolder = useCallback(
    (path: string, currentName: string) => {
      setFolderToRename(path);
      setRenameDefaultValue(currentName);
      setRenameDialogOpen(true);
    },
    [],
  );

  // Only a folder with private pages has anything to ask about.
  const handleExportFolder = useCallback(
    (folder: FolderNode) => {
      const prefix = `${folder.path}/`;
      if ([...privateIds].some((id) => id.startsWith(prefix))) {
        setFolderToExport(folder);
      } else {
        void exportFolderZip(folder.path, folder.name, false);
      }
    },
    [privateIds],
  );

  const handleDeleteFolder = useCallback((path: string) => {
    setFolderToDelete(path);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (folderToDelete && !isDeleting) {
      setIsDeleting(true);
      try {
        await deleteFolder(folderToDelete);
        setFolderToDelete(null);
        setDeleteDialogOpen(false);
      } catch (error) {
        console.error("Failed to delete folder:", error);
        toast.error("Failed to delete folder");
      } finally {
        setIsDeleting(false);
      }
    }
  }, [folderToDelete, deleteFolder, isDeleting]);

  const openDeleteNoteDialog = useCallback((noteId: string) => {
    setNoteToDelete(noteId);
    setNoteDeleteDialogOpen(true);
  }, []);

  const handleNoteDeleteConfirm = useCallback(async () => {
    if (noteToDelete && !isDeleting) {
      setIsDeleting(true);
      try {
        await deleteNote(noteToDelete);
        setNoteToDelete(null);
        setNoteDeleteDialogOpen(false);
      } catch (error) {
        console.error("Failed to delete note:", error);
        toast.error("Failed to delete note");
      } finally {
        setIsDeleting(false);
      }
    }
  }, [noteToDelete, deleteNote, isDeleting]);

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (folderToRename) {
        try {
          await renameFolder(folderToRename, newName);
          setFolderToRename(null);
          setRenameDialogOpen(false);
        } catch (error) {
          console.error("Failed to rename folder:", error);
          toast.error("Failed to rename folder");
        }
      }
    },
    [folderToRename, renameFolder],
  );

  const handleSubfolderConfirm = useCallback(
    async (name: string) => {
      try {
        await createFolder(subfolderParent, name);
        expandFolder(subfolderParent);
        setSubfolderDialogOpen(false);
      } catch (error) {
        console.error("Failed to create subfolder:", error);
        toast.error("Failed to create subfolder");
      }
    },
    [subfolderParent, createFolder, expandFolder],
  );

  // Flat list of visible items for keyboard navigation
  const visibleItems = useMemo(
    () => getVisibleItems(tree, pinnedIds, collapsedFolders),
    [tree, pinnedIds, collapsedFolders],
  );

  // Visible note IDs in order, for Shift+click ranges
  const visibleNoteIds = useMemo(
    () =>
      visibleItems
        .filter(
          (item): item is { type: "note"; id: string } => item.type === "note",
        )
        .map((item) => item.id),
    [visibleItems],
  );

  const handleNoteClick = useNoteRowClick(
    visibleNoteIds,
    multiSelectedNoteIds.size > 0,
    setMultiSelectedNoteIds,
  );

  // Track which item is focused for keyboard nav (separate from note selection)
  const [focusedItemKey, setFocusedItemKey] = useState<string | null>(
    selectedNoteId ? `note:${selectedNoteId}` : null,
  );

  // Sync focused item when note selection changes
  const [prevSelectedNoteId, setPrevSelectedNoteId] = useState(selectedNoteId);
  if (selectedNoteId !== prevSelectedNoteId) {
    setPrevSelectedNoteId(selectedNoteId);
    if (selectedNoteId) {
      setFocusedItemKey(`note:${selectedNoteId}`);
    }
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key !== "ArrowDown" &&
        e.key !== "ArrowUp" &&
        e.key !== "Enter" &&
        e.key !== "Escape"
      ) {
        return;
      }
      // Leave modified arrows to App, which binds Cmd+Alt+Up to the parent page
      if (e.key.startsWith("Arrow") && (e.metaKey || e.ctrlKey || e.altKey)) {
        return;
      }

      if (e.key === "Escape") {
        containerRef.current?.blur();
        return;
      }

      if (visibleItems.length === 0) return;
      e.preventDefault();
      e.stopPropagation();

      const currentIndex = visibleItems.findIndex(
        (item) => itemKey(item) === focusedItemKey,
      );

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        let newIndex: number;
        if (e.key === "ArrowDown") {
          newIndex =
            currentIndex < visibleItems.length - 1 ? currentIndex + 1 : 0;
        } else {
          newIndex =
            currentIndex > 0 ? currentIndex - 1 : visibleItems.length - 1;
        }
        const item = visibleItems[newIndex];
        setFocusedItemKey(itemKey(item));
        if (item.type === "note") {
          void selectNote(item.id);
        }
      } else if (e.key === "Enter") {
        if (currentIndex < 0) return;
        const item = visibleItems[currentIndex];
        if (item.type === "folder") {
          handleToggleCollapse(item.path);
        } else {
          // Focus the editor
          const editor = document.querySelector(".ProseMirror");
          if (editor instanceof HTMLElement) editor.focus();
        }
      }
    },
    [visibleItems, focusedItemKey, selectNote, handleToggleCollapse],
  );

  // Listen for focus requests
  useEffect(() => {
    const handleFocus = () => {
      containerRef.current?.focus();
      // If nothing focused yet, focus the selected note or first item
      if (!focusedItemKey && visibleItems.length > 0) {
        const selected = visibleItems.find(
          (item) => item.type === "note" && item.id === selectedNoteId,
        );
        setFocusedItemKey(
          selected ? itemKey(selected) : itemKey(visibleItems[0]),
        );
      }
    };
    window.addEventListener("focus-note-list", handleFocus);
    return () => window.removeEventListener("focus-note-list", handleFocus);
  }, [focusedItemKey, visibleItems, selectedNoteId]);

  // Separate pinned and unpinned root notes
  const pinnedRootNotes = useMemo(
    () => tree.rootNotes.filter((n) => pinnedIds.has(n.id)),
    [tree.rootNotes, pinnedIds],
  );
  const unpinnedRootNotes = useMemo(
    () => tree.rootNotes.filter((n) => !pinnedIds.has(n.id)),
    [tree.rootNotes, pinnedIds],
  );

  const treeProps: TreeProps = {
    subPages: tree.subPages,
    collapsedFolders,
    onToggleCollapse: handleToggleCollapse,
    selectedNoteId,
    focusedItemKey,
    pinnedIds,
    privateIds,
    multiSelectedNoteIds,
    onNoteClick: handleNoteClick,
    onSelectMultiple,
    onCreateNoteHere: createNoteInFolder,
    onNewSubfolder: handleNewSubfolder,
    onRenameFolder: handleRenameFolder,
    onExportFolder: handleExportFolder,
    onDeleteFolder: handleDeleteFolder,
    onPinNote: pinNote,
    onUnpinNote: unpinNote,
    onDuplicateNote: duplicateNote,
    onDeleteNote: openDeleteNoteDialog,
    onMoveNoteToParent: moveNote,
    onMoveFolderToParent: moveFolder,
  };

  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- focusable container that owns arrow/Enter/Escape navigation for the tree rows */}
      <div
        ref={containerRef}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard focus target for tree navigation (focus-note-list event)
        tabIndex={0}
        data-note-list
        data-folder-tree
        className="group/notelist flex flex-col gap-0.5 p-1.5 outline-none"
        onKeyDown={handleKeyDown}
      >
        {/* Pinned root notes */}
        {pinnedRootNotes.map((note) => (
          <NoteItem key={note.id} note={note} depth={0} {...treeProps} />
        ))}

        {/* Folders */}
        {tree.folders.map((folder) => (
          <FolderItemComponent
            key={folder.path}
            folder={folder}
            depth={0}
            {...treeProps}
          />
        ))}

        {/* Unpinned root notes */}
        {unpinnedRootNotes.map((note) => (
          <NoteItem key={note.id} note={note} depth={0} {...treeProps} />
        ))}
      </div>

      {/* Delete folder confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the folder and all notes inside it.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename folder dialog */}
      <FolderNameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        onConfirm={handleRenameConfirm}
        title="Rename Folder"
        description="Enter a new name for the folder"
        confirmLabel="Rename"
        defaultValue={renameDefaultValue}
      />

      {folderToExport && (
        <ExportZipDialog
          title={`Export ${folderToExport.name}`}
          description="Every note and asset in this folder, in one zip."
          onExport={(includePrivate) =>
            void exportFolderZip(
              folderToExport.path,
              folderToExport.name,
              includePrivate,
            )
          }
          onClose={() => setFolderToExport(null)}
        />
      )}

      {/* New subfolder dialog */}
      <FolderNameDialog
        open={subfolderDialogOpen}
        onOpenChange={setSubfolderDialogOpen}
        onConfirm={handleSubfolderConfirm}
        title="Create new subfolder"
        description="Enter a name for your new subfolder"
        confirmLabel="Create"
      />

      {/* Delete note confirmation dialog */}
      <AlertDialog
        open={noteDeleteDialogOpen}
        onOpenChange={setNoteDeleteDialogOpen}
      >
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
              disabled={isDeleting || !deleteWarning.ready}
              onClick={(e) => {
                e.preventDefault();
                void handleNoteDeleteConfirm();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
