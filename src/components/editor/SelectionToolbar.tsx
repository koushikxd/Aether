import { memo, type ComponentType } from "react";
import { useEditorState, type Editor as TiptapEditor } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ToolbarButton } from "../ui";
import {
  BoldIcon,
  ChevronDownIcon,
  HighlighterIcon,
  InlineCodeIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  TextColorIcon,
  UnderlineIcon,
} from "../icons";
import { mod, shift, shortcut } from "../../lib/platform";
import {
  currentBlockType,
  MENU_ITEM_CLASS,
  turnInto,
  TurnIntoItems,
} from "./blocks";

const MARKS: {
  name: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  keys: string;
}[] = [
  { name: "bold", label: "Bold", icon: BoldIcon, keys: shortcut(mod, "B") },
  {
    name: "italic",
    label: "Italic",
    icon: ItalicIcon,
    keys: shortcut(mod, "I"),
  },
  {
    name: "underline",
    label: "Underline",
    icon: UnderlineIcon,
    keys: shortcut(mod, "U"),
  },
  {
    name: "strike",
    label: "Strikethrough",
    icon: StrikethroughIcon,
    keys: shortcut(mod, shift, "S"),
  },
  {
    name: "code",
    label: "Inline code",
    icon: InlineCodeIcon,
    keys: shortcut(mod, "E"),
  },
  {
    name: "highlight",
    label: "Highlight",
    icon: HighlighterIcon,
    keys: shortcut(mod, shift, "H"),
  },
];

// Notion's text colors, readable on light and dark backgrounds.
const COLORS = [
  { label: "Gray", value: "#787774" },
  { label: "Brown", value: "#9f6b53" },
  { label: "Orange", value: "#d9730d" },
  { label: "Yellow", value: "#cb912f" },
  { label: "Green", value: "#448361" },
  { label: "Blue", value: "#337ea9" },
  { label: "Purple", value: "#9065b0" },
  { label: "Pink", value: "#c14c8a" },
  { label: "Red", value: "#d44c47" },
];

// Text selections only: not images or other selected nodes, not code.
const shouldShow: BubbleMenuProps["shouldShow"] = ({
  editor,
  element,
  view,
  state,
  from,
  to,
}) => {
  const { selection } = state;
  return (
    (view.hasFocus() || element.contains(document.activeElement)) &&
    editor.isEditable &&
    (selection instanceof TextSelection || selection instanceof AllSelection) &&
    state.doc.textBetween(from, to).length > 0 &&
    !editor.isActive("codeBlock") &&
    !editor.isActive("frontmatter")
  );
};

interface SelectionToolbarProps {
  editor: TiptapEditor;
  onLink: () => void;
}

export const SelectionToolbar = memo(function SelectionToolbar({
  editor,
  onLink,
}: SelectionToolbarProps) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      marks: MARKS.map(({ name }) => current.isActive(name)),
      link: current.isActive("link"),
      color: current.getAttributes("textStyle").color as unknown,
      type: currentBlockType(current.state)?.label,
    }),
  });

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={shouldShow}
      role="toolbar"
      aria-label="Formatting"
      className="flex items-center gap-0.5 p-1 bg-bg border border-border rounded-lg shadow-lg z-20"
      // Keep the editor focused, and its selection, while using the toolbar
      onMouseDown={(e) => e.preventDefault()}
    >
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          aria-label="Turn into"
          className="h-7 px-2 flex items-center gap-1 text-sm text-text-muted rounded hover:bg-bg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent shrink-0"
        >
          {active.type ?? "Turn into"}
          <ChevronDownIcon className="w-3.5 h-3.5 stroke-[1.8]" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="min-w-44 bg-bg border border-border rounded-md shadow-lg py-1 z-50"
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <TurnIntoItems
            current={active.type}
            onSelect={(type) => turnInto(editor, type)}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <div className="w-px h-4.5 bg-border mx-1" />
      {MARKS.map(({ name, label, icon: Icon, keys }, i) => (
        <ToolbarButton
          key={name}
          title={`${label} (${keys})`}
          isActive={active.marks[i]}
          onClick={() => editor.chain().focus().toggleMark(name).run()}
        >
          <Icon className="w-4.5 h-4.5 stroke-[1.5]" />
        </ToolbarButton>
      ))}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          aria-label="Text color"
          title="Text color"
          className="h-7 w-7 flex items-center justify-center text-text-muted rounded hover:bg-bg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent shrink-0"
        >
          <span
            style={{
              color:
                typeof active.color === "string" ? active.color : undefined,
            }}
          >
            <TextColorIcon className="w-4.5 h-4.5 stroke-[1.5]" />
          </span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="min-w-36 bg-bg border border-border rounded-md shadow-lg py-1 z-50"
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() => editor.chain().focus().unsetColor().run()}
          >
            <span aria-hidden className="w-4 text-center font-medium text-text">
              A
            </span>
            Default
          </DropdownMenu.Item>
          {COLORS.map(({ label, value }) => (
            <DropdownMenu.Item
              key={value}
              className={MENU_ITEM_CLASS}
              onSelect={() => editor.chain().focus().setColor(value).run()}
            >
              <span
                aria-hidden
                className="w-4 text-center font-medium"
                style={{ color: value }}
              >
                A
              </span>
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <div className="w-px h-4.5 bg-border mx-1" />
      <ToolbarButton
        title={`Link (${shortcut(mod, shift, "L")})`}
        isActive={active.link}
        onClick={onLink}
      >
        <LinkIcon className="w-4.5 h-4.5 stroke-[1.5]" />
      </ToolbarButton>
    </BubbleMenu>
  );
});
