import { memo } from "react";
import { Node, type JSONContent } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

const DEFAULT_ICON = "💡";
const ICONS = [
  "💡",
  "⚠️",
  "❗",
  "❓",
  "ℹ️",
  "✅",
  "❌",
  "📌",
  "📝",
  "🔥",
  "⭐",
  "🚀",
  "💬",
  "📎",
  "🔒",
  "🎯",
  "🧪",
  "🐛",
  "📅",
  "❤️",
];

// `> [!type]` with an optional fold sign and title: the callout's first line.
const HEADER =
  /^ {0,3}> ?\[!([^\]\s]+)\]([+-]?)(?:[ \t]+([^\n]*?))?[ \t]*(?:\n|$)/;
const QUOTED = /^ {0,3}> ?/;
// A title starting with one emoji and a space, or only an emoji: the emoji
// is the icon (`> [!tip] 🔥 Hot take`).
const ICON_TITLE =
  /^(\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)(?: (\S.*))?$/u;

const CalloutView = memo(function CalloutView({
  node,
  updateAttributes,
  editor,
}: ReactNodeViewProps) {
  const icon: unknown = node.attrs.icon;
  const title: unknown = node.attrs.title;
  return (
    <NodeViewWrapper data-callout="" className="callout">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          contentEditable={false}
          disabled={!editor.isEditable}
          aria-label="Change icon"
          className="callout-icon"
        >
          {typeof icon === "string" && icon ? icon : DEFAULT_ICON}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="grid grid-cols-5 gap-0.5 p-1 bg-bg border border-border rounded-md shadow-lg z-50"
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {ICONS.map((emoji) => (
            <DropdownMenu.Item
              key={emoji}
              className="w-8 h-8 flex items-center justify-center text-lg rounded cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted"
              onSelect={() => updateAttributes({ icon: emoji })}
            >
              {emoji}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <div className="flex-1 min-w-0">
        {typeof title === "string" && title && (
          <div contentEditable={false} className="font-semibold leading-[1.75]">
            {title}
          </div>
        )}
        <NodeViewContent className="callout-body" />
      </div>
    </NodeViewWrapper>
  );
});

/**
 * A block container with an emoji icon, stored as an Obsidian-style callout.
 * Every `[!type]` callout is kept as one, with its type, fold sign and title
 * unchanged. An emoji leading the title is the icon; a picked icon goes
 * before the rest of the title.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      kind: { default: "note", rendered: false },
      fold: { default: "", rendered: false },
      icon: { default: DEFAULT_ICON, rendered: false },
      title: { default: "", rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node }) {
    const attrs = { "data-callout": "", "data-icon": node.attrs.icon };
    return node.attrs.title
      ? ["div", attrs, ["p", ["strong", node.attrs.title]], ["div", 0]]
      : ["div", attrs, 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },

  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src) => src.search(/^ {0,3}> ?\[!/m),
    tokenize(src, _tokens, lexer) {
      const header = HEADER.exec(src);
      if (!header) return undefined;
      const [, kind, fold, title] = header;
      // The `>` lines that follow, and lazy lines without `>` that continue
      // the last paragraph, as CommonMark (and a plain quote) reads them
      let body = "";
      let end = header[0].length;
      while (end < src.length) {
        const next = src.indexOf("\n", end);
        const line = src.slice(end, next === -1 ? src.length : next + 1);
        if (QUOTED.test(line)) {
          body += line.replace(QUOTED, "");
        } else {
          const blocks = body ? lexer.blockTokens(body) : [];
          const inParagraph =
            !body || blocks[blocks.length - 1]?.type === "paragraph";
          if (
            !line.trim() ||
            !inParagraph ||
            !lexer.isParagraphContinuation?.(line.trimEnd())
          ) {
            break;
          }
          body += line;
        }
        end += line.length;
      }
      return {
        type: "callout",
        raw: src.slice(0, end),
        kind,
        fold,
        title: title ?? "",
        tokens: lexer.blockTokens(body),
      };
    },
  },

  parseMarkdown(token, h) {
    const content = h.parseChildren(token.tokens ?? []);
    const title: unknown = token.title;
    const [, icon = "", text = ""] =
      typeof title === "string"
        ? (ICON_TITLE.exec(title) ?? ["", "", title])
        : [];
    return h.createNode(
      "callout",
      { kind: token.kind, fold: token.fold, icon, title: text },
      content.length ? content : [{ type: "paragraph" }],
    );
  },

  renderMarkdown(node: JSONContent, h) {
    const { kind, fold, icon, title } = node.attrs ?? {};
    const heading = [icon, title].filter(Boolean).join(" ");
    const header = `> [!${kind}]${fold}${heading ? ` ${heading}` : ""}`;
    const body = h.renderChildren(node.content ?? [], "\n\n");
    if (!body) return header;
    const lines = body.split("\n").map((line) => (line ? `> ${line}` : ">"));
    return [header, ...lines].join("\n");
  },
});
