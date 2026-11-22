// Fake git conflict commands (merge editor). Wired into fake-backend.ts.
import type { ConflictFile, GitResult } from "../../src/services/git";
import type { FakeContext } from "./fake-vault";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

/** A repo with a remote whose next pull conflicts on `files`. */
export interface FakeConflicts {
  files: ConflictFile[];
  /** The folder is already mid-merge when it opens. */
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
  let merging = seed.midMerge ?? false;
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
      behindCount: merging ? 0 : 1,
      currentBranch: "main",
      error: null,
    }),
    git_pull: (): GitResult => {
      merging = true;
      return {
        success: false,
        message: null,
        error: "CONFLICT (content): Merge conflict in notes",
      };
    },
    git_conflicts: () => (merging ? seed.files : []),
    git_resolve_conflict: () => null,
    git_finish_merge: () => {
      merging = false;
      ahead = 1;
      return OK;
    },
    git_abort_merge: () => {
      merging = false;
      return OK;
    },
    git_push: () => {
      ahead = 0;
      return OK;
    },
  };
}
