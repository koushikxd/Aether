# Aether: Architecture

Tauri v2 app. A Rust backend owns the file system, search, and git. A React 19 + TypeScript + Tailwind frontend renders the UI, with TipTap as the editor. The frontend reaches the backend only through Tauri commands (`invoke()`) and events (`listen()`).

## Repository layout

```
src-tauri/src/
  lib.rs            Tauri commands, AppState, settings, note ids, search index, file watcher, setup
  git.rs            git CLI wrappers (status, commit_all, pull, push, merge helpers)
  vault.rs          private pages: encryption, exclude block, hooks, commit/pull integration
  merge.rs          conflicts of an unfinished merge, public and private, for the merge editor
  relink.rs         rewrites relative links and image paths after moves
  export.rs         zip export (page with its sub-pages, workspace) and zip import
  notion_import.rs  Notion HTML export import
  tests.rs, vault_tests.rs, test_support.rs   cargo tests (cfg(test) only)
src-tauri/capabilities/default.json         Tauri permissions
src/
  App.tsx           providers, global key handlers, view switching, preview window mode
  context/          NotesContext, GitContext, VaultContext, ThemeContext
  services/         thin invoke() wrappers, one file per area (notes, git, vault, export, ai, ...)
  components/       editor/, layout/, notes/, settings/, command-palette/, git/, vault/, ui/, icons/
  lib/              shortcuts list, note navigation, page tree, asset paths, platform helpers
tests/e2e/          Playwright specs plus the fake backend
```

## Backend

- `lib.rs` registers every command in `tauri::generate_handler![...]` near the end of `run()`. Blocking work (git, walking the folder, zips, encryption) runs in `tauri::async_runtime::spawn_blocking`.
- `AppState` holds the app config (notes folder path), the per-folder `Settings`, a notes cache, the file watcher, the Tantivy `SearchIndex`, a watcher debounce map, and the `key_store` (OS keychain, or an in-memory store under `cfg(test)`).
- Note ids are paths relative to the notes folder, with `/` separators and no `.md`. `id_from_abs_path` and `abs_path_from_id` convert, and the latter rejects path traversal. `EXCLUDED_DIRS` (`.git`, `.aether`, `.obsidian`, `.trash`, `assets`) and the user's ignored folders never hold notes.
- A sub-page folder is `Page/` next to `Page.md` (`sub_page_dir`). Renames and deletes move or remove both. After a delete or move, `remove_empty_sub_page_dir` removes the old parent's `Page/` when it is empty and `Page.md` exists.
- A bare page is a folder with no matching `.md` (`bare_page_dir`). `list_notes` lists it with its folder name as title and the folder's mtime. `read_note` returns `# <name>` without writing. `save_note` writes the file on the first save, and `create_bare_page_file` writes it first in `move_note` and `vault_set_private`. `delete_note` removes the folder.
- Search: Tantivy index in `{APP_DATA}/search_index`, rebuilt when a folder opens and updated on save, create, delete, and watcher events. Queries are phrase-prefix over the title, then the content. A substring search is the fallback.
- File watcher (`notify`): debounces 500 ms per path, updates the index, and emits `file-change`.
- Other events: `set-notes-folder` (from the `aether` CLI) and `notion-import-progress`.

## Frontend

- Provider order in `App.tsx`: `ThemeProvider` > `TooltipProvider` > `NotesProvider` > `GitProvider` > `VaultProvider` > `TabsProvider`. Preview windows (`?mode=preview&file=...`) render `PreviewApp` without the notes providers.
- `NotesContext` splits data and actions into two contexts (`useNotesData`, `useNotesActions`, or `useNotes` for both), so action consumers do not re-render on data changes.
- `GitContext` owns git status, commit, pull, sync, push, and the merge editor. It refreshes status 1000 ms after a `file-change` event and fetches every 60 s when a remote exists.
- `VaultContext` holds the private pages status (`privateIds`, `privateRoots`), the key dialogs, and `makePrivate` / `makePublic`. It refetches status when the notes list or git status changes.
- `TabsContext` holds the open tabs and each tab's history, and keeps the active tab and `NotesContext`'s selected note in step. NotesContext tells it about created, moved, and deleted notes through `src/lib/noteEvents.ts`. See [tabs.md](tabs.md).
- `ThemeContext` holds theme, fonts, page width, text direction, and zoom, persisted through the per-folder settings.
- The editor (`components/editor/Editor.tsx`) saves 500 ms after the last edit (300 ms in source mode) through `save_note`.
- The command menu is `components/command-palette/CommandPalette.tsx`. The shortcut reference is `src/lib/shortcuts.ts`. Global key handlers are in `App.tsx`, editor ones in `Editor.tsx`.
- The sidebar tree is `components/notes/FolderTreeView.tsx`. `buildPageTree` in `src/lib/folderTree.ts` nests each page under its parent, newest first at every level. `App.tsx` turns `Up` and `Down` pressed outside the tree into `step-note-list` events, which the tree answers by selecting the next visible row. Drops are handled in `components/layout/Sidebar.tsx`. `components/notes/MovePageDialog.tsx` opens on the `open-move-picker` event (from the row menu, the selection bar, and the command menu) and calls `move_note` for each page.
- Recent notes, open tabs (`aether:tabs:<folder>`), and collapsed pages (`aether:collapsedFolders`) are in `localStorage`. Tab state never goes in `.aether/settings.json`, which is committed.

