// Block-level editing shared by the selection toolbar and the block handle:
// the "Turn into" types and the duplicate, move, delete and insert actions.
// A block is a top-level node, or a list item when it sits in a list.
import type { ComponentType } from "react";
import {
  Extension,
  isActive,
  type ChainedCommands,
  type Editor,
} from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import {
  TextSelection,
  type EditorState,
  type Selection,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CalloutIcon,
  CheckIcon,
  CheckSquareIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  QuoteIcon,
  ToggleIcon,
} from "../icons";
import { wrapInToggle } from "./Toggle";

export interface BlockType {
  label: string;
  icon: ComponentType<{ className?: string }>;
  isActive: (state: EditorState) => boolean;
  /** Runs after the selected blocks were turned into plain paragraphs. */
  apply: (chain: ChainedCommands) => ChainedCommands;
}

// Menu order. Wrappers come after the textblocks they hold, so the last
// active entry is the one the selection is in.
export const BLOCK_TYPES: BlockType[] = [
  {
    label: "Text",
    icon: PilcrowIcon,
    isActive: (state) => isActive(state, "paragraph"),
    apply: (chain) => chain,
  },
  ...([1, 2, 3] as const).map((level) => ({
    label: `Heading ${level}`,
    icon: [Heading1Icon, Heading2Icon, Heading3Icon][level - 1],
    isActive: (state: EditorState) => isActive(state, "heading", { level }),
    apply: (chain: ChainedCommands) => chain.setHeading({ level }),
  })),
  {
    label: "Bullet list",
    icon: ListIcon,
    isActive: (state) => isActive(state, "bulletList"),
    apply: (chain) => chain.toggleBulletList(),
  },
  {
    label: "Numbered list",
    icon: ListOrderedIcon,
    isActive: (state) => isActive(state, "orderedList"),
    apply: (chain) => chain.toggleOrderedList(),
  },
  {
    label: "To-do list",
    icon: CheckSquareIcon,
    isActive: (state) => isActive(state, "taskList"),
    apply: (chain) => chain.toggleTaskList(),
  },
  {
    label: "Quote",
    icon: QuoteIcon,
    isActive: (state) => isActive(state, "blockquote"),
    apply: (chain) => chain.setBlockquote(),
  },
  {
    label: "Code",
    icon: CodeIcon,
    isActive: (state) => isActive(state, "codeBlock"),
    apply: (chain) => chain.setCodeBlock(),
  },
  {
    label: "Callout",
    icon: CalloutIcon,
    isActive: (state) => isActive(state, "callout"),
    apply: (chain) => chain.wrapIn("callout"),
  },
  {
    label: "Toggle",
    icon: ToggleIcon,
    isActive: (state) => isActive(state, "details"),
    apply: (chain) => chain.command(wrapInToggle),
  },
];

export function currentBlockType(state: EditorState): BlockType | undefined {
  return BLOCK_TYPES.filter((type) => type.isActive(state)).pop();
}

/** Turns the selection, or `block` when given, into `type`. */
export function turnInto(editor: Editor, type: BlockType, block?: Block) {
  let chain = editor.chain().focus();
  if (block) {
    chain = chain.command(({ tr }) => {
      tr.setSelection(blockSelection(tr.doc, block));
      return true;
    });
  }
  chain = type.apply(chain.clearNodes());
  if (block) {
    chain = chain.command(({ tr }) => {
      const { $to } = tr.selection;
      tr.setSelection(TextSelection.between($to, $to));
      return true;
    });
  }
  chain.run();
}

export const MENU_ITEM_CLASS =
  "px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted data-disabled:opacity-40 data-disabled:pointer-events-none flex items-center gap-2";

