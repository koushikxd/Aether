import { useState } from "react";
import { useNotes } from "../../context/NotesContext";
import {
  errorMessage,
  importNotion,
  type NotionImportSummary,
} from "../../services/export";
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
import { PrivatePagePicker } from "../vault/PrivatePagePicker";

type Status =
  | { step: "ready"; error?: string }
  | { step: "importing"; current: number; total: number }
  | { step: "done"; summary: NotionImportSummary }
  | { step: "private"; summary: NotionImportSummary };

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function summaryText({ pages, images, files }: NotionImportSummary) {
  return `Imported ${count(pages, "page")}, ${count(images, "image")} and ${count(files, "file")}`;
}

interface NotionImportDialogProps {
  /** The zips of the export. */
  paths: string[];
  onClose: () => void;
}

export function NotionImportDialog({
  paths,
  onClose,
}: NotionImportDialogProps) {
  const { refreshNotes } = useNotes();
  const [status, setStatus] = useState<Status>({ step: "ready" });
  const importing = status.step === "importing";

  const handleImport = async () => {
    setStatus({ step: "importing", current: 0, total: 0 });
    try {
      const summary = await importNotion(paths, (current, total) =>
        setStatus((s) =>
          s.step === "importing" ? { step: "importing", current, total } : s,
        ),
      );
      setStatus({ step: "done", summary });
    } catch (error) {
      setStatus({
        step: "ready",
        error: errorMessage(error, "Failed to import the Notion export"),
      });
    }
    // A failed import can still have written some notes.
    await refreshNotes();
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !importing) onClose();
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {status.step === "private"
              ? "Select private pages"
              : "Import from Notion"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {status.step === "private"
              ? "Checked pages and their sub-pages are encrypted before they sync."
              : status.step === "done"
                ? summaryText(status.summary)
                : "Notes, images and files from a Notion HTML export."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {status.step === "private" ? (
          <PrivatePagePicker
            pageIds={status.summary.ids}
            onBack={() => setStatus({ ...status, step: "done" })}
            onDone={onClose}
          />
        ) : status.step === "done" ? (
          status.summary.skipped.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing was skipped.</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-text">
                Skipped items ({status.summary.skipped.length})
              </p>
              <ul className="max-h-60 overflow-y-auto space-y-1.5 text-sm">
                {status.summary.skipped.map((item, i) => (
                  <li key={i} className="rounded-md bg-bg-muted px-2.5 py-1.5">
                    <p className="font-mono text-2xs text-text-muted break-all">
                      {item.page}
                    </p>
                    <p className="text-text">{item.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <ul className="space-y-0.5 text-sm text-text">
              {paths.map((path) => (
                <li key={path} className="truncate" title={path}>
                  {path.split(/[\\/]/).pop()}
                </li>
              ))}
            </ul>
            {status.step === "importing" && (
              <output className="block text-sm text-text-muted">
                {status.total === 0
                  ? "Reading the export..."
                  : `Imported ${status.current} of ${status.total} pages`}
              </output>
            )}
            {status.step === "ready" && status.error && (
              <p className="text-sm text-red-500" role="alert">
                {status.error}
              </p>
            )}
          </div>
        )}

        {status.step !== "private" && (
          <AlertDialogFooter>
            {status.step === "done" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setStatus({ ...status, step: "private" })}
                >
                  Select private pages
                </Button>
                <AlertDialogAction>Done</AlertDialogAction>
              </>
            ) : (
              <>
                <AlertDialogCancel disabled={importing}>
                  Cancel
                </AlertDialogCancel>
                <Button onClick={handleImport} disabled={importing}>
                  {importing ? "Importing..." : "Import"}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