## Data on disk

| Location                                            | What                                                              | Committed to git          |
| --------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `{APP_DATA}/config.json`                            | notes folder path                                                 | n/a                       |
| `{APP_DATA}/search_index/`                          | Tantivy index                                                     | n/a                       |
| `{NOTES}/**/*.md`, `{NOTES}/assets/`                | notes and their assets                                            | yes, except private files |
| `{NOTES}/.aether/settings.json`                     | per-folder settings (pins of private pages removed)               | yes                       |
| `{NOTES}/.aether/vault/vault.json`                  | vault id and key check                                            | yes                       |
| `{NOTES}/.aether/vault/files/<id>.enc`              | one encrypted private file each                                   | yes                       |
| `{NOTES}/.aether/vault/roots/<id>.enc`              | one encrypted private mark each                                   | yes                       |
| `{NOTES}/.aether/vault/.gitattributes`              | `*.enc binary`                                                    | yes                       |
| `{NOTES}/.git/aether-vault.json`                    | marks and per-file cache for this device                          | no                        |
| `{NOTES}/.git/aether-pins.json`                     | pins of private pages                                             | no                        |
| `{NOTES}/.git/info/exclude`                         | block between `# aether-private-begin` and `# aether-private-end` | no                        |
| `{NOTES}/.git/aether-stash/`                        | private plaintext held aside during a pull                        | no                        |
| `{NOTES}/.git/hooks/pre-commit`, `pre-merge-commit` | Aether's leak guard                                               | no                        |

## Main flows

### Open a folder

`set_notes_folder` (or app startup) loads `.aether/settings.json`, runs `vault::decrypt` (which calls `sync_plaintext` when this device has the key), rebuilds the search index, and allows the folder in the asset protocol scope. The frontend then lists notes and starts the watcher.

### Save and rename

`save_note` derives the file name from the first heading. When the name changes, it writes in place first, then renames the file and its sub-page folder, then `relink::relink_notes` rewrites links across the folder and `vault::follow_moves` updates private marks. `vault::page_saved` refreshes the exclude block when a private page starts using a new asset. Moves (`move_note`) use the same relink path. Deletes call `vault::prune_marks`.

### Private pages (vault.rs)

- Key: 32 random bytes, shown to the user as `aether-key-<base64url>`, kept in the OS keychain (`keyring`, service `app.aether.vault`, account = vault id). `vault.json` holds a key check so a wrong key is rejected.
- Encryption: XChaCha20-Poly1305. A blob is `nonce || ciphertext`, with its name (`files/<id>` or `roots/<id>`) as associated data, so blobs cannot be swapped. A file blob holds `path NUL content`. A root blob holds the marked note id. Unchanged files keep their blob bytes.
- Private set: each marked page, everything under its sub-page folder, and assets used only by private pages. Once encrypted, an asset stays private until a public page uses it.
- Exclusion: `write_exclude` writes the private set as anchored patterns into the Aether block of `.git/info/exclude`, and installs the hooks. Marking also runs `git rm --cached` on private files git still tracks.
- Hooks: `pre-commit` and `pre-merge-commit`, marked `# aether-private-pages`, run `git ls-files --cached --ignored` with only the Aether block's patterns and refuse the commit if anything matches. Aether does not overwrite a hook that is not its own, skips the install when `core.hooksPath` is set, and `--no-verify` bypasses them.
- Status: `git_get_status` adds `vault::pending_count` (private edits, removals, and mark changes git cannot see) to `changedCount`.

