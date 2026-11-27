# Aether

Offline-first markdown notes app for macOS, Windows, and Linux. Notes are plain `.md` files in a folder the user picks: no account, no cloud. Optional git sync moves the folder between devices, and private pages are encrypted before git sees them. An `aether` CLI lets AI agents work on the same notes.

## Docs

Read the doc for an area before changing it. Update it in the same change when behavior moves.

- `docs/project-spec.md`: what the app does, from the user's side. Every feature and shortcut.
- `docs/architecture.md`: code layout, data on disk, events, the save and rename flow, tests. Its feature table points to one doc per feature: `private-pages`, `git-sync`, `cli`, `tabs`, `export-import`, `notion-import`.
- `docs/releasing.md`: cutting a release.
- `tests/README.md`: E2E fixture helpers and the fake backend.

## How it works

- Rust (`src-tauri/src/`) owns the file system, search (Tantivy), git, and encryption. React + TipTap (`src/`) only renders. They talk through Tauri commands (`invoke()`) and events (`listen()`).
- A note's id is its path relative to the notes folder, without `.md`. A page's sub-pages live in `Page/` next to `Page.md`. The first heading names the file, so a title edit is a rename, and renames rewrite links across the folder.
- Other programs edit notes too (another editor, the CLI, an agent). The file watcher emits `file-change`, and the editor reloads the open note or holds unsaved edits until the user picks Refresh or Overwrite.
- The vault key lives only in the OS keychain and only the app reads it. So the CLI edits files directly, but hands commit and sync to the running app through a file mailbox.

## Where code lives

- Note behavior (naming, saving, moving, search) belongs in `src-tauri/src/notes.rs`, which the app and the CLI share. Put it there, not in a Tauri command or the CLI, so both keep it.
- Every Tauri command is in `src-tauri/src/lib.rs`, registered in `generate_handler!`. Each one also gets a wrapper in `src/services/` and a handler in `tests/e2e/fake-backend.ts` returning the same JSON shape.
- Feature modules: `vault.rs` (private pages), `git.rs` and `merge.rs` (sync), `agent_git.rs` (CLI requests), `relink.rs` (links after moves), `export.rs`, `notion_import.rs`, `bin/aether-cli.rs`.
- Frontend state is in `src/context/`. `NotesContext` splits data and actions into two contexts so action consumers skip data re-renders. Keep that split.
- Tauri permissions: `src-tauri/capabilities/default.json`. Per-folder settings (`.aether/settings.json`) are committed to git; device-only state goes in `localStorage` or `.git/`.
- CLI commands or output changed: update `skills/aether/SKILL.md`, which the app installs for agents.

## Taste

- The notes folder belongs to the user, not to Aether. Write the markdown other apps read: relative links, inline HTML (`<mark>`, `<span style>`) only where markdown has no form. Anything that writes notes emits what the editor's serializer writes, so opening and saving changes nothing.
- Private plaintext never leaves the device. Not in git, not in a CLI reply or error, not in an export the user did not opt into, not in a temp file outside the notes folder. Treat every new path that lists, reads, or reports notes as a leak until a test proves it filters the private set.
- Thin edges, one core: commands parse and delegate, services wrap `invoke()`, components render. The core in Rust holds the rules.
- Typing must feel instant. Blocking work runs in `spawn_blocking`. User-triggered work is debounced.
- No `any`. Type the fields you actually read and narrow from `unknown`.
- Comments say why, in a sentence. The code already says what.
- Errors are sentences the user can act on: "No Notion pages found. In Notion, export as HTML with sub-pages included."
- If a rule here fights the task in front of you, say so loudly and get sign-off before breaking it.

## Guardrails

- In a notes folder with private pages, commit and merge only through the app. Aether's `pre-commit` and `pre-merge-commit` hooks refuse terminal commits, and `--no-verify` would push plaintext. Leave the exclude block and `.git/aether-*` files to Aether.
- Format Rust with `rustfmt --edition 2021 <file>` on files you changed. `cargo fmt` would reformat unrelated code: HEAD is not rustfmt-clean.

## Verify

- `pnpm fmt:check`, `pnpm lint --deny-warnings`, and `pnpm exec tsc`. CI fails on any lint warning.
- `cargo clippy -- -D warnings` in `src-tauri/`.
- `pnpm test:e2e <spec>` for the specs your change touches, `pnpm test:rust` for backend changes, then `pnpm test` once at the end.
- Commits: `type(scope): what changed`, such as `fix(cli): refuse a new name that a private page holds under another case`.
