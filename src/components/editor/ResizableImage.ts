import { Image } from "@tiptap/extension-image";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * Images resize from their side handles; a resized image is saved as `<img width>`.
 * An `<img>` inside a line of text stays in it, like `![](...)` does, instead
 * of being dropped as inline HTML the schema has no inline node for.
 */
export const ResizableImage = Image.extend({
  markdownTokenizer: {
    name: "image",
    level: "inline",
    start: (src) => src.search(/<img\s/i),
    tokenize(src) {
      const raw = /^<img\s[^>]*>/i.exec(src)?.[0];
      const img = raw
        ? new DOMParser().parseFromString(raw, "text/html").querySelector("img")
        : null;
      if (!raw || !img) return undefined;
      return {
        type: "image",
        raw,
        href: img.getAttribute("src") ?? "",
        text: img.getAttribute("alt") ?? "",
        title: img.getAttribute("title"),
        width: img.getAttribute("width"),
      };
    },
  },

  parseMarkdown: (token, h) =>
    h.createNode("image", {
      src: token.href,
      alt: token.text,
      title: token.title,
      width: token.width,
    }),

  renderMarkdown(node, h, ctx) {
    const width = Math.round(Number(node.attrs?.width));
    if (!width) return this.parent?.(node, h, ctx) ?? "";
    const attrs = (["src", "alt", "title"] as const).flatMap((name) => {
      const value: unknown = node.attrs?.[name];
      return typeof value === "string" && value
        ? [`${name}="${escapeAttribute(value)}"`]
        : [];
    });
    return `<img ${[...attrs, `width="${width}"`].join(" ")}>`;
  },
}).configure({
  inline: false,
  allowBase64: false,
  resize: {
    enabled: true,
    directions: ["left", "right"],
    minWidth: 48,
    alwaysPreserveAspectRatio: true,
  },
});