### Commit (`git_commit`)

1. `vault::before_commit`: refuses if a public page links to a private page, encrypts changed private files into blobs, deletes blobs of files no longer private, writes root blobs for new marks, rewrites the exclude block, and returns the private file set.
2. `git::commit_all`: `git add -A`, then `vault::untrack` removes the private files from the index, then `git commit -m`.

### Pull and sync (`git_pull` calls `vault::pull`)

1. Without a key, a plain `git pull`.
2. With a key: refuse while `pending_count > 0`, move private plaintext into `.git/aether-stash/`, then `git pull --no-commit` (merge, not rebase).
3. `sync_plaintext` decrypts changed blobs back to their paths and marks, restores stashed files, and removes files whose blobs are gone. A local edit is kept. If both sides changed a note, it gets both versions between conflict markers.
4. If a merge is in progress: when two blobs decrypt to the same path, return a conflict; otherwise `commit_merge` updates blobs, stages `.aether/vault` and files made public, untracks private files, and commits with `git commit --no-edit`.

The frontend `sync()` in `GitContext` pulls, then pushes if ahead.

### Merge editor (merge.rs, `components/git/MergeEditor.tsx`)

When a pull fails, `GitContext` calls `git_conflicts`. If the list is not empty it shows the merge editor. Conflicts come from unmerged index paths; a private blob conflict is decrypted from index stages 1 to 3. Chunks come from `git merge-file` run in a temp dir inside `.git`, so private text never leaves the notes folder. Each file is saved with `git_resolve_conflict` (re-encrypted when private), then `git_finish_merge` commits the merge, decrypts, and the frontend pushes. `git_abort_merge` runs `git merge --abort` and decrypts again.

### Export and import (export.rs)

`export_folder_zip(folder, dest, includePrivate)` and `export_note_zip(id, markdown, dest, includePrivate)` leave out the current private set unless `includePrivate`. The workspace export in settings calls `export_folder_zip` on the whole notes folder and asks only when the notes folder has a vault. `export_note_zip` takes the editor's current markdown and adds the page's sub-page folder with the assets its notes use. The editor asks only when the page or a sub-page is private (`ExportZipDialog` in `components/vault`). For a private page it shows a warning instead of the checkbox, and confirming exports the page and its sub-pages with `includePrivate`. `import_zip` skips app folders and refuses entries that would escape the folder. `import_notion` converts Notion HTML zips, writes top-level pages at the notes folder root (`-1`, `-2` on a name clash), returns the ids it wrote for the private-page picker, and re-indexes.

## Tests

- `pnpm test:e2e`: Playwright against `pnpm dev` on port 1420. `tests/e2e/app.ts` injects `fake-backend.ts`, which mocks IPC with an in-memory notes folder. `fake-vault.ts` (seeded via `window.aetherFakeVault`) and `fake-merge.ts` (`window.aetherFakeConflicts`) add the vault and conflict commands. An unhandled command fails the test.
- `pnpm test:rust`: `cargo test`. `tests.rs` covers commands through `test_support::TestNotes`. `vault_tests.rs` runs real git repos and clones in temp dirs with the in-memory key store.
- `pnpm test` runs both. See `tests/README.md` for helpers and artifacts.

## Notes for agents

- Every backend operation is a Tauri command in `src-tauri/src/lib.rs`, registered in `generate_handler!`. Add a wrapper in `src/services/` and a handler in `tests/e2e/fake-backend.ts` (same JSON shape as the Rust return) for each new command.
- New Tauri permissions go in `src-tauri/capabilities/default.json`.
- Do not run `cargo fmt`: the committed Rust is not rustfmt-clean, so it would reformat unrelated code. Run `rustfmt --edition 2021 <file>` on the files you changed.
- Never commit from the terminal inside a notes folder that has private pages. The hooks refuse it, and `--no-verify` would commit plaintext. Commit from the app. Do not edit the exclude block or `.git/aether-*` files by hand.
- Scripts are in `package.json`: `lint`, `fmt:check`, `build` (tsc + Vite), `test:e2e`, `test:rust`, `test`. CI runs format check, lint, frontend build, `cargo check`, and `cargo clippy`.
