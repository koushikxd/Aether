import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useNotes } from "../../context/NotesContext";
import { cleanTitle } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  CommandItem,
  Input,
} from "../ui";
import { ArrowUpToLineIcon, NoteIcon } from "../icons";

interface Target {
  /** The parent page id handed to `move_note`, "" for the top level. */
  id: string;
  label: string;
  parentPath?: string;
}

const TOP_LEVEL: Target = { id: "", label: "Top level" };

const parentOf = (id: string) =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";

/** Opens on the `open-move-picker` window event and moves its pages to the picked page. */
export function MovePageDialog() {
  const { notes, moveNote } = useNotes();
  const [ids, setIds] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: unknown = e.detail;
      if (
        typeof detail !== "object" ||
        detail === null ||
        !("ids" in detail) ||
        !Array.isArray(detail.ids)
      ) {
        return;
      }
      const picked = detail.ids.filter(
        (id): id is string => typeof id === "string",
      );
      if (picked.length === 0) return;
      setIds(picked);
      setQuery("");
      setSelectedIndex(0);
    };
    window.addEventListener("open-move-picker", handler);
    return () => window.removeEventListener("open-move-picker", handler);
  }, []);

  const targets = useMemo<Target[]>(() => {
    if (!ids) return [];
    // A page cannot go into itself or its sub-pages, and a target every
    // page already sits in would move nothing
    const allowed = (target: string) =>
      !ids.every((id) => parentOf(id) === target) &&
      !ids.some((id) => target === id || target.startsWith(`${id}/`));
    const pages = notes
      .filter((note) => allowed(note.id))
      .map((note) => ({
        id: note.id,
        label: cleanTitle(note.title),
        parentPath: parentOf(note.id).split("/").join(" / ") || undefined,
      }));
    const all = allowed("") ? [TOP_LEVEL, ...pages] : pages;
    const lower = query.trim().toLowerCase();
    if (!lower) return all;
    return all.filter((target) =>
      `${target.label} ${target.parentPath ?? ""}`
        .toLowerCase()
        .includes(lower),
    );
  }, [ids, notes, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const close = useCallback(() => setIds(null), []);

  const moveTo = useCallback(
    async (target: string) => {
      if (!ids) return;
      setIds(null);
      for (const id of ids) {
        if (parentOf(id) !== target) await moveNote(id, target);
      }
      if (target) {
        window.dispatchEvent(
          new CustomEvent("expand-folder", { detail: target }),
        );
      }
    },
    [ids, moveNote],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.min(i + 1, targets.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          const target = targets[selectedIndex];
          if (target) void moveTo(target.id);
          break;
        }
      }
    },
    [targets, selectedIndex, moveTo],
  );

  return (
    <AlertDialog open={ids !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent
        data-move-picker
        aria-describedby={undefined}
        // AlertDialog focuses its Cancel button by default, and this has none
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        className="max-w-lg gap-3 p-4"
      >
        <AlertDialogTitle className="text-base font-medium text-text">
          {ids && ids.length > 1 ? `Move ${ids.length} pages to` : "Move to"}
        </AlertDialogTitle>
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search pages..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div ref={listRef} className="max-h-80 overflow-y-auto space-y-0.5">
          {targets.length === 0 ? (
            <div className="text-sm font-medium opacity-50 text-text-muted p-2">
              No pages found
            </div>
          ) : (
            targets.map((target, i) => (
              <div key={target.id} data-index={i}>
                <CommandItem
                  label={target.label}
                  subtitle={target.parentPath}
                  icon={
                    target.id ? (
                      <NoteIcon className="w-4.5 h-4.5 stroke-[1.5]" />
                    ) : (
                      <ArrowUpToLineIcon className="w-4.5 h-4.5 stroke-[1.5]" />
                    )
                  }
                  isSelected={selectedIndex === i}
                  onClick={() => void moveTo(target.id)}
                />
              </div>
            ))
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
