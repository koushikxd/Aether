import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteMetadata, FolderNode } from "../types/note";

export interface FolderTreeData {
  rootNotes: NoteMetadata[];
  folders: FolderNode[];
  /**
   * Sub-page folders by the id of their page: `Page/` next to `Page.md`.
   * They show under the page's note, not as folders of their own.
   */
  subPages: Map<string, FolderNode>;
}

export function buildFolderTree(
  notes: NoteMetadata[],
  pinnedIds: Set<string>,
  knownFolders?: string[],
): FolderTreeData {
  const rootNotes: NoteMetadata[] = [];
  const folderMap = new Map<string, FolderNode>();

  function ensureFolder(path: string): FolderNode {
    const existing = folderMap.get(path);
    if (existing) return existing;

    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const node: FolderNode = { name, path, children: [], notes: [] };
    folderMap.set(path, node);

    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = ensureFolder(parentPath);
      if (!parent.children.some((c) => c.path === path)) {
        parent.children.push(node);
      }
    }

    return node;
  }

  // Ensure all known disk folders exist in the tree (even if empty)
  if (knownFolders) {
    for (const folderPath of knownFolders) {
      ensureFolder(folderPath);
    }
  }

  for (const note of notes) {
    const lastSlash = note.id.lastIndexOf("/");
    if (lastSlash === -1) {
      rootNotes.push(note);
    } else {
      const folderPath = note.id.substring(0, lastSlash);
      const folder = ensureFolder(folderPath);
      folder.notes.push(note);
    }
  }

  const noteIds = new Set(notes.map((note) => note.id));
  const subPages = new Map<string, FolderNode>();
  for (const folder of folderMap.values()) {
    if (noteIds.has(folder.path)) subPages.set(folder.path, folder);
  }

  for (const node of folderMap.values()) {
    node.children = node.children.filter((c) => !subPages.has(c.path));
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.notes.sort((a, b) => {
      const ap = pinnedIds.has(a.id);
      const bp = pinnedIds.has(b.id);
      if (ap !== bp) return ap ? -1 : 1;
      return b.modified - a.modified;
    });
  }

  const topLevelFolders = Array.from(folderMap.values()).filter(
    (f) => !f.path.includes("/") && !subPages.has(f.path),
  );
  topLevelFolders.sort((a, b) => a.name.localeCompare(b.name));

  // Sort root notes: pinned first, then by modified desc
  rootNotes.sort((a, b) => {
    const ap = pinnedIds.has(a.id);
    const bp = pinnedIds.has(b.id);
    if (ap !== bp) return ap ? -1 : 1;
    return b.modified - a.modified;
  });

  return { rootNotes, folders: topLevelFolders, subPages };
}

export type TreeItem =
  | { type: "note"; id: string }
  | { type: "folder"; path: string };

/** Build a flat list of visible tree items in DFS order (for keyboard navigation). */
export function getVisibleItems(
  tree: FolderTreeData,
  pinnedIds: Set<string>,
  collapsedFolders: Set<string>,
): TreeItem[] {
  const items: TreeItem[] = [];

  // Recursive DFS; a page's sub-pages follow it while it is expanded
  function walkNote(id: string) {
    items.push({ type: "note", id });
    const subPages = tree.subPages.get(id);
    if (subPages && !collapsedFolders.has(id)) walkContents(subPages);
  }
  function walkFolder(folder: FolderNode) {
    items.push({ type: "folder", path: folder.path });
    if (!collapsedFolders.has(folder.path)) walkContents(folder);
  }
  function walkContents(folder: FolderNode) {
    folder.children.forEach(walkFolder);
    for (const note of folder.notes) walkNote(note.id);
  }

  // Pinned root notes first
  for (const note of tree.rootNotes) {
    if (pinnedIds.has(note.id)) walkNote(note.id);
  }
  tree.folders.forEach(walkFolder);
  for (const note of tree.rootNotes) {
    if (!pinnedIds.has(note.id)) walkNote(note.id);
  }

  return items;
}

export function countNotesInFolder(folder: FolderNode): number {
  let count = folder.notes.length;
  for (const child of folder.children) {
    count += countNotesInFolder(child);
  }
  return count;
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
