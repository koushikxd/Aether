import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useGit } from "./GitContext";
import { useNotesActions, useNotesData } from "./NotesContext";
import { errorMessage } from "../services/export";
import * as vault from "../services/vault";
import type { VaultStatus } from "../services/vault";
import {
  EnterKeyDialog,
  GenerateKeyDialog,
  MakePublicDialog,
  ShowKeyDialog,
} from "../components/vault/KeyDialogs";

type Dialog =
  | { kind: "generate"; key: string | null }
  | { kind: "enter" }
  | { kind: "show"; key: string }
  | { kind: "make-public"; id: string; title: string };

interface VaultContextValue {
  status: VaultStatus | null;
  /** Every private note id. */
  privateIds: Set<string>;
  /** The marked note ids; their sub-pages are private through them. */
  privateRoots: Set<string>;
  generateKey: () => Promise<void>;
  enterKey: () => void;
  showKey: () => Promise<void>;
  /** Marks `ids` private, first asking for a key when there is none or it is locked. */
  makePrivate: (ids: string[]) => Promise<boolean>;
  /** Asks for confirmation, then unmarks `id`. */
  makePublic: (id: string, title: string) => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const { notes, notesFolder } = useNotesData();
  const { refreshNotes } = useNotesActions();
  const { status: gitStatus } = useGit();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [generating, setGenerating] = useState(false);
  // Resolves the pending makePrivate once its key dialog closes.
  const keyWaiterRef = useRef<((ready: boolean) => void) | null>(null);

  // Decrypting after a sync writes notes, and a sync can bring vault blobs
  // without any note, so a notes or git status change can change the status.
  useEffect(() => {
    if (!notesFolder) return undefined;
    let cancelled = false;
    vault
      .getVaultStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error) => console.error("Failed to load vault status:", error));
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- notes and gitStatus are intentional refetch triggers: a sync or the backend's decrypt step can change the vault
  }, [notesFolder, notes, gitStatus]);

  const closeDialog = useCallback((keyReady: boolean) => {
    setDialog(null);
    keyWaiterRef.current?.(keyReady);
    keyWaiterRef.current = null;
  }, []);

  const generateKey = useCallback(async () => {
    setGenerating(true);
    try {
      const key = await vault.generateVaultKey();
      setDialog({ kind: "generate", key });
      setStatus(await vault.getVaultStatus());
    } catch (error) {
      toast.error(errorMessage(error, "Failed to generate a key"));
    } finally {
      setGenerating(false);
    }
  }, []);

  const enterKey = useCallback(() => setDialog({ kind: "enter" }), []);

  const showKey = useCallback(async () => {
    try {
      setDialog({ kind: "show", key: await vault.showVaultKey() });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to read the key"));
    }
  }, []);

  const unlock = useCallback(
    async (key: string): Promise<string | null> => {
      try {
        setStatus(await vault.enterVaultKey(key));
      } catch (error) {
        return errorMessage(error, "That key could not be checked");
      }
      closeDialog(true);
      await refreshNotes();
      return null;
    },
    [closeDialog, refreshNotes],
  );

  const setPrivate = useCallback(
    async (ids: string[], isPrivate: boolean): Promise<boolean> => {
      try {
        setStatus(await vault.setNotesPrivate(ids, isPrivate));
        return true;
      } catch (error) {
        toast.error(
          errorMessage(
            error,
            isPrivate ? "Failed to make private" : "Failed to make public",
          ),
        );
        return false;
      }
    },
    [],
  );

  const makePrivate = useCallback(
    async (ids: string[]): Promise<boolean> => {
      if (!status?.hasVault || !status.unlocked) {
        const keyReady = new Promise<boolean>((resolve) => {
          keyWaiterRef.current?.(false);
          keyWaiterRef.current = resolve;
        });
        setDialog(
          status?.hasVault
            ? { kind: "enter" }
            : { kind: "generate", key: null },
        );
        if (!(await keyReady)) return false;
      }
      return setPrivate(ids, true);
    },
    [status, setPrivate],
  );

  const makePublic = useCallback(
    (id: string, title: string) =>
      setDialog({ kind: "make-public", id, title }),
    [],
  );

  const privateIds = useMemo(() => new Set(status?.privateNoteIds), [status]);
  const privateRoots = useMemo(() => new Set(status?.privateRoots), [status]);

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      privateIds,
      privateRoots,
      generateKey,
      enterKey,
      showKey,
      makePrivate,
      makePublic,
    }),
    [
      status,
      privateIds,
      privateRoots,
      generateKey,
      enterKey,
      showKey,
      makePrivate,
      makePublic,
    ],
  );

  return (
    <VaultContext.Provider value={value}>
      {children}
      {dialog?.kind === "generate" && (
        <GenerateKeyDialog
          keyText={dialog.key}
          generating={generating}
          onGenerate={generateKey}
          onCancel={() => closeDialog(false)}
          onDone={() => closeDialog(true)}
        />
      )}
      {dialog?.kind === "enter" && (
        <EnterKeyDialog onUnlock={unlock} onCancel={() => closeDialog(false)} />
      )}
      {dialog?.kind === "show" && (
        <ShowKeyDialog
          keyText={dialog.key}
          onClose={() => closeDialog(false)}
        />
      )}
      {dialog?.kind === "make-public" && (
        <MakePublicDialog
          title={dialog.title}
          onCancel={() => closeDialog(false)}
          onConfirm={() => {
            closeDialog(false);
            void setPrivate([dialog.id], false);
          }}
        />
      )}
    </VaultContext.Provider>
  );
}

export function useVault() {
  const context = useContext(VaultContext);
  if (!context) throw new Error("useVault must be used within a VaultProvider");
  return context;
}
