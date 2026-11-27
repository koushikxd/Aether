# Git sync

Optional git sync moves a notes folder between devices. Aether commits, pulls with a merge, pushes, and resolves conflicts in its own merge editor. Private pages ride along encrypted: see [private-pages.md](private-pages.md).

## Behavior

- Settings, Version Control: Aether can run `git init`, add or change the `origin` remote, and push with upstream.
- The footer shows the branch, uncommitted changes, and a sync button. The command menu has "Git: Quick Commit" and "Git: Sync (Pull and Push)".
- Commit stages everything and commits. Sync pulls, then pushes when the local branch is ahead.
- With a remote set, Aether fetches every 60 seconds to show incoming changes.

### Merge editor

When a pull conflicts, a "Resolve conflicts" dialog lists the conflicting notes, public and private.

- For each conflict, keep "This device", "Other device", or "Both", and edit the result by hand.
- Binary files and files deleted on one side can only keep one side.
- Finishing commits the merge and pushes. "Cancel sync" aborts the merge and restores the state before the pull.
- If the folder opens in the middle of a merge, the dialog opens again.
- A sync from the CLI that stops on conflicts opens the dialog in the running app.

## Implementation

| File                                 | Role                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| `src-tauri/src/git.rs`               | git CLI wrappers: status, `commit_all`, pull, push, merge helpers  |
| `src-tauri/src/vault.rs`             | `commit` and `pull`, which wrap git with encryption and decryption |
| `src-tauri/src/merge.rs`             | Conflicts of an unfinished merge, public and private               |
| `src/context/GitContext.tsx`         | Status, commit, pull, sync, push, the merge editor state           |
| `src/components/git/MergeEditor.tsx` | The merge editor                                                   |

Every `git_*` command runs through `with_git`, which holds `AppState.git_lock`. Agent requests from the CLI take the same lock, so the app and the CLI never run git in one folder at once. `GitContext` refreshes status 1000 ms after a `file-change` event, and on `git-state-changed` (after an agent request) it refreshes status and conflicts.

### Commit (`git_commit` calls `vault::commit`)

1. `vault::before_commit` refuses if a public page links to a private page, encrypts changed private files into blobs, deletes blobs of files no longer private, writes root blobs for new marks, rewrites the exclude block, and returns the private file set.
2. `git::commit_all` runs `git add -A`, then `vault::untrack` removes the private files from the index, then `git commit -m`.

### Pull and sync (`git_pull` calls `vault::pull`)

1. Without a key, a plain `git pull`.
2. With a key: refuse while `pending_count > 0`, move private plaintext into `.git/aether-stash/`, then `git pull --no-commit` (merge, not rebase).
3. `sync_plaintext` decrypts changed blobs back to their paths and marks, restores stashed files, and removes files whose blobs are gone. A local edit is kept. If both sides changed a note, it gets both versions between conflict markers.
4. If a merge is in progress: when two blobs decrypt to the same path, return a conflict. Otherwise `commit_merge` updates blobs, stages `.aether/vault` and files made public, untracks private files, and commits with `git commit --no-edit`.

The frontend `sync()` in `GitContext` pulls, then pushes if ahead.

### Merge editor

When a pull fails, `GitContext` calls `git_conflicts` and shows the editor if the list is not empty. Conflicts come from unmerged index paths. A private blob conflict is decrypted from index stages 1 to 3. Chunks come from `git merge-file` run in a temp dir inside `.git`, so private text never leaves the notes folder. Each file is saved with `git_resolve_conflict` (re-encrypted when private), then `git_finish_merge` commits the merge and decrypts, and the frontend pushes. `git_abort_merge` runs `git merge --abort` and decrypts again.

## Tests

`src-tauri/src/vault_tests.rs` covers commit, pull, and merge across real clones. `tests/e2e/merge-editor.spec.ts` drives the editor against `tests/e2e/fake-merge.ts` (`window.aetherFakeConflicts`).
