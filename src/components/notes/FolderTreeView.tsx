import {
  Fragment,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  memo,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { useNotes } from "../../context/NotesContext";
import {
  buildPageTree,
  useDeleteNoteWarning,
  visiblePageIds,
  type PageNode,
} from "../../lib/folderTree";
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
  TrashIcon,
  NoteIcon,
  PinIcon,
  PlusIcon,
  CopyIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  LockIcon,
  CheckSquareIcon,
} from "../icons";
import { useNoteRowClick, type SetNoteIds } from "./useNoteRowClick";
import { useVault } from "../../context/VaultContext";
import { PrivacyMenuItem } from "../vault/PrivacyMenuItem";
import * as notesService from "../../services/notes";
import type { NoteMetadata } from "../../types/note";

// Holds page ids; the key predates pages replacing folders
const STORAGE_KEY = "aether:collapsedFolders";

const menuItemClass =
  "px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2 rounded-sm";

const menuSeparatorClass = "h-px bg-border my-1";

function loadCollapsedPages(): Set<string> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedPages(pages: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...pages]));
  } catch {
    // Ignore localStorage errors
  }
}

// Compact page row (VS Code / Obsidian style)
interface FileItemProps {
  note: NoteMetadata;
  /** Pinned rows repeat tree rows, so drag and drop ids need their own scope. */
  section: "pinned" | "tree";
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
  onMoveToParent: (id: string, targetFolder: string) => Promise<void>;
  onNewSubPage: (id: string) => void;
  /** Set only for a page with sub-pages: whether they are shown. */
  subPagesExpanded?: boolean;
  onToggleSubPages: (id: string) => void;
}

