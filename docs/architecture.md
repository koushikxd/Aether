# Aether: Architecture

Tauri v2 app. A Rust backend owns the file system, search, and git. A React 19 + TypeScript + Tailwind frontend renders the UI, with TipTap as the editor. The frontend reaches the backend only through Tauri commands (`invoke()`) and events (`listen()`).

## Feature docs

Each covers one feature end to end: behavior, then implementation.

| Doc                                  | Covers                                                            |
| ------------------------------------ | ----------------------------------------------------------------- |
| [private-pages.md](private-pages.md) | key, encryption, the private set, exclude block, hooks            |
| [git-sync.md](git-sync.md)           | commit, pull, sync, the merge editor                              |
| [cli.md](cli.md)                     | the `aether` CLI, the agent request mailbox, install, agent skill |
| [tabs.md](tabs.md)                   | tabs, per-tab history, saved tabs                                 |
| [export-import.md](export-import.md) | copy, PDF, HTML, zip export, zip import                           |
| [notion-import.md](notion-import.md) | Notion HTML export to notes                                       |

## Repository layout

```
src-tauri/src/
  lib.rs            Tauri commands, AppState, settings, note ids, search index, file watcher, setup
  notes.rs          note core with no Tauri types (list, read, save, create, move, search), shared with the CLI
  bin/aether-cli.rs the `aether` CLI
  install.rs        puts the CLI on PATH and installs the agent skill
  git.rs            git CLI wrappers (status, commit_all, pull, push, merge helpers)
  vault.rs          private pages: encryption, exclude block, hooks, commit/pull integration
  merge.rs          conflicts of an unfinished merge, public and private, for the merge editor
  agent_git.rs      CLI git requests: the mailbox, the handler the app runs for them, and `status`
  relink.rs         rewrites relative links and image paths after moves
  export.rs         zip export (page with its sub-pages, workspace) and zip import
  notion_import.rs  Notion HTML export import
  tests.rs, vault_tests.rs, test_support.rs   cargo tests (cfg(test) only)
src-tauri/tests/cli.rs                      cargo tests that run the built CLI
src-tauri/capabilities/default.json         Tauri permissions
skills/aether/SKILL.md                      the agent skill, embedded in the app
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
- `AppState` holds the app config (notes folder path), the per-folder `Settings`, a notes cache, the file watcher, the Tantivy `SearchIndex`, a watcher debounce map, `git_lock`, and the `key_store` (OS keychain, or an in-memory store under `cfg(test)`).
- Note ids are paths relative to the notes folder, with `/` separators and no `.md`. `id_from_abs_path` and `abs_path_from_id` convert, and the latter rejects path traversal. `EXCLUDED_DIRS` (`.git`, `.aether`, `.obsidian`, `.trash`, `assets`) and the user's ignored folders never hold notes.
- A sub-page folder is `Page/` next to `Page.md` (`sub_page_dir`). Renames and deletes move or remove both. After a delete or move, `remove_empty_sub_page_dir` removes the old parent's `Page/` when it is empty and `Page.md` exists.
- A bare page is a folder with no matching `.md` (`bare_page_dir`). `list_notes` lists it with its folder name as title and the folder's mtime. `read_note` returns `# <name>` without writing. `save_note` writes the file on the first save, and `create_bare_page_file` writes it first in `move_note` and `vault_set_private`. `delete_note` removes the folder.
- Search: Tantivy index in `{APP_DATA}/search_index`, rebuilt when a folder opens and updated on save, create, delete, and watcher events. Queries are phrase-prefix over the title, then the content. A substring search is the fallback.
- File watcher (`notify`): debounces 500 ms per path, updates the index, and emits `file-change`. When another program changes `.aether/settings.json`, it reloads the settings in `AppState` and emits `settings-changed`, so the app does not write old pins back.
- `git_lock` serializes git work for the app and CLI agent requests (see [git-sync.md](git-sync.md)).
- Other events: `set-notes-folder` (from `aether open`), `git-state-changed` (after an agent request), and `notion-import-progress`.

## Frontend

- Provider order in `App.tsx`: `ThemeProvider` > `TooltipProvider` > `NotesProvider` > `GitProvider` > `VaultProvider` > `TabsProvider`. Preview windows (`?mode=preview&file=...`) render `PreviewApp` without the notes providers.
- `NotesContext` splits data and actions into two contexts (`useNotesData`, `useNotesActions`, or `useNotes` for both), so action consumers do not re-render on data changes.
- `GitContext` owns git status, commit, pull, sync, push, and the merge editor. It refreshes status 1000 ms after a `file-change` event and fetches every 60 s when a remote exists.
- `VaultContext` holds the private pages status (`privateIds`, `privateRoots`), the key dialogs, and `makePrivate` / `makePublic`. It refetches status when the notes list or git status changes.
- `TabsContext` holds the open tabs and each tab's history, and keeps the active tab and `NotesContext`'s selected note in step. NotesContext tells it about created, moved, and deleted notes through `src/lib/noteEvents.ts`. See [tabs.md](tabs.md).
- `ThemeContext` holds theme, fonts, page width, text direction, and zoom, persisted through the per-folder settings.
- The editor (`components/editor/Editor.tsx`) saves 500 ms after the last edit (300 ms in source mode) through `save_note`. On a `file-change` for the open note it reloads the note, unless it has unsaved edits. Then it holds them (`heldRef`) and saves nothing until Refresh, Overwrite, or another note.
- The command menu is `components/command-palette/CommandPalette.tsx`. The shortcut reference is `src/lib/shortcuts.ts`. Global key handlers are in `App.tsx`, editor ones in `Editor.tsx`.
- The sidebar tree is `components/notes/FolderTreeView.tsx`. `buildPageTree` in `src/lib/folderTree.ts` nests each page under its parent, newest first at every level. `App.tsx` turns `Up` and `Down` pressed outside the tree into `step-note-list` events, which the tree answers by selecting the next visible row. Drops are handled in `components/layout/Sidebar.tsx`. `components/notes/MovePageDialog.tsx` opens on the `open-move-picker` event (from the row menu, the selection bar, and the command menu) and calls `move_note` for each page.
- Recent notes, open tabs (`aether:tabs:<folder>`), and collapsed pages (`aether:collapsedFolders`) are in `localStorage`. Tab state never goes in `.aether/settings.json`, which is committed.

## Data on disk

| Location                                            | What                                                              | Committed to git          |
| --------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `{APP_DATA}/config.json`                            | notes folder path                                                 | n/a                       |
| `{APP_DATA}/search_index/`                          | Tantivy index                                                     | n/a                       |
| `{APP_DATA}/agent/requests/`, `responses/`          | CLI git requests and the app's replies, `<id>.json`               | n/a                       |
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

## Tests

- `pnpm test:e2e`: Playwright against `pnpm dev` on port 1420. `tests/e2e/app.ts` injects `fake-backend.ts`, which mocks IPC with an in-memory notes folder. `fake-vault.ts` (seeded via `window.aetherFakeVault`) and `fake-merge.ts` (`window.aetherFakeConflicts`) add the vault and conflict commands. An unhandled command fails the test.
- `pnpm test:rust`: `cargo test`. `tests.rs` covers commands through `test_support::TestNotes`. `src-tauri/tests/cli.rs` runs the built CLI against temp notes folders and writes each transcript to `test-results/cli/`. `vault_tests.rs` runs real git repos and clones in temp dirs with the in-memory key store.
- `pnpm test` runs both. See `tests/README.md` for helpers and artifacts.
