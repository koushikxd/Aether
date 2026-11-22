import { useId, useState } from "react";
import type {
  ConflictChunk,
  ConflictFile,
  ConflictResolution,
} from "../../services/git";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "../ui";
import { CheckIcon, LockIcon } from "../icons";
import { cn } from "../../lib/utils";

type Pick = "ours" | "theirs" | "both";
type ConflictPart = Extract<ConflictChunk, { kind: "conflict" }>;

export interface ResolvedFile {
  path: string;
  resolution: ConflictResolution;
}

interface Draft {
  /** The pick of each conflict, by chunk index. */
  picks: Partial<Record<number, Pick>>;
  result: string;
  /** The user typed in the result since the last pick. */
  edited: boolean;
  /** What Save stored. For pick-only files, the kept side. */
  saved: ConflictResolution | null;
}

type Confirm =
  | { kind: "cancel" }
  | { kind: "replace"; index: number; pick: Pick };

const PICKS: [Pick, string][] = [
  ["ours", "This device"],
  ["theirs", "Other device"],
  ["both", "Both"],
];

// Context longer than this shows only its first and last lines
const COLLAPSE_OVER = 8;
const EDGE_LINES = 3;

const codeText = "whitespace-pre-wrap break-words font-mono text-xs";

function pickText(chunk: ConflictPart, pick: Pick | undefined): string {
  if (pick === "ours") return chunk.ours;
  if (pick === "theirs") return chunk.theirs;
  if (pick === undefined) return "";
  // The last line of a file can lack its newline
  return chunk.ours && !chunk.ours.endsWith("\n")
    ? `${chunk.ours}\n${chunk.theirs}`
    : chunk.ours + chunk.theirs;
}

function buildResult(chunks: ConflictChunk[], picks: Draft["picks"]): string {
  return chunks
    .map((chunk, i) =>
      chunk.kind === "same" ? chunk.text : pickText(chunk, picks[i]),
    )
    .join("");
}

/** The saved resolution, unless the result changed after saving. */
function resolutionOf(draft: Draft): ConflictResolution | null {
  const { saved } = draft;
  return saved?.kind === "text" && saved.content !== draft.result
    ? null
    : saved;
}

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return {
    name: path.slice(slash + 1).replace(/\.md$/, ""),
    folder: slash < 0 ? "" : path.slice(0, slash),
  };
}

