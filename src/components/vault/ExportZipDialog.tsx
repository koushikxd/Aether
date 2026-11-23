import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui";

interface ExportZipDialogProps {
  title: string;
  description: string;
  /** Shown instead of the checkbox; the export then includes private pages. */
  privateWarning?: string;
  onExport: (includePrivate: boolean) => void;
  onClose: () => void;
}

/** Asks whether a zip export should include private pages, off by default. */
export function ExportZipDialog({
  title,
  description,
  privateWarning,
  onExport,
  onClose,
}: ExportZipDialogProps) {
  const [includePrivate, setIncludePrivate] = useState(false);
  const includeId = useId();

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {privateWarning ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            {privateWarning}
          </p>
        ) : (
          <label
            htmlFor={includeId}
            className="flex items-center gap-2 text-sm text-text cursor-pointer"
          >
            <input
              id={includeId}
              type="checkbox"
              className="size-4 accent-accent"
              checked={includePrivate}
              onChange={(e) => setIncludePrivate(e.target.checked)}
            />
            Include private pages (unencrypted)
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onExport(!!privateWarning || includePrivate)}
          >
            Export
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
