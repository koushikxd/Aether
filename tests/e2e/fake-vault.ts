// Fake vault_* commands (private pages). Wired into fake-backend.ts.
import type { FakeFiles } from "./fake-backend";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

export interface FakeContext {
  files: FakeFiles;
  writeFile: (path: string, content: string) => void;
  createBarePageFile: (id: string) => void;
}

/** A notes folder with a vault, set as `window.aetherFakeVault` before boot. */
export interface FakeVaultSeed {
  key: string;
  /** This device has the key. */
  unlocked: boolean;
  privateRoots?: string[];
  /** Private files a locked device cannot read; written when the key is entered. */
  lockedFiles?: FakeFiles;
  /** The vault arrives with the first pull, as when another device made it. */
  arrivesOnPull?: boolean;
}

declare global {
  interface Window {
    /** No seed: the folder has no vault. */
    aetherFakeVault?: FakeVaultSeed;
  }
}

const FAKE_KEY = "aether-key-Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";

export function vaultHandlers(ctx: FakeContext): Record<string, Handler> {
  const seed = window.aetherFakeVault;
  let key = seed?.arrivesOnPull ? null : (seed?.key ?? null);
  let unlocked = seed?.unlocked ?? false;
  let lockedFiles: FakeFiles = unlocked ? {} : { ...seed?.lockedFiles };
  let roots = [...(seed?.privateRoots ?? [])];

  const status = () => {
    const ids = Object.keys(ctx.files)
      .filter((path) => path.endsWith(".md"))
      .map((path) => path.slice(0, -3));
    return {
      hasVault: key !== null,
      unlocked,
      lockedCount: Object.keys(lockedFiles).length,
      privateRoots: roots,
      privateNoteIds: ids.filter((id) =>
        roots.some((root) => id === root || id.startsWith(`${root}/`)),
      ),
    };
  };

  const ok = { success: true, message: null, error: null };
  let pulled = false;
  const remote: Record<string, Handler> = {
    git_is_available: () => true,
    git_get_status: () => ({
      isRepo: true,
      hasRemote: true,
      hasUpstream: true,
      remoteUrl: "https://github.com/me/notes.git",
      changedCount: 0,
      aheadCount: 0,
      behindCount: pulled ? 0 : 1,
      currentBranch: "main",
      error: null,
    }),
    git_pull: () => {
      pulled = true;
      key = seed?.key ?? null;
      return { ...ok, message: "Pulled" };
    },
    git_push: () => ok,
    git_conflicts: () => [],
  };

  return {
    ...(seed?.arrivesOnPull ? remote : {}),
    vault_status: status,
    vault_generate_key: () => {
      if (key !== null) return Promise.reject("This folder already has a key");
      key = FAKE_KEY;
      unlocked = true;
      return key;
    },
    vault_enter_key: (args) => {
      if (args.key !== key) {
        return Promise.reject(
          "That key does not match this folder's private pages",
        );
      }
      unlocked = true;
      for (const [path, content] of Object.entries(lockedFiles)) {
        ctx.writeFile(path, content);
      }
      lockedFiles = {};
      return status();
    },
    vault_show_key: () =>
      unlocked
        ? key
        : Promise.reject("This device does not have the key. Enter it first"),
    vault_set_private: (args) => {
      if (!unlocked) return Promise.reject("Generate or enter a key first");
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
      if (args.isPrivate) ids.forEach(ctx.createBarePageFile);
      roots = args.isPrivate
        ? [...new Set([...roots, ...ids])]
        : roots.filter((root) => !ids.includes(root));
      return status();
    },
  };
}
