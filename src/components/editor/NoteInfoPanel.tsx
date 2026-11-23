import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { IconButton, Tooltip } from "../ui";
import { CopyIcon, InfoIcon } from "../icons";
import { formatDateTime } from "../../lib/dates";
import * as notesService from "../../services/notes";

interface NoteInfoPanelProps {
  noteId: string;
  modified: number;
  /** Plain text of the note as edited right now, one line per block. */
  getText: () => string;
}

function countText(text: string) {
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    // Block breaks are not characters
    characters: text.replace(/\n/g, "").length,
  };
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className="text-text-muted whitespace-nowrap">{label}</dt>
      <dd className="text-text text-right">{value}</dd>
    </div>
  );
}

export function NoteInfoPanel({
  noteId,
  modified,
  getText,
}: NoteInfoPanelProps) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState({ words: 0, characters: 0 });
  const [created, setCreated] = useState<{ id: string; at: number } | null>(
    null,
  );
  const path = `${noteId}.md`;

  // The menu is modal, so the text cannot change while it is open.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setCounts(countText(getText()));
    notesService.getNoteInfo(noteId).then(
      (info) =>
        setCreated(
          info.created == null ? null : { id: noteId, at: info.created },
        ),
      () => setCreated(null),
    );
  };

  const copyPath = async () => {
    try {
      await invoke("copy_to_clipboard", { text: path });
      toast.success("Copied file path");
    } catch (error) {
      console.error("Failed to copy file path:", error);
      toast.error("Failed to copy file path");
    }
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <Tooltip content="Note info">
        <DropdownMenu.Trigger asChild>
          <IconButton aria-label="Note info">
            <InfoIcon className="w-4.25 h-4.25 stroke-[1.6]" />
          </IconButton>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="w-72 bg-bg border border-border rounded-md shadow-lg py-1 z-50 text-sm"
          sideOffset={5}
          align="end"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <dl className="px-3 py-1.5 flex flex-col gap-1.5">
            <Field label="Last modified" value={formatDateTime(modified)} />
            {created?.id === noteId && (
              <Field label="Created" value={formatDateTime(created.at)} />
            )}
            <Field label="Words" value={counts.words.toLocaleString()} />
            <Field
              label="Characters"
              value={counts.characters.toLocaleString()}
            />
          </dl>
          <DropdownMenu.Separator className="h-px bg-border my-1" />
          <DropdownMenu.Item
            className="px-3 py-1.5 text-text-muted cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
            onSelect={copyPath}
          >
            <span className="truncate flex-1" title={path}>
              {path}
            </span>
            <CopyIcon className="w-4 h-4 stroke-[1.6] shrink-0" />
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
