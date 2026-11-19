import {
  memo,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  GripVerticalIcon,
  PlusIcon,
  TrashIcon,
} from "../icons";
import { cn } from "../../lib/utils";
import { mod, shortcut } from "../../lib/platform";
import {
  blockAtY,
  canMoveBlock,
  canTurnInto,
  currentBlockType,
  deleteBlock,
  duplicateBlock,
  insertSlashBlockBelow,
  isListItem,
  MENU_ITEM_CLASS,
  moveBlock,
  siblingTarget,
  stateWithBlockSelected,
  turnInto,
  TurnIntoItems,
  type DomBlock,
} from "./blocks";

interface Hovered extends DomBlock {
  /** Handle position in the container: middle of the first line, block's left edge. */
  top: number;
  left: number;
}

interface DropLine {
  target: number;
  top: number;
  left: number;
  width: number;
}

interface Drag {
  startY: number;
  moved: boolean;
  drop: DropLine | null;
}

// Pointer travel before a press on the grip counts as a drag, not a click
const DRAG_THRESHOLD = 4;

function hoveredAt(
  editor: TiptapEditor,
  container: HTMLElement,
  y: number,
): Hovered | null {
  const block = blockAtY(editor.view, y);
  if (!block) return null;
  const box = container.getBoundingClientRect();
  const rect = block.dom.getBoundingClientRect();
  // List items sit right of their bullets: line the handle up with the list
  const edge = isListItem(editor.state.doc, block)
    ? (block.dom.parentElement ?? block.dom)
    : block.dom;
  const lineHeight = parseFloat(getComputedStyle(block.dom).lineHeight);
  const firstLine = Math.min(
    rect.height,
    Number.isNaN(lineHeight) ? 24 : lineHeight,
  );
  return {
    ...block,
    top: rect.top - box.top + firstLine / 2,
    left: edge.getBoundingClientRect().left - box.left,
  };
}

function dropLineAt(
  editor: TiptapEditor,
  container: HTMLElement,
  source: DomBlock,
  y: number,
): DropLine | null {
  const { doc } = editor.state;
  // Top-level blocks move between top-level blocks; list items also into other lists
  const over = blockAtY(editor.view, y, !isListItem(doc, source));
  if (!over) return null;
  const rect = over.dom.getBoundingClientRect();
  const before = y < rect.top + rect.height / 2;
  const target = before ? over.pos : over.pos + over.node.nodeSize;
  if (!canMoveBlock(doc, source, target)) return null;
  const box = container.getBoundingClientRect();
  return {
    target,
    top: (before ? rect.top - 3 : rect.bottom + 1) - box.top,
    left: rect.left - box.left,
    width: rect.width,
  };
}

