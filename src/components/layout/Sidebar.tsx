import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useNotes } from "../../context/NotesContext";
import { useVault } from "../../context/VaultContext";
import { NoteList } from "../notes/NoteList";
import { Footer } from "./Footer";
import { SelectionBar } from "./SelectionBar";
import { outermostIds } from "../../lib/folderTree";
import { Button, IconButton } from "../ui";
import { PlusIcon, NoteIcon, LockIcon } from "../icons";
import { mod, isMac, isWindows } from "../../lib/platform";

interface SidebarProps {
  onOpenSettings?: () => void;
}

export function Sidebar({ onOpenSettings }: SidebarProps) {
  const { createNote, notes, moveNote } = useNotes();
  const { status: vault, enterKey } = useVault();
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [dragCount, setDragCount] = useState(1);
  const [multiSelectedNoteIds, setMultiSelectedNoteIds] = useState<Set<string>>(
    new Set(),
  );
  const multiSelectedRef = useRef<Set<string>>(multiSelectedNoteIds);
  useLayoutEffect(() => {
    multiSelectedRef.current = multiSelectedNoteIds;
  }, [multiSelectedNoteIds]);
  // Selection mode lasts while anything is selected
  const selecting = multiSelectedNoteIds.size > 0;
  const exitSelection = useCallback(
    () => setMultiSelectedNoteIds(new Set()),
    [],
  );

  // dnd-kit
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === "note" && typeof data.id === "string") {
      const noteId = data.id;
      const leaf = noteId.includes("/")
        ? noteId.substring(noteId.lastIndexOf("/") + 1)
        : noteId;
      setDragLabel(leaf);

      // A note in the selection drags the whole selection
      const selected = multiSelectedRef.current;
      setDragCount(selected.has(noteId) ? selected.size : 1);
    }
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragLabel(null);
      setDragCount(1);
      const { active, over } = event;
      if (!over) return;

      const activeData = active.data.current;
      const overData = over.data.current;
      if (activeData?.type !== "note" || typeof activeData.id !== "string") {
        return;
      }
      if (typeof overData?.path !== "string") return;
      // A page id, or "" for the top level
      const targetFolder = overData.path;
      // A page dropped onto itself, or onto one of its own sub-pages
      const isInside = (id: string) =>
        targetFolder === id || targetFolder.startsWith(`${id}/`);

      try {
        const noteId = activeData.id;
        const selected = multiSelectedRef.current;

        if (selected.has(noteId)) {
          // A page moves its sub-pages along, so only the outermost move
          const noteIds = outermostIds(selected).filter((id) => {
            const parent = id.includes("/")
              ? id.substring(0, id.lastIndexOf("/"))
              : "";
            return parent !== targetFolder && !isInside(id);
          });
          if (noteIds.length === 0) return;
          let failures = 0;
          for (const id of noteIds) {
            try {
              await moveNote(id, targetFolder);
            } catch {
              failures++;
            }
          }
          if (failures > 0) {
            toast.error(`Failed to move ${failures} note(s)`);
          }
          exitSelection();
        } else {
          const noteParent = noteId.includes("/")
            ? noteId.substring(0, noteId.lastIndexOf("/"))
            : "";
          if (noteParent === targetFolder || isInside(noteId)) return;
          await moveNote(noteId, targetFolder);
        }

        // Expand the target page so the moved page is visible
        if (targetFolder) {
          window.dispatchEvent(
            new CustomEvent("expand-folder", { detail: targetFolder }),
          );
        }
      } catch (error) {
        console.error("Failed to move item:", error);
        toast.error("Failed to move item");
      }
    },
    [moveNote, exitSelection],
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragLabel(null)}
    >
      <div className="relative w-full h-full bg-bg-secondary border-r border-border flex flex-col select-none">
        {/* Drag region */}
        {!isWindows && (
          <div className="h-11 shrink-0" data-tauri-drag-region></div>
        )}
        <div
          className={`flex items-center justify-between pl-4 pr-3 pb-2 border-b border-border shrink-0${isWindows ? " pt-2" : ""}`}
        >
          <div className="flex items-center gap-1">
            <div className="font-medium text-base">Notes</div>
            <div className="text-text-muted font-medium text-2xs min-w-4.75 h-4.75 flex items-center justify-center px-1 bg-bg-muted rounded-sm mt-0.5 pt-px">
              {notes.length}
            </div>
          </div>
          <div className="flex items-center gap-px">
            <IconButton
              variant="ghost"
              onClick={() => createNote()}
              title={`New Note (${mod}${isMac ? "" : "+"}N)`}
            >
              <PlusIcon className="w-5.25 h-5.25 stroke-[1.4]" />
            </IconButton>
          </div>
        </div>
        {vault?.hasVault && !vault.unlocked && vault.lockedCount > 0 && (
          <output className="flex items-center gap-2 mx-1.5 mt-1.5 pl-2.5 pr-1.5 py-1.5 rounded-md bg-bg-muted text-sm text-text shrink-0">
            <LockIcon className="w-3.5 h-3.5 stroke-[1.8] text-text-muted shrink-0" />
            <span className="flex-1 truncate">Private pages locked</span>
            <Button size="xs" variant="outline" onClick={enterKey}>
              Enter key
            </Button>
          </output>
        )}
        {/* Scrollable notes area */}
        <div className="flex-1 overflow-y-auto">
          {/* Note list */}
          <NoteList
            multiSelectedNoteIds={multiSelectedNoteIds}
            setMultiSelectedNoteIds={setMultiSelectedNoteIds}
          />
        </div>

        {selecting && (
          <SelectionBar ids={multiSelectedNoteIds} onExit={exitSelection} />
        )}

        {/* Footer with git status, commit, and settings */}
        <Footer onOpenSettings={onOpenSettings} />
      </div>

      {/* Drag overlay: floating label while dragging */}
      <DragOverlay>
        {dragLabel && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-bg border border-border rounded-md shadow-lg text-sm text-text">
            <NoteIcon className="w-3.5 h-3.5 stroke-[1.6] opacity-50 shrink-0" />
            {dragLabel}
            {dragCount > 1 && (
              <span className="ml-1 px-1.5 py-0.5 bg-accent text-text-inverse text-xs rounded-full leading-none">
                +{dragCount - 1}
              </span>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
