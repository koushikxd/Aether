// The toggle block: TipTap's details nodes, stored as an HTML `<details>`
// element whose body is markdown, which GitHub and Obsidian both render.
import {
  encodeHtmlEntities,
  type CommandProps,
  type JSONContent,
} from "@tiptap/core";
import {
  Details,
  DetailsContent,
  DetailsSummary,
} from "@tiptap/extension-details";
import { TextSelection } from "@tiptap/pm/state";

const OPEN = /^<details(\s+open)?>\s*<summary>(.*?)<\/summary>[ \t]*(?:\n|$)/i;
const NESTED_OPEN = /^ {0,3}<details(?:\s+open)?>/i;
const CLOSE = /^ {0,3}<\/details>\s*$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The text a `<summary>` shows: tags dropped, entities decoded. */
function summaryText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent;
}

/** Length of `src` up to and including the `</details>` line that closes it, or -1. */
function closingEnd(src: string, start: number): number {
  let depth = 1;
  let fence: string | null = null;
  let offset = start;
  while (offset < src.length) {
    const newline = src.indexOf("\n", offset);
    const end = newline === -1 ? src.length : newline + 1;
    const line = src.slice(offset, end);
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    } else if (marker) {
      fence = marker;
    } else if (NESTED_OPEN.test(line)) {
      depth += 1;
    } else if (CLOSE.test(line)) {
      depth -= 1;
      if (depth === 0) return end;
    }
    offset = end;
  }
  return -1;
}

export const Toggle = Details.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // The `<summary>` source and `open` attribute as written, kept so a
      // hand-written toggle saves unchanged. The title shows as plain text.
      summaryHtml: { default: null, rendered: false },
      openInSource: { default: false, rendered: false },
    };
  },

  markdownTokenizer: {
    name: "details",
    level: "block",
    start: (src) => src.search(/^<details/im),
    tokenize(src, _tokens, lexer) {
      const open = OPEN.exec(src);
      if (!open) return undefined;
      const end = closingEnd(src, open[0].length);
      if (end === -1) return undefined;
      const body = src
        .slice(open[0].length, end)
        .replace(/[ \t]*<\/details>\s*$/i, "");
      return {
        type: "details",
        raw: src.slice(0, end),
        open: Boolean(open[1]),
        summary: open[2],
        tokens: lexer.blockTokens(body),
      };
    },
  },

  parseMarkdown(token, h) {
    const body = h.parseChildren(token.tokens ?? []);
    const summary: unknown = token.summary;
    const title = typeof summary === "string" ? summaryText(summary) : "";
    return h.createNode(
      "details",
      { summaryHtml: summary, openInSource: token.open },
      [
        h.createNode(
          "detailsSummary",
          null,
          title ? [h.createTextNode(title)] : [],
        ),
        h.createNode(
          "detailsContent",
          null,
          body.length ? body : [{ type: "paragraph" }],
        ),
      ],
    );
  },

  renderMarkdown(node: JSONContent, h) {
    const [summary, content] = node.content ?? [];
    const title = (summary?.content ?? []).map((t) => t.text ?? "").join("");
    const { summaryHtml, openInSource } = node.attrs ?? {};
    const unedited =
      typeof summaryHtml === "string" && summaryText(summaryHtml) === title;
    const body = h.renderChildren(content?.content ?? [], "\n\n");
    return `<details${openInSource ? " open" : ""}><summary>${unedited ? summaryHtml : encodeHtmlEntities(title)}</summary>\n\n${body ? `${body}\n\n` : ""}</details>`;
  },
});

// The summary is plain text, as `<summary>` holds no markdown.
export const ToggleSummary = DetailsSummary.extend({ marks: "" });

export { DetailsContent as ToggleContent };

/**
 * Turns the selected blocks into a toggle: the first block's text becomes its
 * title and the rest its body. A first block the plain-text title would lose
 * parts of (atoms such as inline math, or links) goes to the body whole. The
 * cursor ends up at the end of the title.
 */
export function wrapInToggle({ state, tr, dispatch }: CommandProps): boolean {
  const { schema, selection } = state;
  const range = selection.$from.blockRange(selection.$to);
  if (!range) return false;
  const blocks = state.doc.slice(range.start, range.end).content;
  const first = blocks.firstChild;
  const asTitle =
    first?.isTextblock === true &&
    first.content.content.every(
      (child) =>
        child.isText && !child.marks.some((mark) => mark.type.name === "link"),
    );
  const title = asTitle ? first.textContent : "";
  const rest: JSONContent[] = [];
  blocks.forEach((block, _offset, index) => {
    if (index > 0 || !asTitle) rest.push(block.toJSON());
  });
  const toggle = schema.nodeFromJSON({
    type: "details",
    content: [
      {
        type: "detailsSummary",
        content: title ? [{ type: "text", text: title }] : [],
      },
      {
        type: "detailsContent",
        content: rest.length ? rest : [{ type: "paragraph" }],
      },
    ],
  });
  if (dispatch) {
    tr.replaceWith(range.start, range.end, toggle);
    tr.setSelection(
      TextSelection.create(tr.doc, range.start + 2 + title.length),
    );
  }
  return true;
}
