import { InputRule, Mark } from "@tiptap/core";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";

export function normalizeBlockMath(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\$\$([\s\S]*?)\$\$$/);
  return (match?.[1] ?? trimmed).trim();
}

export const AetherBlockMath = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const latex = (match[1] ?? "").trim();
          if (!latex) return;

          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex }),
          );
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const onClick = this.options.onClick;
    return [
      new Plugin({
        key: new PluginKey("blockMathSelection"),
        view() {
          return {
            // Clear native DOM selection when a blockMath node is selected.
            // ProseMirror's NodeSelection sets a DOM selection that spans all
            // content before the atom node, causing a visible highlight bleed.
            update(view) {
              const { selection } = view.state;
              if (
                selection instanceof NodeSelection &&
                selection.node.type.name === "blockMath"
              ) {
                window.getSelection()?.removeAllRanges();
              }
            },
          };
        },
        props: {
          // Open editor on Enter or Space when a blockMath node is selected
          handleKeyDown(view, event) {
            if (event.key !== "Enter" && event.key !== " ") return false;
            const { selection } = view.state;
            if (
              selection instanceof NodeSelection &&
              selection.node.type.name === "blockMath" &&
              onClick
            ) {
              event.preventDefault();
              onClick(selection.node, selection.from);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

// Pandoc's `$...$` rules: no whitespace just inside either `$`, no `$$`, and
// no digit right after the closing `$`, so "$5 and $10" stays text. `\$`
// inside the formula does not close it.
const INLINE_MATH = /^\$(?!\s)((?:\\.|[^\\$\n])*?(?:\\\S|[^\s\\$]))\$(?![\d$])/;

export const AetherInlineMath = InlineMath.extend({
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    start: (src) => src.indexOf("$"),
    tokenize(src) {
      const match = INLINE_MATH.exec(src);
      return match
        ? { type: "inlineMath", raw: match[0], latex: match[1] }
        : undefined;
    },
  },
  // The stock rule turns `$$x$$` into inline math
  addInputRules: () => [],
});

// Keeps the backslash of `\$` when the note is saved. As plain text the `$`
// would save bare and could reopen as math.
export const EscapedDollar = Mark.create({
  name: "escapedDollar",
  inclusive: false,
  parseHTML: () => [{ tag: "span[data-escaped-dollar]" }],
  renderHTML: () => ["span", { "data-escaped-dollar": "" }, 0],
  markdownTokenizer: {
    name: "escapedDollar",
    level: "inline",
    start: (src) => src.indexOf("\\$"),
    tokenize: (src) =>
      src.startsWith("\\$") ? { type: "escapedDollar", raw: "\\$" } : undefined,
  },
  parseMarkdown: (_token, h) =>
    h.applyMark("escapedDollar", [{ type: "text", text: "$" }]),
  renderMarkdown: (node, h) => `\\${h.renderChildren(node)}`,
});
