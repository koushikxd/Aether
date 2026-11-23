import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteMetadata } from "../types/note";

/** A page and its sub-pages, newest first. */
export interface PageNode {
  note: NoteMetadata;
  children: PageNode[];
}

function sortNewestFirst(nodes: PageNode[]) {
  nodes.sort((a, b) => b.note.modified - a.note.modified);
  for (const node of nodes) sortNewestFirst(node.children);
}

/**
 * Nests every page under its parent page (`Page/Child` under `Page`), newest
 * first at every level. A page whose parent is not itself a note goes under
 * a stand-in page for that parent, so it stays reachable.
 */
export function buildPageTree(notes: NoteMetadata[]): PageNode[] {
  const pages = notes.map((note): PageNode => ({ note, children: [] }));
  const nodes = new Map(pages.map((node) => [node.note.id, node]));
  const roots: PageNode[] = [];

  function place(node: PageNode) {
    const slash = node.note.id.lastIndexOf("/");
    if (slash === -1) {
      roots.push(node);
      return;
    }
    const parentId = node.note.id.slice(0, slash);
    let parent = nodes.get(parentId);
    if (!parent) {
      parent = {
        note: {
          id: parentId,
          title: parentId.slice(parentId.lastIndexOf("/") + 1),
          preview: "",
          modified: 0,
        },
        children: [],
      };
      nodes.set(parentId, parent);
      place(parent);
    }
    parent.children.push(node);
  }

  for (const node of pages) place(node);
  sortNewestFirst(roots);
  return roots;
}

/** Ids of the rows a tree shows, top to bottom, skipping collapsed pages' sub-pages. */
export function visiblePageIds(
  tree: PageNode[],
  collapsed: Set<string>,
): string[] {
  const ids: string[] = [];
  function walk(nodes: PageNode[]) {
    for (const node of nodes) {
      ids.push(node.note.id);
      if (!collapsed.has(node.note.id)) walk(node.children);
    }
  }
  walk(tree);
  return ids;
}

interface SubPageCounts {
  subPages: number;
  otherFiles: number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What deleting each of `ids` takes along, summed. Pass null while no dialog
 * is open, so each opening counts again, and keep `ids` stable between
 * renders. Stays null until every count arrives, and after one fails, so a
 * dialog never understates what goes.
 */
function useSubPageCounts(ids: readonly string[] | null): SubPageCounts | null {
  const [counted, setCounted] = useState<{
    ids: readonly string[];
    counts: SubPageCounts;
  } | null>(null);

  useEffect(() => {
    if (!ids) return undefined;
    let current = true;
    Promise.all(
      ids.map((id) => invoke<SubPageCounts>("sub_page_counts", { id })),
    )
      .then((all) => {
        const counts = { subPages: 0, otherFiles: 0 };
        for (const c of all) {
          counts.subPages += c.subPages;
          counts.otherFiles += c.otherFiles;
        }
        if (current) setCounted({ ids, counts });
      })
      .catch((error: unknown) => {
        console.error("Failed to count sub-pages:", error);
      });
    return () => {
      current = false;
      setCounted(null);
    };
  }, [ids]);

  return counted?.ids === ids ? counted.counts : null;
}

/**
 * Confirmation text for deleting note `id`, which takes everything in its
 * sub-page folder along. Pass null while no dialog is open. `ready` stays
 * false until the count arrives.
 */
export function useDeleteNoteWarning(id: string | null): {
  text: string;
  ready: boolean;
} {
  const ids = useMemo(() => (id ? [id] : null), [id]);
  const counts = useSubPageCounts(ids);
  const parts: string[] = [];
  if (counts?.subPages) parts.push(plural(counts.subPages, "sub-page"));
  if (counts?.otherFiles) parts.push(plural(counts.otherFiles, "other file"));
  const text =
    parts.length === 0
      ? "This will permanently delete the note and all its content. This action cannot be undone."
      : `This will permanently delete the note. This also deletes ${parts.join(" and ")}. This action cannot be undone.`;
  return { text, ready: counts !== null };
}

/**
 * Confirmation for deleting the pages `ids` (none inside another, see
 * `outermostIds`) with their sub-pages. Same contract as useSubPageCounts.
 */
export function useDeleteNotesWarning(ids: readonly string[] | null): {
  title: string;
  text: string;
  ready: boolean;
} {
  const counts = useSubPageCounts(ids);
  const subPages = counts?.subPages ?? 0;
  const pages = (ids?.length ?? 0) + subPages;
  let detail = "";
  if (subPages === 1) detail += ", 1 of them a sub-page";
  else if (subPages > 1) detail += `, ${subPages} of them sub-pages`;
  if (counts?.otherFiles) {
    detail += `, and ${plural(counts.otherFiles, "other file")}`;
  }
  return {
    title: `Delete ${plural(pages, "page")}?`,
    text: `This will permanently delete ${plural(pages, "page")}${detail}. This action cannot be undone.`,
    ready: counts !== null,
  };
}

/** `ids` without those inside another of them: deleting a page takes its sub-pages. */
export function outermostIds(ids: Iterable<string>): string[] {
  const all = [...ids];
  return all.filter((id) => !all.some((other) => id.startsWith(`${other}/`)));
}