function SameChunk({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.replace(/\n$/, "").split("\n");
  const className = cn(codeText, "px-3 text-text-muted/70");
  if (expanded || lines.length <= COLLAPSE_OVER) {
    return <pre className={className}>{lines.join("\n")}</pre>;
  }
  return (
    <div>
      <pre className={className}>{lines.slice(0, EDGE_LINES).join("\n")}</pre>
      <Button
        variant="link"
        size="xs"
        className="px-3"
        onClick={() => setExpanded(true)}
      >
        Show {lines.length - 2 * EDGE_LINES} more lines
      </Button>
      <pre className={className}>{lines.slice(-EDGE_LINES).join("\n")}</pre>
    </div>
  );
}

function Side({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <p className="mb-1.5 text-xs font-medium text-text-muted">{label}</p>
      {text ? (
        <pre className={cn(codeText, "text-text")}>{text}</pre>
      ) : (
        <p className="text-xs italic text-text-muted">Empty</p>
      )}
    </div>
  );
}

interface ConflictCardProps {
  number: number;
  chunk: ConflictPart;
  pick: Pick | undefined;
  onPick: (pick: Pick) => void;
}

function ConflictCard({ number, chunk, pick, onPick }: ConflictCardProps) {
  return (
    <fieldset
      aria-label={`Conflict ${number}`}
      className="min-w-0 overflow-hidden rounded-lg border border-border"
    >
      <div className="grid grid-cols-2 divide-x divide-border">
        <Side label="This device" text={chunk.ours} />
        <Side label="Other device" text={chunk.theirs} />
      </div>
      <div className="flex gap-1.5 border-t border-border bg-bg-secondary px-3 py-2">
        {PICKS.map(([value, label]) => (
          <Button
            key={value}
            size="xs"
            variant={pick === value ? "primary" : "outline"}
            aria-pressed={pick === value}
            onClick={() => onPick(value)}
          >
            {label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

function sideStatus(deleted: boolean, device: string): string {
  return `${deleted ? "Deleted" : "Changed"} on ${device}`;
}

interface MergeEditorProps {
  /** The conflicting files; never empty. */
  files: ConflictFile[];
  /** Resolves every file and finishes the merge. Returns an error message on failure. */
  onFinish: (resolved: ResolvedFile[]) => Promise<string | null>;
  /** Aborts the merge. Returns an error message on failure. */
  onCancel: () => Promise<string | null>;
}

export function MergeEditor({ files, onFinish, onCancel }: MergeEditorProps) {
  const resultId = useId();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      files.map((f) => [
        f.path,
        {
          picks: {},
          result: buildResult(f.chunks, {}),
          edited: false,
          saved: null,
        },
      ]),
    ),
  );
  const [selected, setSelected] = useState(files[0].path);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const file = files.find((f) => f.path === selected) ?? files[0];
  const draft = drafts[file.path];
  const resolved = files.flatMap((f) => {
    const resolution = resolutionOf(drafts[f.path]);
    return resolution ? [{ path: f.path, resolution }] : [];
  });
  const isResolved = (path: string) => resolved.some((r) => r.path === path);
  const allPicked = file.chunks.every(
    (chunk, i) => chunk.kind === "same" || draft.picks[i],
  );
  const canSave = !isResolved(file.path) && (draft.edited || allPicked);
  const kept = draft.saved?.kind === "text" ? undefined : draft.saved?.kind;

  const update = (patch: Partial<Draft>) =>
    setDrafts((all) => ({
      ...all,
      [file.path]: { ...all[file.path], ...patch },
    }));

  const applyPick = (index: number, pick: Pick) => {
    const picks = { ...draft.picks, [index]: pick };
    update({ picks, result: buildResult(file.chunks, picks), edited: false });
  };

  const save = () => {
    update({ saved: { kind: "text", content: draft.result } });
    const next = files.find((f) => f.path !== file.path && !isResolved(f.path));
    if (next) setSelected(next.path);
  };

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    // On success the merge is over and this editor unmounts
    const failure = await action();
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <AlertDialog open>
        <AlertDialogContent
          className="flex h-[calc(100vh-6rem)] max-h-190 w-[calc(100vw-4rem)] max-w-5xl flex-col gap-0 p-0"
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <AlertDialogHeader className="border-b border-border px-5 py-4">
            <AlertDialogTitle>Resolve conflicts</AlertDialogTitle>
            <AlertDialogDescription>
              These notes changed on this device and on another one. Pick what
              to keep in each.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex min-h-0 flex-1">
            <ul
              aria-label="Conflicting notes"
              className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2"
            >
              {files.map((f) => {
                const { name, folder } = splitPath(f.path);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(f.path)}
                      aria-current={f.path === file.path}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left",
                        f.path === file.path
                          ? "bg-bg-muted"
                          : "hover:bg-bg-muted",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 text-sm font-medium text-text">
                          <span className="truncate">{name}</span>
                          {f.isPrivate && (
                            <>
                              <LockIcon className="w-3.5 h-3.5 shrink-0 text-text-muted" />
                              <span className="sr-only">Private</span>
                            </>
                          )}
                        </span>
                        {folder && (
                          <span className="block truncate text-xs text-text-muted">
                            {folder}
                          </span>
                        )}
                      </span>
                      {isResolved(f.path) && (
                        <>
                          <CheckIcon className="h-4 w-4 shrink-0 text-text-muted" />
                          <span className="sr-only">Resolved</span>
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div key={file.path} className="min-w-0 flex-1 overflow-y-auto p-5">
              {file.pickOnly ? (
                <div className="space-y-3">
                  <p className="text-sm text-text-muted">
                    {file.oursDeleted || file.theirsDeleted
                      ? "It was deleted on one device and changed on the other."
                      : "This file can't be combined."}{" "}
                    Pick the version to keep.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {(["ours", "theirs"] as const).map((side) => (
                      <button
                        key={side}
                        type="button"
                        aria-pressed={kept === side}
                        onClick={() => update({ saved: { kind: side } })}
                        className={cn(
                          "cursor-pointer rounded-lg border p-4 text-left",
                          kept === side
                            ? "border-accent bg-bg-muted"
                            : "border-border hover:bg-bg-muted",
                        )}
                      >
                        <span className="block text-sm font-medium text-text">
                          {side === "ours"
                            ? "Keep this device's version"
                            : "Keep other device's version"}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {side === "ours"
                            ? sideStatus(file.oursDeleted, "this device")
                            : sideStatus(
                                file.theirsDeleted,
                                "the other device",
                              )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <section aria-label="Changes" className="space-y-3">
                    {file.chunks.map((chunk, i) => {
                      if (chunk.kind === "same") {
                        return <SameChunk key={i} text={chunk.text} />;
                      }
                      return (
                        <ConflictCard
                          key={i}
                          number={
                            file.chunks
                              .slice(0, i)
                              .filter((c) => c.kind === "conflict").length + 1
                          }
                          chunk={chunk}
                          pick={draft.picks[i]}
                          onPick={(pick) =>
                            draft.edited
                              ? setConfirm({ kind: "replace", index: i, pick })
                              : applyPick(i, pick)
                          }
                        />
                      );
                    })}
                  </section>
                  <div className="mt-5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor={resultId}
                        className="text-sm font-medium text-text"
                      >
                        Result
                      </label>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!canSave}
                        onClick={save}
                      >
                        Save
                      </Button>
                    </div>
                    <textarea
                      id={resultId}
                      value={draft.result}
                      onChange={(e) =>
                        update({ result: e.target.value, edited: true })
                      }
                      spellCheck={false}
                      className={cn(
                        codeText,
                        "min-h-60 w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-text",
                        "focus-visible:border-accent focus-visible:outline-none",
                      )}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 border-t border-border px-5 py-3">
            {error && (
              <p
                role="alert"
                className="min-w-0 break-words text-sm text-red-500"
              >
                {error}
              </p>
            )}
            <div className="ml-auto flex shrink-0 gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setConfirm({ kind: "cancel" })}
              >
                Cancel sync
              </Button>
              <Button
                variant="primary"
                disabled={busy || resolved.length < files.length}
                onClick={() => void run(() => onFinish(resolved))}
              >
                Finish merge
              </Button>
            </div>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {confirm && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
        >
          <AlertDialogContent>
            {confirm.kind === "replace" ? (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Replace your edits?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Changing a pick rebuilds the result from your picks.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep my edits</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => applyPick(confirm.index, confirm.pick)}
                  >
                    Replace
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            ) : (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel sync?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your notes go back to how they were before the sync. The
                    other device's changes stay on the remote.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep resolving</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void run(onCancel)}>
                    Cancel sync
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            )}
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
