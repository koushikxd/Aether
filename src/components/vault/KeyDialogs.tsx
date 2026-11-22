import { useId, useRef, useState, type FormEvent } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  CodeCopyButton,
  Input,
} from "../ui";

function KeyBox({ keyText }: { keyText: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-bg-muted p-2.5">
      <code
        data-vault-key
        className="flex-1 font-mono text-xs text-text break-all select-text"
      >
        {keyText}
      </code>
      <CodeCopyButton text={keyText} className="shrink-0" />
    </div>
  );
}

interface GenerateKeyDialogProps {
  /** Null until the key is generated. */
  keyText: string | null;
  generating: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  onDone: () => void;
}

export function GenerateKeyDialog({
  keyText,
  generating,
  onGenerate,
  onCancel,
  onDone,
}: GenerateKeyDialogProps) {
  const [saved, setSaved] = useState(false);
  const savedId = useId();

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Once the key exists, only Done closes the dialog.
        if (!open && keyText === null && !generating) onCancel();
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {keyText === null ? "Private pages need a key" : "Your key"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {keyText === null
              ? "Private pages are encrypted with a key before they sync. Generate one to continue."
              : "Store this key somewhere safe, like a password manager. Without it, private pages cannot be opened on another device or recovered."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {keyText !== null && (
          <>
            <KeyBox keyText={keyText} />
            <label
              htmlFor={savedId}
              className="flex items-center gap-2 text-sm text-text cursor-pointer"
            >
              <input
                id={savedId}
                type="checkbox"
                className="size-4 accent-accent"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
              />
              I saved this key somewhere safe
            </label>
          </>
        )}
        <AlertDialogFooter>
          {keyText === null ? (
            <>
              <AlertDialogCancel disabled={generating}>
                Cancel
              </AlertDialogCancel>
              <Button onClick={onGenerate} disabled={generating}>
                {generating ? "Generating..." : "Generate key"}
              </Button>
            </>
          ) : (
            <Button onClick={onDone} disabled={!saved}>
              Done
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface EnterKeyDialogProps {
  /** Resolves to the error to show, or null once the key is accepted. */
  onUnlock: (key: string) => Promise<string | null>;
  onCancel: () => void;
}

export function EnterKeyDialog({ onUnlock, onCancel }: EnterKeyDialogProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const keyId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setUnlocking(true);
    setError(await onUnlock(key.trim()));
    setUnlocking(false);
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !unlocking) onCancel();
      }}
    >
      <AlertDialogContent
        className="max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <form onSubmit={handleSubmit} className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Enter key</AlertDialogTitle>
            <AlertDialogDescription>
              Paste the key from the device where you set up private pages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <label htmlFor={keyId} className="text-sm font-medium text-text">
              Key
            </label>
            <Input
              ref={inputRef}
              id={keyId}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="aether-key-..."
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlocking}>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={unlocking || !key.trim()}>
              {unlocking ? "Unlocking..." : "Unlock"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ShowKeyDialog({
  keyText,
  onClose,
}: {
  keyText: string;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Your key</AlertDialogTitle>
          <AlertDialogDescription>
            Enter this key on another device to open your private pages there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <KeyBox keyText={keyText} />
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface MakePublicDialogProps {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MakePublicDialog({
  title,
  onConfirm,
  onCancel,
}: MakePublicDialogProps) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Make "{title}" public?</AlertDialogTitle>
          <AlertDialogDescription>
            Its contents will be pushed to GitHub unencrypted on the next
            commit.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button onClick={onConfirm}>Make public</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
