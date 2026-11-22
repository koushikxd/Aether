import { alt, mod, shift } from "./platform";

export interface Shortcut {
  keys: string[];
  description: string;
}

export interface ShortcutCategory {
  title: string;
  shortcuts: Shortcut[];
}

export const shortcutCategories: ShortcutCategory[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: [mod, "K"], description: "Command menu" },
      { keys: [mod, "1-9"], description: "Run a row in a menu sub-view" },
      { keys: [mod, "T"], description: "Open a note in a new tab" },
      { keys: [mod, "1-8"], description: "Go to tab" },
      { keys: [mod, "9"], description: "Go to the last tab" },
      { keys: ["Ctrl", "Tab"], description: "Next tab" },
      { keys: ["Ctrl", shift, "Tab"], description: "Previous tab" },
      { keys: [mod, shift, "T"], description: "Reopen closed tab" },
      { keys: [mod, shift, "F"], description: "Search notes" },
      { keys: [mod, shift, "O"], description: "Recent notes" },
      { keys: [mod, "["], description: "Back" },
      { keys: [mod, "]"], description: "Forward" },
      { keys: [mod, alt, "↑"], description: "Go to parent page" },
      { keys: [mod, "\\"], description: "Toggle sidebar" },
      { keys: [mod, ","], description: "Settings" },
      { keys: [mod, "/"], description: "Keyboard shortcuts" },
      { keys: [mod, "W"], description: "Close tab" },
      { keys: [mod, "="], description: "Zoom in" },
      { keys: [mod, "-"], description: "Zoom out" },
      { keys: [mod, "0"], description: "Reset zoom" },
    ],
  },
  {
    title: "Notes",
    shortcuts: [
      { keys: [mod, "N"], description: "New note" },
      { keys: [mod, shift, "N"], description: "New sub-page" },
      { keys: [mod, "D"], description: "Duplicate note" },
      { keys: [mod, "R"], description: "Reload note" },
      { keys: ["Delete"], description: "Delete note" },
      { keys: [mod, "Backspace"], description: "Delete note" },
      { keys: ["↑", "↓"], description: "Navigate notes" },
      { keys: ["Enter"], description: "Focus editor" },
      { keys: ["Esc"], description: "Back to note list" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { keys: [mod, "B"], description: "Bold" },
      { keys: [mod, "I"], description: "Italic" },
      { keys: [mod, shift, "L"], description: "Add / edit link" },
      { keys: [mod, "F"], description: "Find in note" },
      { keys: [mod, shift, "C"], description: "Copy & Export" },
      { keys: [mod, shift, "P"], description: "Print / Export as PDF" },
      { keys: [mod, shift, "M"], description: "Markdown source" },
      { keys: [mod, shift, "Enter"], description: "Focus mode" },
      { keys: ["/"], description: "Slash commands" },
    ],
  },
  {
    title: "Settings",
    shortcuts: [
      { keys: [mod, "1"], description: "Folder" },
      { keys: [mod, "2"], description: "Integrations" },
      { keys: [mod, "3"], description: "Appearance" },
      { keys: [mod, "4"], description: "Shortcuts" },
      { keys: [mod, "5"], description: "About" },
    ],
  },
  {
    title: "Markdown Syntax",
    shortcuts: [
      { keys: ["#"], description: "Heading 1" },
      { keys: ["##"], description: "Heading 2" },
      { keys: ["###"], description: "Heading 3" },
      { keys: ["**bold**"], description: "Bold text" },
      { keys: ["*italic*"], description: "Italic text" },
      { keys: ["~~text~~"], description: "Strikethrough" },
      { keys: ["-"], description: "Bullet list" },
      { keys: ["1."], description: "Numbered list" },
      { keys: ["- [ ]"], description: "Task list" },
      { keys: [">"], description: "Blockquote" },
      { keys: ["`code`"], description: "Inline code" },
      { keys: ["```"], description: "Code block" },
      { keys: ["---"], description: "Horizontal rule" },
      { keys: ["[text](url)"], description: "Link" },
      { keys: ["[[Note]]"], description: "Wikilink" },
      { keys: ["![alt](url)"], description: "Image" },
      { keys: ["| | |"], description: "Table" },
      { keys: ["$$...$$"], description: "Block math" },
      { keys: ["```mermaid"], description: "Mermaid diagram" },
    ],
  },
];