const FileItem = memo(function FileItem({
  note,
  section,
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
}: FileItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const handleClick = useCallback(
    (e: React.MouseEvent) => onNoteClick(note.id, e),
    [onNoteClick, note.id],
  );

  // The parent page of this page (empty string = top level)
  const parentId = useMemo(() => {
    const lastSlash = note.id.lastIndexOf("/");
    return lastSlash > 0 ? note.id.substring(0, lastSlash) : "";
  }, [note.id]);

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `${section}:${note.id}`,
    data: { type: "note", id: note.id },
  });

  // Dropping onto a page makes the dropped page its sub-page
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${section}:${note.id}`,
    data: { path: note.id },
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
          className={`group/row flex items-center gap-1.5 py-1.5 cursor-pointer rounded-md select-none transition-colors ${
            isDragging
              ? "opacity-40"
              : isOver
                ? "bg-accent/10 ring-1 ring-accent"
                : isSelected
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
          <span className="flex-1 min-w-0 text-sm text-text truncate">
            {cleanTitle(note.title)}
          </span>
          {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- mouse shortcut for the row menu's New sub-page; hidden from the row's accessible name */}
          <span
            data-new-sub-page
            aria-hidden="true"
            title="New sub-page"
            className="hidden group-hover/row:flex shrink-0 rounded-sm hover:bg-bg-emphasis"
            onClick={(e) => {
              e.stopPropagation();
              onNewSubPage(note.id);
            }}
          >
            <PlusIcon className="w-4 h-4 stroke-[1.6] text-text-muted" />
          </span>
          {isPrivate && (
            <span data-private-icon className="shrink-0">
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
          <ContextMenu.Separator className={menuSeparatorClass} />
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() =>
              window.dispatchEvent(
                new CustomEvent("open-move-picker", {
                  detail: { ids: [note.id] },
                }),
              )
            }
          >
            <ArrowRightIcon className="w-4 h-4 stroke-[1.6]" />
            Move to...
          </ContextMenu.Item>
          {parentId && (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => {
                const grandparentId = parentId.includes("/")
                  ? parentId.substring(0, parentId.lastIndexOf("/"))
                  : "";
                void onMoveToParent(note.id, grandparentId).catch((err) =>
                  toast.error(`Failed to move: ${err?.message || err}`),
                );
              }}
            >
              <ArrowUpIcon className="w-4 h-4 stroke-[1.6]" />
              Move to Parent Page
            </ContextMenu.Item>
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

/** What every row of the tree, and of Pinned, needs. */
interface TreeProps {
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  selectedNoteId: string | null;
  pinnedIds: Set<string>;
  privateIds: Set<string>;
  multiSelectedNoteIds: Set<string>;
  onNoteClick: (id: string, event: React.MouseEvent) => void;
  onSelectMultiple: (id: string) => void;
  onNewSubPage: (id: string) => void;
  onPinNote: (id: string) => Promise<void>;
  onUnpinNote: (id: string) => Promise<void>;
  onDuplicateNote: (id: string) => Promise<void>;
  onDeleteNote: (id: string) => void;
  onMoveNoteToParent: (id: string, targetFolder: string) => Promise<void>;
}

interface RowProps extends TreeProps {
  note: NoteMetadata;
  section: FileItemProps["section"];
  depth: number;
  subPagesExpanded?: boolean;
}

function Row({ note, section, depth, subPagesExpanded, ...tree }: RowProps) {
  const selecting = tree.multiSelectedNoteIds.size > 0;
  return (
    <FileItem
      note={note}
      section={section}
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
      onNewSubPage={tree.onNewSubPage}
      subPagesExpanded={subPagesExpanded}
      onToggleSubPages={tree.onToggleCollapse}
    />
  );
}

/** Page rows at `depth`, each followed by its sub-pages while expanded. */
function PageRows({
  nodes,
  depth,
  ...tree
}: TreeProps & { nodes: PageNode[]; depth: number }) {
  return nodes.map(({ note, children }) => {
    const expanded =
      children.length > 0 ? !tree.collapsed.has(note.id) : undefined;
    return (
      <Fragment key={note.id}>
        <Row
          note={note}
          section="tree"
          depth={depth}
          subPagesExpanded={expanded}
          {...tree}
        />
        {expanded && <PageRows nodes={children} depth={depth + 1} {...tree} />}
      </Fragment>
    );
  });
}

/** Dropping a page on the empty space below the tree moves it to the top level. */
function TopLevelDropZone() {
  const { setNodeRef, isOver } = useDroppable({
    id: "drop-top-level",
    data: { path: "" },
  });
  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-h-8 rounded-md ${isOver ? "bg-accent/10 ring-1 ring-accent" : ""}`}
    />
  );
}

interface FolderTreeViewProps {
  pinnedIds: Set<string>;
  multiSelectedNoteIds: Set<string>;
  setMultiSelectedNoteIds: SetNoteIds;
  onSelectMultiple: (id: string) => void;
}

export function FolderTreeView({
  pinnedIds,
  multiSelectedNoteIds,
  setMultiSelectedNoteIds,
  onSelectMultiple,
}: FolderTreeViewProps) {
  const {
    notes,
    selectedNoteId,
    selectNote,
    createNoteInFolder,
    pinNote,
    unpinNote,
    duplicateNote,
    deleteNote,
    moveNote,
  } = useNotes();
  const { privateIds } = useVault();

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedPages);
  const [noteDeleteDialogOpen, setNoteDeleteDialogOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const deleteWarning = useDeleteNoteWarning(
    noteDeleteDialogOpen ? noteToDelete : null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveCollapsedPages(collapsed);
  }, [collapsed]);

  const tree = useMemo(() => buildPageTree(notes), [notes]);

  const pinnedNotes = useMemo(() => {
    const byId = new Map(notes.map((note) => [note.id, note]));
    return [...pinnedIds].flatMap((id) => byId.get(id) ?? []);
  }, [notes, pinnedIds]);

  const handleToggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  // Expand a page and all its ancestors
  const expandPage = useCallback((id: string) => {
    if (!id) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      const parts = id.split("/");
      for (let i = 1; i <= parts.length; i++) {
        next.delete(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, []);

  // From drag-drop in Sidebar, the move picker, and opening a sub-page
  useEffect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const id: unknown = e.detail;
      if (typeof id === "string" && id) expandPage(id);
    };
    window.addEventListener("expand-folder", handler);
    return () => window.removeEventListener("expand-folder", handler);
  }, [expandPage]);

  const handleNewSubPage = useCallback(
    (id: string) => {
      expandPage(id);
      void createNoteInFolder(id);
    },
    [expandPage, createNoteInFolder],
  );

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

  // Visible rows in order, for keyboard navigation and Shift+click ranges
  const visibleIds = useMemo(
    () => visiblePageIds(tree, collapsed),
    [tree, collapsed],
  );

  const handleNoteClick = useNoteRowClick(
    visibleIds,
    multiSelectedNoteIds.size > 0,
    setMultiSelectedNoteIds,
  );

  /** Selects the visible page `delta` rows from the selected one, wrapping. */
  const step = useCallback(
    (delta: 1 | -1) => {
      if (visibleIds.length === 0) return;
      const at = selectedNoteId ? visibleIds.indexOf(selectedNoteId) : -1;
      const next =
        at < 0 && delta < 0
          ? visibleIds.length - 1
          : (at + delta + visibleIds.length) % visibleIds.length;
      void selectNote(visibleIds[next]);
    },
    [visibleIds, selectedNoteId, selectNote],
  );

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

      if (visibleIds.length === 0) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "ArrowDown") step(1);
      else if (e.key === "ArrowUp") step(-1);
      else if (selectedNoteId && visibleIds.includes(selectedNoteId)) {
        const editor = document.querySelector(".ProseMirror");
        if (editor instanceof HTMLElement) editor.focus();
      }
    },
    [visibleIds, selectedNoteId, step],
  );

  useEffect(() => {
    const handleFocus = () => containerRef.current?.focus();
    // App sends arrow keys pressed outside the tree, so they walk its order
    const handleStep = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const delta: unknown = event.detail;
      if (delta !== 1 && delta !== -1) return;
      step(delta);
      containerRef.current?.focus();
    };
    window.addEventListener("focus-note-list", handleFocus);
    window.addEventListener("step-note-list", handleStep);
    return () => {
      window.removeEventListener("focus-note-list", handleFocus);
      window.removeEventListener("step-note-list", handleStep);
    };
  }, [step]);

  const treeProps: TreeProps = {
    collapsed,
    onToggleCollapse: handleToggleCollapse,
    selectedNoteId,
    pinnedIds,
    privateIds,
    multiSelectedNoteIds,
    onNoteClick: handleNoteClick,
    onSelectMultiple,
    onNewSubPage: handleNewSubPage,
    onPinNote: pinNote,
    onUnpinNote: unpinNote,
    onDuplicateNote: duplicateNote,
    onDeleteNote: openDeleteNoteDialog,
    onMoveNoteToParent: moveNote,
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
        className="group/notelist flex flex-col min-h-full p-1.5 outline-none"
        onKeyDown={handleKeyDown}
      >
        {pinnedNotes.length > 0 && (
          <section
            aria-label="Pinned"
            className="flex flex-col gap-0.5 pb-1.5 mb-1.5 border-b border-border"
          >
            <div className="px-2 py-1 text-xs font-medium text-text-muted">
              Pinned
            </div>
            {pinnedNotes.map((note) => (
              <Row
                key={note.id}
                note={note}
                section="pinned"
                depth={0}
                {...treeProps}
              />
            ))}
          </section>
        )}
        <div data-page-tree className="flex flex-col gap-0.5">
          <PageRows nodes={tree} depth={0} {...treeProps} />
        </div>
        <TopLevelDropZone />
      </div>

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
