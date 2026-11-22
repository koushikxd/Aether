import { invoke } from "@tauri-apps/api/core";

export interface GitStatus {
  isRepo: boolean;
  hasRemote: boolean;
  hasUpstream: boolean;
  remoteUrl: string | null;
  changedCount: number;
  aheadCount: number;
  behindCount: number;
  currentBranch: string | null;
  error: string | null;
}

export interface GitResult {
  success: boolean;
  message: string | null;
  error: string | null;
}

export async function isGitAvailable(): Promise<boolean> {
  return invoke("git_is_available");
}

export async function getGitStatus(): Promise<GitStatus> {
  return invoke("git_get_status");
}

export async function initGitRepo(): Promise<void> {
  return invoke("git_init_repo");
}

export async function gitCommit(message: string): Promise<GitResult> {
  return invoke("git_commit", { message });
}

export async function gitPush(): Promise<GitResult> {
  return invoke("git_push");
}

export async function gitFetch(): Promise<GitResult> {
  return invoke("git_fetch");
}

export async function gitPull(): Promise<GitResult> {
  return invoke("git_pull");
}

export async function addRemote(url: string): Promise<GitResult> {
  return invoke("git_add_remote", { url });
}

export async function setRemoteUrl(url: string): Promise<GitResult> {
  return invoke("git_set_remote_url", { url });
}

export async function removeRemote(): Promise<GitResult> {
  return invoke("git_remove_remote");
}

export async function pushWithUpstream(): Promise<GitResult> {
  return invoke("git_push_with_upstream");
}

/** A piece of a conflicting text file: shared text, or the two sides of a conflict. */
export type ConflictChunk =
  | { kind: "same"; text: string }
  | { kind: "conflict"; ours: string; theirs: string };

export interface ConflictFile {
  /** Path relative to the notes folder, e.g. `Finance/Bank.md`. */
  path: string;
  isPrivate: boolean;
  /**
   * The user can only keep one side: binary files, and files deleted on one
   * side. `chunks` is empty then.
   */
  pickOnly: boolean;
  /** True when that side deleted the file. */
  oursDeleted: boolean;
  theirsDeleted: boolean;
  chunks: ConflictChunk[];
}

export type ConflictResolution =
  | { kind: "text"; content: string }
  | { kind: "ours" }
  | { kind: "theirs" };

/** Conflicting files of an unfinished merge. Empty when no merge is in progress. */
export async function getConflicts(): Promise<ConflictFile[]> {
  return invoke("git_conflicts");
}

/** Writes and stages one file's resolution (encrypting it when private). */
export async function resolveConflict(
  path: string,
  resolution: ConflictResolution,
): Promise<void> {
  return invoke("git_resolve_conflict", { path, resolution });
}

/** Commits the merge once every file is resolved. */
export async function finishMerge(): Promise<GitResult> {
  return invoke("git_finish_merge");
}

/** `git merge --abort`: back to the state before the pull. */
export async function abortMerge(): Promise<GitResult> {
  return invoke("git_abort_merge");
}
