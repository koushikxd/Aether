// Fake git conflict commands (merge editor). Wired into fake-backend.ts.
import type { ConflictFile, GitResult } from "../../src/services/git";
import type { FakeContext } from "./fake-vault";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

/** A repo with a remote whose next pull conflicts on `files`. */
export interface FakeConflicts {
  files: ConflictFile[];
  /** Mid-merge: when the folder opens, or once a test sets it, as an agent sync does. */
  midMerge?: boolean;
}

declare global {
  interface Window {
    aetherFakeConflicts?: FakeConflicts;
  }
}

const OK: GitResult = { success: true, message: null, error: null };

export function mergeHandlers(_ctx: FakeContext): Record<string, Handler> {
  const seed = window.aetherFakeConflicts;
  if (!seed) return {};
  let ahead = 0;
  return {
    git_is_available: () => true,
    git_get_status: () => ({
      isRepo: true,
      hasRemote: true,
      hasUpstream: true,
      remoteUrl: "https://github.com/me/notes.git",
      changedCount: 0,
      aheadCount: ahead,
      behindCount: seed.midMerge ? 0 : 1,
      currentBranch: "main",
      error: null,
    }),
    git_pull: (): GitResult => {
      seed.midMerge = true;
      return {
        success: false,
        message: null,
        error: "CONFLICT (content): Merge conflict in notes",
      };
    },
    git_conflicts: () => (seed.midMerge ? seed.files : []),
    git_resolve_conflict: () => null,
    git_finish_merge: () => {
      seed.midMerge = false;
      ahead = 1;
      return OK;
    },
    git_abort_merge: () => {
      seed.midMerge = false;
      return OK;
    },
    git_push: () => {
      ahead = 0;
      return OK;
    },
  };
}
