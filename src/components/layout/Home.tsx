import type { ComponentType, MouseEvent } from "react";
import { useNotes } from "../../context/NotesContext";
import { useTabs } from "../../context/TabsContext";
import { NoteIcon, PlusIcon, SearchIcon } from "../icons";
import { formatRelative } from "../../lib/dates";
import { isWindows, mod, shift, shortcut } from "../../lib/platform";

const RECENT_COUNT = 5;

interface HomeProps {
  onOpenSearch?: () => void;
}

/** Shown in the editor area when no note is open. */
export function Home({ onOpenSearch }: HomeProps) {
  const { notes, createNote, selectNote } = useNotes();
  const { openInNewTab } = useTabs();
  // The notes list puts pinned pages first
  const byModified = [...notes];
  byModified.sort((a, b) => b.modified - a.modified);
  const recent = byModified.slice(0, RECENT_COUNT);

  const open = (id: string, event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) openInNewTab(id);
    else void selectNote(id);
  };

  return (
    <div data-home className="flex-1 flex flex-col bg-bg min-w-0">
      {!isWindows && <div className="h-11 shrink-0" data-tauri-drag-region />}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-md mx-auto px-6 pt-[16vh] pb-12 select-none">
          <h1 className="px-2 text-xl font-medium text-text tracking-[-0.01em]">
            What's on your mind?
          </h1>
          <p className="px-2 mt-1 text-sm text-text-muted">
            Pick up where you left off, or start something new.
          </p>

          <div className="mt-6 flex flex-col">
            <Row
              icon={PlusIcon}
              label="New note"
              hint={shortcut(mod, "N")}
              onClick={() => void createNote()}
            />
            {onOpenSearch && (
              <Row
                icon={SearchIcon}
                label="Search notes"
                hint={shortcut(mod, shift, "F")}
                onClick={onOpenSearch}
              />
            )}
          </div>

          {recent.length > 0 && (
            <section className="mt-8">
              <h2 className="px-2 mb-1 text-xs font-medium text-text-muted">
                Recent
              </h2>
              <ul aria-label="Recent pages" className="flex flex-col">
                {recent.map((note) => {
                  const slash = note.id.lastIndexOf("/");
                  return (
                    <li key={note.id}>
                      <Row
                        icon={NoteIcon}
                        label={note.title}
                        detail={
                          slash === -1
                            ? undefined
                            : note.id.slice(0, slash).split("/").join(" / ")
                        }
                        hint={formatRelative(note.modified)}
                        onClick={(event) => open(note.id, event)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Muted text after the label, such as the parent page's path. */
  detail?: string;
  /** Right-aligned muted text: a shortcut or a time. */
  hint: string;
  onClick: (event: MouseEvent) => void;
}

function Row({ icon: Icon, label, detail, hint, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full h-8 flex items-center gap-2.5 px-2 rounded-md text-sm text-text text-left hover:bg-bg-muted focus-visible:outline focus-visible:outline-accent cursor-pointer transition-colors"
    >
      <Icon className="w-4 h-4 stroke-[1.6] text-text-muted shrink-0" />
      <span className="truncate">{label}</span>
      {detail && (
        <span className="truncate text-text-muted/70 min-w-0">{detail}</span>
      )}
      <span className="ml-auto pl-3 shrink-0 text-xs text-text-muted/70 tabular-nums">
        {hint}
      </span>
    </button>
  );
}
