import { memo, useEffect, useMemo, useRef } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNotes } from "../../context/NotesContext";
import { tabNoteId, useTabs } from "../../context/TabsContext";
import { cleanTitle, cn } from "../../lib/utils";
import { Tooltip } from "../ui";
import { XIcon } from "../icons";

const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

interface SortableTabProps {
  id: string;
  title: string;
  active: boolean;
  closable: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

const SortableTab = memo(function SortableTab({
  id,
  title,
  active,
  closable,
  onActivate,
  onClose,
}: SortableTabProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id });
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={(el) => {
        ref.current = el;
        setNodeRef(el);
      }}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "titlebar-no-drag group relative flex items-center h-7 min-w-25 max-w-50 flex-1 basis-0 rounded-md",
        active
          ? "bg-bg-muted text-text"
          : "text-text-muted hover:bg-bg-muted/60 hover:text-text",
        isDragging && "z-10 opacity-80",
      )}
    >
      <Tooltip content={title}>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={() => onActivate(id)}
          className={cn(
            "flex-1 min-w-0 h-full pl-2.5 text-left text-xs font-medium truncate outline-none",
            closable ? "pr-6" : "pr-2.5",
          )}
        >
          {title}
        </button>
      </Tooltip>
      {closable && (
        <button
          type="button"
          aria-label={`Close ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose(id)}
          className={cn(
            "absolute right-1 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:bg-bg-emphasis hover:text-text group-hover:opacity-100 focus-visible:opacity-100",
            active ? "opacity-100" : "opacity-0",
          )}
        >
          <XIcon className="w-3.5 h-3.5 stroke-[1.8]" />
        </button>
      )}
    </div>
  );
});

/**
 * The open tabs, in the editor header. Tabs shrink to a minimum width, then
 * the strip scrolls. Empty strip space still drags the window.
 */
export function TabStrip() {
  const { tabs, activeTabId, activateTab, closeTab, moveTab } = useTabs();
  const { notes, currentNote } = useNotes();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const titles = useMemo(() => {
    const byId = new Map(notes.map((n) => [n.id, n.title]));
    // A just-created or just-renamed note may not be in the list yet
    if (currentNote) byId.set(currentNote.id, currentNote.title);
    return new Map(
      tabs.map((t) => {
        const noteId = tabNoteId(t);
        const title = byId.get(noteId) ?? noteId.split("/").pop() ?? noteId;
        return [t.id, cleanTitle(title)];
      }),
    );
  }, [tabs, notes, currentNote]);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const to = tabs.findIndex((t) => t.id === over.id);
    if (to >= 0) moveTab(String(active.id), to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[horizontalOnly]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={tabs.map((t) => t.id)}
        strategy={horizontalListSortingStrategy}
      >
        <div
          role="tablist"
          aria-label="Open notes"
          data-tauri-drag-region
          className="flex-1 min-w-0 h-full flex items-center gap-0.5 overflow-x-auto scrollbar-none"
        >
          {tabs.map((t) => (
            <SortableTab
              key={t.id}
              id={t.id}
              title={titles.get(t.id) ?? ""}
              active={t.id === activeTabId}
              closable={tabs.length > 1}
              onActivate={activateTab}
              onClose={closeTab}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
