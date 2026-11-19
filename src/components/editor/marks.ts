// Highlight and text color, written as inline HTML (`<mark>`, `<span style>`)
// so other markdown apps keep them.
import type { MarkdownTokenizer } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";

/**
 * Tokenizes `<tag ...>inline markdown</tag>`, where `open` matches the opening
 * tag. Its first group, if any, becomes the token's `value`. Escaped
 * characters and code spans cannot close the tag.
 */
function inlineHtmlTokenizer(
  name: string,
  tag: string,
  open: RegExp,
): MarkdownTokenizer {
  return {
    name,
    level: "inline",
    start: (src) => src.toLowerCase().indexOf(`<${tag}`),
    tokenize(src, _tokens, lexer) {
      const opening = open.exec(src);
      if (!opening) return undefined;
      const delimiters = new RegExp(`\\\\[\\s\\S]|\`+|</${tag}>`, "gi");
      delimiters.lastIndex = opening[0].length;
      for (
        let match = delimiters.exec(src);
        match;
        match = delimiters.exec(src)
      ) {
        if (match[0].startsWith("`")) {
          const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(
            src.slice(match.index),
          );
          if (code) delimiters.lastIndex = match.index + code[0].length;
        } else if (!match[0].startsWith("\\")) {
          const text = src.slice(opening[0].length, match.index);
          if (!text) return undefined;
          return {
            type: name,
            raw: src.slice(0, delimiters.lastIndex),
            text,
            value: opening[1],
            tokens: lexer.inlineTokens(text),
          };
        }
      }
      return undefined;
    },
  };
}

// Replaces the `==text==` syntax: `<mark>` is what Obsidian and GitHub both render.
export const MarkHighlight = Highlight.extend({
  renderMarkdown: (node, h) => `<mark>${h.renderChildren(node)}</mark>`,
  markdownTokenizer: inlineHtmlTokenizer("highlight", "mark", /^<mark>/i),
});

export const ColorTextStyle = TextStyle.extend({
  renderMarkdown: (node, h) => {
    const color: unknown = node.attrs?.color;
    const content = h.renderChildren(node);
    return typeof color === "string" && color
      ? `<span style="color: ${color}">${content}</span>`
      : content;
  },
  parseMarkdown: (token, h) =>
    h.applyMark("textStyle", h.parseInline(token.tokens ?? []), {
      color: token.value,
    }),
  markdownTokenizer: inlineHtmlTokenizer(
    "textStyle",
    "span",
    /^<span style="color: ?([^";<>]+?);?">/i,
  ),
});
