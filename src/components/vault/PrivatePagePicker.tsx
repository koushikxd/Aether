import { memo, useCallback, useMemo, useState } from "react";
import { useNotesData } from "../../context/NotesContext";
import { useVault } from "../../context/VaultContext";
import { cleanTitle } from "../../lib/utils";
import type { NoteMetadata } from "../../types/note";
import { ChevronDownIcon, ChevronRightIcon } from "../icons";
import { AlertDialogFooter, Button, Input } from "../ui";

interface PageNode {
  id: string;
  title: string;
  children: PageNode[];
}

/** The notes under `folder`, each under its nearest ancestor page. */
function buildTree(notes: NoteMetadata[], folder: string): PageNode[] {
  const nodes = new Map<string, PageNode>();
  for (const note of notes) {
    if (note.id.startsWith(`${folder}/`)) {
      nodes.set(note.id, {
        id: note.id,
        title: cleanTitle(note.title),
        children: [],
      });
    }
  }
  const roots: PageNode[] = [];
  for (const node of nodes.values()) {
    let parent: PageNode | undefined;
    for (
      let at = node.id.lastIndexOf("/");
      !parent && at > folder.length;
      at = node.id.lastIndexOf("/", at - 1)
    ) {
      parent = nodes.get(node.id.slice(0, at));
    }
    (parent?.children ?? roots).push(node);
  }
  const sort = (list: PageNode[]) => {
    list.sort((a, b) => a.title.localeCompare(b.title));
    list.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

/** Ids of the pages matching `query` and of their ancestors. */
function matchingIds(roots: PageNode[], query: string): Set<string> {
  const ids = new Set<string>();
  const visit = (node: PageNode): boolean => {
    const childMatches = node.children.map(visit).some(Boolean);
    const matches = childMatches || node.title.toLowerCase().includes(query);
    if (matches) ids.add(node.id);
    return matches;
  };
  roots.forEach(visit);
  return ids;
}

interface RowProps {
  node: PageNode;
  depth: number;
  /** An ancestor is checked, which covers this page. */
  covered: boolean;
  checked: Set<string>;
  expanded: Set<string>;
  /** While searching: the pages to show, all expanded. */
  visible: Set<string> | null;
  onCheck: (id: string, checked: boolean) => void;
  onToggle: (id: string) => void;
}

const PickerRow = memo(function PickerRow({
  node,
  depth,
  covered,
  checked,
  expanded,
  visible,
  onCheck,
  onToggle,
}: RowProps) {
  if (visible && !visible.has(node.id)) return null;
  const isChecked = covered || checked.has(node.id);
  const open = visible !== null || expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <div
        className="flex items-center gap-1.5 py-1 pr-2 rounded-md hover:bg-bg-muted"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`}
            aria-expanded={open}
            disabled={visible !== null}
            onClick={() => onToggle(node.id)}
            className="shrink-0 rounded-sm hover:bg-bg-emphasis cursor-pointer disabled:cursor-default"
          >
            {open ? (
              <ChevronDownIcon className="w-4 h-4 stroke-[1.6] text-text-muted/60" />
            ) : (
              <ChevronRightIcon className="w-4 h-4 stroke-[1.6] text-text-muted/60" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <label className="flex flex-1 min-w-0 items-center gap-2 text-sm text-text cursor-pointer has-[:disabled]:cursor-default">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-accent"
            checked={isChecked}
            disabled={covered}
            onChange={(e) => onCheck(node.id, e.target.checked)}
          />
          <span className="truncate">{node.title}</span>
        </label>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((child) => (
            <PickerRow
              key={child.id}
              node={child}
              depth={depth + 1}
              covered={isChecked}
              checked={checked}
              expanded={expanded}
              visible={visible}
              onCheck={onCheck}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

interface PrivatePagePickerProps {
  /** The import folder whose pages are offered. */
  folder: string;
  onBack: () => void;
  onDone: () => void;
}

export function PrivatePagePicker({
  folder,
  onBack,
  onDone,
}: PrivatePagePickerProps) {
  const { notes } = useNotesData();
  const { makePrivate } = useVault();
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);

  const roots = useMemo(() => buildTree(notes, folder), [notes, folder]);
  const search = query.trim().toLowerCase();
  const visible = useMemo(
    () => (search ? matchingIds(roots, search) : null),
    [roots, search],
  );

  // The top-most checked pages, and how many pages they cover.
  const { ids, covered } = useMemo(() => {
    const top: string[] = [];
    let count = 0;
    const countAll = (node: PageNode): number =>
      node.children.reduce((sum, child) => sum + countAll(child), 1);
    const visit = (node: PageNode) => {
      if (checked.has(node.id)) {
        top.push(node.id);
        count += countAll(node);
      } else {
        node.children.forEach(visit);
      }
    };
    roots.forEach(visit);
    return { ids: top, covered: count };
  }, [roots, checked]);

  const handleCheck = useCallback((id: string, isChecked: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (isChecked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleToggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleMakePrivate = async () => {
    setSaving(true);
    const done = await makePrivate(ids);
    setSaving(false);
    if (done) onDone();
  };

  return (
    <>
      <div className="space-y-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages"
          className="h-8"
        />
        <ul className="max-h-72 overflow-y-auto">
          {roots.map((node) => (
            <PickerRow
              key={node.id}
              node={node}
              depth={0}
              covered={false}
              checked={checked}
              expanded={expanded}
              visible={visible}
              onCheck={handleCheck}
              onToggle={handleToggle}
            />
          ))}
        </ul>
        {visible?.size === 0 && (
          <p className="text-sm text-text-muted">No pages match.</p>
        )}
      </div>
      <AlertDialogFooter>
        <Button variant="outline" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button
          onClick={handleMakePrivate}
          disabled={saving || ids.length === 0}
        >
          {covered === 1
            ? "Make 1 page private"
            : `Make ${covered} pages private`}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