interface BlockHandleProps {
  editor: TiptapEditor;
  /** Positioned element around the editor; the handle tracks the pointer in it. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export const BlockHandle = memo(function BlockHandle({
  editor,
  containerRef,
}: BlockHandleProps) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // While the menu is open or a drag runs, the handle stays on its block
  const lockedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const track = (e: MouseEvent) => {
      if (lockedRef.current || !editor.isEditable) return;
      if (
        e.target instanceof Element &&
        e.target.closest("[data-block-handle]")
      )
        return;
      const next = hoveredAt(editor, container, e.clientY);
      setHovered((prev) =>
        prev?.dom === next?.dom &&
        prev?.pos === next?.pos &&
        prev?.top === next?.top
          ? prev
          : next,
      );
    };
    const hide = () => {
      if (!lockedRef.current) setHovered(null);
    };
    // A doc change moves the blocks, so an open menu or a drag would act on a
    // stale position
    const reset = () => {
      dragRef.current = null;
      lockedRef.current = false;
      setDropLine(null);
      setMenuOpen(false);
      setHovered(null);
    };
    container.addEventListener("mousemove", track);
    container.addEventListener("mouseleave", hide);
    editor.on("update", reset);
    return () => {
      container.removeEventListener("mousemove", track);
      container.removeEventListener("mouseleave", hide);
      editor.off("update", reset);
    };
  }, [editor, containerRef]);

  const openMenu = (open: boolean) => {
    lockedRef.current = open;
    setMenuOpen(open);
    if (!open) setHovered(null);
  };

  // Radix opens the menu on press; the grip opens it on release instead,
  // and only when the pointer did not drag.
  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !hovered) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    lockedRef.current = true;
    dragRef.current = {
      startY: e.clientY,
      moved: false,
      drop: null,
    };
  };

  const onGripMove = (e: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !hovered || !container) return;
    if (!drag.moved && Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD)
      return;
    drag.moved = true;
    drag.drop = dropLineAt(editor, container, hovered, e.clientY);
    setDropLine(drag.drop);
  };

  const onGripUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDropLine(null);
    if (!drag || !hovered) return;
    if (!drag.moved) {
      openMenu(true);
      return;
    }
    lockedRef.current = false;
    setHovered(null);
    if (drag.drop) moveBlock(editor, hovered, drag.drop.target);
    editor.commands.focus();
  };

  const onGripCancel = () => {
    dragRef.current = null;
    lockedRef.current = false;
    setDropLine(null);
  };

  const doc = editor.state.doc;
  const up = hovered && siblingTarget(doc, hovered, -1);
  const down = hovered && siblingTarget(doc, hovered, 1);
  const turnable = hovered !== null && canTurnInto(hovered.node);
  const run = (action: () => void) => () => {
    action();
    editor.commands.focus();
  };

  return (
    <>
      <div
        data-block-handle
        contentEditable={false}
        className={cn(
          "absolute z-10 flex items-center -translate-x-full -translate-y-1/2 pr-1.5 text-text-muted transition-opacity duration-150",
          hovered ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        style={{ top: hovered?.top ?? 0, left: hovered?.left ?? 0 }}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label="Insert block below"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg-muted hover:text-text cursor-pointer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!hovered) return;
            insertSlashBlockBelow(editor, hovered);
            setHovered(null);
          }}
        >
          <PlusIcon className="w-4 h-4 stroke-[1.8]" />
        </button>
        <DropdownMenu.Root open={menuOpen} onOpenChange={openMenu}>
          <DropdownMenu.Trigger
            aria-label="Block actions"
            tabIndex={-1}
            className="w-5 h-6 flex items-center justify-center rounded hover:bg-bg-muted hover:text-text cursor-grab active:cursor-grabbing outline-none touch-none"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripCancel}
          >
            <GripVerticalIcon className="w-4 h-4 stroke-[1.8]" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            {hovered && (
              <DropdownMenu.Content
                className="min-w-48 bg-bg border border-border rounded-md shadow-lg py-1 z-50"
                side="left"
                align="start"
                sideOffset={6}
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                {turnable && (
                  <>
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
                        Turn into
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent
                          className="min-w-44 bg-bg border border-border rounded-md shadow-lg py-1 z-50"
                          sideOffset={4}
                        >
                          <TurnIntoItems
                            current={
                              currentBlockType(
                                stateWithBlockSelected(editor.state, hovered),
                              )?.label
                            }
                            onSelect={(type) => turnInto(editor, type, hovered)}
                          />
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                    <DropdownMenu.Separator className="h-px bg-border my-1" />
                  </>
                )}
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  onSelect={run(() => duplicateBlock(editor, hovered))}
                >
                  <CopyIcon className="w-4 h-4 stroke-[1.6]" />
                  Duplicate
                  <span className="ml-auto pl-4 text-xs text-text-muted">
                    {shortcut(mod, "D")}
                  </span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  disabled={up === null}
                  onSelect={run(
                    () => up !== null && moveBlock(editor, hovered, up),
                  )}
                >
                  <ArrowUpIcon className="w-4 h-4 stroke-[1.6]" />
                  Move up
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  disabled={down === null}
                  onSelect={run(
                    () => down !== null && moveBlock(editor, hovered, down),
                  )}
                >
                  <ArrowDownIcon className="w-4 h-4 stroke-[1.6]" />
                  Move down
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="h-px bg-border my-1" />
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  onSelect={run(() => deleteBlock(editor, hovered))}
                >
                  <TrashIcon className="w-4 h-4 stroke-[1.6]" />
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            )}
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {dropLine && (
        <div
          data-drop-indicator
          className="absolute z-10 h-0.5 rounded-full bg-text-muted pointer-events-none"
          style={{
            top: dropLine.top,
            left: dropLine.left,
            width: dropLine.width,
          }}
        />
      )}
    </>
  );
});