/** Radio items for every block type; picking the current one does nothing. */
export function TurnIntoItems({
  current,
  onSelect,
}: {
  current: string | undefined;
  onSelect: (type: BlockType) => void;
}) {
  return (
    <DropdownMenu.RadioGroup
      value={current ?? ""}
      onValueChange={(label) => {
        const type = BLOCK_TYPES.find((t) => t.label === label);
        if (type) onSelect(type);
      }}
    >
      {BLOCK_TYPES.map(({ label, icon: Icon }) => (
        <DropdownMenu.RadioItem
          key={label}
          value={label}
          className={MENU_ITEM_CLASS}
        >
          <Icon className="w-4 h-4 stroke-[1.6] text-text-muted" />
          {label}
          <DropdownMenu.ItemIndicator className="ml-auto pl-4">
            <CheckIcon className="w-4 h-4 stroke-[1.6]" />
          </DropdownMenu.ItemIndicator>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

export interface Block {
  /** Position right before the node. */
  pos: number;
  node: PMNode;
}

export interface DomBlock extends Block {
  dom: HTMLElement;
}

const isList = (node: PMNode) => node.type.isInGroup("list");
// Blocks that must stay where they are.
const isFixed = (node: PMNode) => node.type.name === "frontmatter";

/** Whether Turn into applies: the block holds text directly or first. */
export function canTurnInto(node: PMNode): boolean {
  return node.isTextblock || Boolean(node.firstChild?.isTextblock);
}

/** The text of a block, as a selection that Turn into can work on. */
function blockSelection(doc: PMNode, block: Block): Selection {
  return TextSelection.between(
    doc.resolve(block.pos + 1),
    doc.resolve(block.pos + block.node.nodeSize - 1),
  );
}

/** State with `block` selected, to read its current type without touching the editor. */
export function stateWithBlockSelected(
  state: EditorState,
  block: Block,
): EditorState {
  return state.apply(state.tr.setSelection(blockSelection(state.doc, block)));
}

/** The block that holds a position: the innermost list item, else the top-level node. */
export function blockAt($pos: ResolvedPos): Block | null {
  if ($pos.depth === 0) {
    const node = $pos.nodeAfter;
    return node && !isFixed(node) ? { pos: $pos.pos, node } : null;
  }
  let depth = 1;
  while (depth < $pos.depth && isList($pos.node(depth))) {
    depth += 1;
    if (depth === $pos.depth || !isList($pos.node(depth + 1))) break;
    depth += 1;
  }
  const node = $pos.node(depth);
  return isFixed(node) ? null : { pos: $pos.before(depth), node };
}

/** The child of `parent` (whose content starts at `start`) at or below `y`. */
function childAtY(
  view: EditorView,
  parent: PMNode,
  start: number,
  y: number,
): DomBlock | null {
  let pos = start;
  for (let i = 0; i < parent.childCount; i += 1) {
    const node = parent.child(i);
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement && y <= dom.getBoundingClientRect().bottom) {
      return { pos, node, dom };
    }
    pos += node.nodeSize;
  }
  return null;
}

/** The block at height `y`; with `topLevel`, list items are not looked into. */
export function blockAtY(
  view: EditorView,
  y: number,
  topLevel = false,
): DomBlock | null {
  let block = childAtY(view, view.state.doc, 0, y);
  if (!block || isFixed(block.node)) return null;
  if (topLevel) return block;
  while (isList(block.node)) {
    const item = childAtY(view, block.node, block.pos + 1, y);
    if (!item) break;
    block = item;
    const nested = childAtY(view, item.node, item.pos + 1, y);
    if (nested && isList(nested.node)) block = nested;
  }
  return block;
}

export function isListItem(doc: PMNode, block: Block): boolean {
  return isList(doc.resolve(block.pos).parent);
}

/** The range a block leaves behind; a list's only item takes the list along. */
function ownRange(doc: PMNode, block: Block): Block {
  let range = block;
  let $pos = doc.resolve(block.pos);
  while ($pos.depth > 0 && $pos.parent.childCount === 1) {
    range = { pos: $pos.before(), node: $pos.parent };
    $pos = doc.resolve(range.pos);
  }
  return range;
}

interface Move {
  from: number;
  to: number;
  node: PMNode;
}

/** How `block` moves to `target`, or null when it cannot go there. */
function planMove(doc: PMNode, block: Block, target: number): Move | null {
  const range = ownRange(doc, block);
  const end = range.pos + range.node.nodeSize;
  if (target >= range.pos && target <= end) return null;
  const list = doc.resolve(block.pos).parent;
  // A list item dropped outside a list keeps its list type.
  const candidates = isList(list)
    ? [block.node, list.type.create(list.attrs, block.node)]
    : [block.node];
  const $target = doc.resolve(target);
  const node = candidates.find((candidate) =>
    $target.parent.canReplaceWith(
      $target.index(),
      $target.index(),
      candidate.type,
    ),
  );
  return node ? { from: range.pos, to: end, node } : null;
}

export function canMoveBlock(
  doc: PMNode,
  block: Block,
  target: number,
): boolean {
  return planMove(doc, block, target) !== null;
}

export function moveBlock(editor: Editor, block: Block, target: number) {
  const { state, view } = editor;
  const move = planMove(state.doc, block, target);
  if (!move) return;
  const tr = state.tr.delete(move.from, move.to);
  view.dispatch(tr.insert(tr.mapping.map(target), move.node));
}

/** Where `block` lands when it swaps with its previous (-1) or next (1) sibling. */
export function siblingTarget(
  doc: PMNode,
  block: Block,
  direction: -1 | 1,
): number | null {
  const $pos = doc.resolve(block.pos);
  const sibling = $pos.parent.maybeChild($pos.index() + direction);
  if (!sibling) return null;
  return direction < 0
    ? block.pos - sibling.nodeSize
    : block.pos + block.node.nodeSize + sibling.nodeSize;
}

export function duplicateBlock(editor: Editor, block: Block) {
  const { state, view } = editor;
  view.dispatch(state.tr.insert(block.pos + block.node.nodeSize, block.node));
}

export function deleteBlock(editor: Editor, block: Block) {
  const { state, view } = editor;
  const range = ownRange(state.doc, block);
  view.dispatch(state.tr.delete(range.pos, range.pos + range.node.nodeSize));
}

/** Adds a block holding `/` after `block`, so the slash menu opens there. */
export function insertSlashBlockBelow(editor: Editor, block: Block) {
  const { state, view, schema } = editor;
  const at = block.pos + block.node.nodeSize;
  const paragraph = schema.nodes.paragraph.create(null, schema.text("/"));
  const item = isListItem(state.doc, block);
  const tr = state.tr.insert(
    at,
    item ? block.node.type.create(null, paragraph) : paragraph,
  );
  // Past the `/`: one step into the paragraph, one more into the list item.
  tr.setSelection(TextSelection.create(tr.doc, at + (item ? 3 : 2)));
  view.dispatch(tr);
  view.focus();
}

export const BlockShortcuts = Extension.create({
  name: "blockShortcuts",
  addKeyboardShortcuts() {
    return {
      "Mod-d": () => {
        const block = blockAt(this.editor.state.selection.$from);
        if (block) duplicateBlock(this.editor, block);
        return true;
      },
    };
  },
});
