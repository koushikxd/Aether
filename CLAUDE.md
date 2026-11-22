# Aether - Development Guide

## Project Overview

Aether is a cross-platform markdown note-taking app for macOS, Windows, and Linux, built with Tauri v2 (Rust backend) + React/TypeScript/Tailwind (frontend) + TipTap (WYSIWYG editor) + Tantivy (full-text search).

## Commands

```bash
pnpm dev          # Start Vite dev server only
pnpm build        # Build frontend (tsc + vite)
pnpm tauri dev    # Run full app in development mode
pnpm tauri build  # Build production app
pnpm lint         # Lint with oxlint (type-aware)
pnpm fmt          # Format with oxfmt (fmt:check to verify)
```

## CI

Runs on every push to `main` and on PRs. Validates formatting (`oxfmt --check`), lint (`oxlint`), frontend build (`tsc` + Vite), and Rust compilation (`cargo check` + `cargo clippy`) on an Ubuntu runner.

## Key Patterns

- All backend operations go through Tauri commands in `src-tauri/src/lib.rs`. Frontend calls them via `invoke()` from `@tauri-apps/api/core`.
- `NotesContext` uses a dual context pattern (data/actions separated) for performance.
- Settings live in two places: app config at `{APP_DATA}/config.json`, per-folder settings at `{NOTES_FOLDER}/.aether/settings.json`.
- Tauri v2 permissions go in `src-tauri/capabilities/default.json`.

## Coding Conventions

- Clean, minimal code with low technical debt
- Proper React patterns (contexts, hooks, memoization)
- Type-safe with TypeScript throughout
- No commented-out code or TODOs in production code
- Use `React.memo` for expensive list-item components
- Use `useCallback`/`useMemo` for performance-critical paths
- Debounce user-triggered operations (auto-save 500ms (300ms in source mode), search 150ms, file watcher 500ms, git status 1000ms)
- All operations should be non-blocking (async)
- Error handling with user-friendly messages

## Docs

- `docs/projectspec.md`: every feature and shortcut, from the user's side.
- `docs/architecture.md`: code layout, storage on disk, and the main flows (save, commit, pull, merge, private pages, export and import).

Read them before working on a feature area.

## Private Pages

- A private page stays as plaintext on disk. Aether keeps it out of git with a block in `.git/info/exclude`. Aether's commit encrypts it into `.aether/vault/` with the key from the OS keychain, and that encrypted copy is what gets pushed. Logic lives in `src-tauri/src/vault.rs`. The merge editor is in `merge.rs`.
- Aether installs `pre-commit` and `pre-merge-commit` hooks that refuse terminal commits holding private pages. Never commit or merge from the terminal in a notes folder with private pages, and never use `--no-verify` to get past the hook. Commit through the app.
- Exports leave private pages out unless the user opts in through a dialog.

## Testing

```bash
pnpm test         # Rust tests, then Playwright E2E
pnpm test:rust    # cargo tests only
pnpm test:e2e     # Playwright against a fake backend (tests/e2e/fake-*.ts)
```

- Every new Tauri command needs a handler in the E2E fake backend.
- Never run `cargo fmt`: HEAD is not rustfmt-clean. Format a single file with `rustfmt --edition 2021 <file>`.

## Releasing

1. Bump version in `package.json` and `src-tauri/tauri.conf.json`
2. Commit to `main`, then tag and push: `git tag v0.5.0 && git push origin v0.5.0`
3. The release workflow builds all platforms and creates a draft GitHub release
4. Update the description in `latest.json` from GitHub after the action finishes
5. Review, edit notes, and publish
