import { Extension, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// The title is the first block, after the frontmatter if there is one.
function titleIndex(doc: PMNode): number {
  return doc.firstChild?.type.name === "frontmatter" ? 1 : 0;
}

function isTitle(node: PMNode | null): boolean {
  return node?.type.name === "heading" && node.attrs.level === 1;
}

function titleAt(doc: PMNode): { node: PMNode | null; pos: number } {
  const index = titleIndex(doc);
  return {
    node: index < doc.childCount ? doc.child(index) : null,
    pos: index === 0 ? 0 : doc.child(0).nodeSize,
  };
}

/**
 * Keeps an H1 title at the top of every page, as Notion does. An empty title
 * shows "Untitled" and is left out of the markdown, so a page without a
 * heading opens and saves unchanged.
 */
export const Title = Extension.create({
  name: "title",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("title"),
        appendTransaction: (_transactions, _old, state) => {
          const { node, pos } = titleAt(state.doc);
          if (isTitle(node)) return null;
          const heading = state.schema.nodes.heading;
          const tr = state.tr;
          if (node?.isTextblock && node.content.size === 0) {
            tr.setNodeMarkup(pos, heading, { level: 1 });
          } else {
            tr.insert(pos, heading.create({ level: 1 }));
          }
          return tr.setMeta("addToHistory", false);
        },
        props: {
          decorations: (state) => {
            const { node, pos } = titleAt(state.doc);
            if (!node || !isTitle(node) || node.content.size > 0) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, {
                class: "title-empty",
                "data-title-placeholder": "Untitled",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

/** The document without its title when the title is empty. */
export function withoutEmptyTitle(doc: JSONContent): JSONContent {
  const content = doc.content ?? [];
  const index = content[0]?.type === "frontmatter" ? 1 : 0;
  const title = content[index];
  if (
    title?.type !== "heading" ||
    title.attrs?.level !== 1 ||
    title.content?.length
  ) {
    return doc;
  }
  return { ...doc, content: content.filter((_, i) => i !== index) };
}
