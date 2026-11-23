// Pure checks of buildPageTree in src/lib/folderTree.ts for a case the E2E fake
// cannot reach: a page whose parent is not a note. Runs in Node, no browser.
import { expect, test } from "@playwright/test";
import { buildPageTree, type PageNode } from "../../src/lib/folderTree";
import type { NoteMetadata } from "../../src/types/note";

function page(id: string, modified: number): NoteMetadata {
  return { id, title: id.split("/").pop() ?? id, preview: "", modified };
}

/** The tree as nested `[id, children]` pairs, in display order. */
function shape(nodes: PageNode[]): unknown[] {
  return nodes.map((node) => [node.note.id, shape(node.children)]);
}

test("a page whose parents are not notes nests under stand-ins for them", () => {
  const tree = buildPageTree([page("Top", 5), page("a/b/Deep", 9)]);
  expect(shape(tree)).toEqual([
    ["Top", []],
    ["a", [["a/b", [["a/b/Deep", []]]]]],
  ]);
  expect(tree[1].note.title).toBe("a");
  expect(tree[1].children[0].note.title).toBe("b");
});

test("a stand-in parent is shared by its pages and keeps them newest first", () => {
  const tree = buildPageTree([
    page("Work/Old", 1),
    page("Work/New", 3),
    page("Work/Mid", 2),
  ]);
  expect(shape(tree)).toEqual([
    [
      "Work",
      [
        ["Work/New", []],
        ["Work/Mid", []],
        ["Work/Old", []],
      ],
    ],
  ]);
});
