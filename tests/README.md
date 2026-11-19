# Tests

| Layer    | Command          | Artifacts                                                                                      |
| -------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| Frontend | `pnpm test:e2e`  | `test-results/e2e/<test>/` (trace.zip, screenshots), HTML report in `test-results/e2e-report/` |
| Backend  | `pnpm test:rust` | `src-tauri/target/test-artifacts/<test>.txt` (file tree and contents)                          |

`pnpm test` runs both. Run one E2E file with `pnpm test:e2e smoke`, and open a trace with `pnpm exec playwright show-trace <trace.zip>`. First run: `pnpm exec playwright install chromium`.

## Frontend: Playwright with a fake backend

- Playwright starts `pnpm dev` on port 1420, or reuses a server already listening there.
- `tests/e2e/app.ts` intercepts `index.html` and inserts `<script type="module" src="/tests/e2e/fake-backend.ts">` before `src/main.tsx`. Module scripts run in order, so the fake is in place before the app's first `invoke()`. Nothing in `src/` imports the fake, so it never reaches a production build.
- `tests/e2e/fake-backend.ts` calls `mockIPC`, `mockWindows`, and `mockConvertFileSrc("macos")` from `@tauri-apps/api/mocks`. It keeps an in-memory notes folder rooted at `/fake/notes`: a map from relative path (`a/b/Note.md`, `assets/x.png`, `.aether/settings.json`) to content. Events (`listen`, `emit`) use the mock's built-in event bus.
- Every call is recorded with its args. An unknown command throws `[fake-backend] unhandled command: <name>`, and the `app` fixture (`import { test, expect } from "./app"`) fails the test if any occurred.

```ts
await app.seed({ "a/b/Note.md": "# Note\n\nBody" }); // boots the app on these files
await app.open("a/b/Note"); // emits the backend's select-note event
await app.row("Note").click(); // sidebar row by its exact label
await app.drag("Note", "Folder"); // pointer drag between sidebar rows
await expect.poll(() => app.savedMarkdown("a/b/Note")).toContain("Body");
await app.calls("save_note"); // [{ cmd, args }]
await app.file("assets/x.png"); // current fake file content
await app.reload(); // page reload that keeps the fake files
await app.screenshot("name"); // saved to the test's output dir and the report
```

**Adding a command:** add an entry to `handlers` in `fake-backend.ts`, keyed by the command name (plugin calls look like `plugin:dialog|open`). Return the same JSON shape as the Rust command in `src-tauri/src/lib.rs` (structs serialize with their serde names; `Option` becomes `null`). To mirror a Rust `Err(String)`, return `Promise.reject("message")`.

## Backend: cargo test

Tests live in `#[cfg(test)]` modules inside the crate (`src-tauri/src/tests.rs`), so they can call private `#[tauri::command]` functions directly. `test_support::TestNotes` creates a temporary notes folder and a mock Tauri app (`tauri::test::mock_app`, enabled by the `test` feature in `[dev-dependencies]`) whose `AppState` points at that folder. Pass `notes.state()` wherever a command takes `State<AppState>`. Commands that take `AppHandle` need the Wry runtime, so pull their logic into a function that takes `&Path` or `&AppState`.

```rust
let notes = TestNotes::new();
notes.write("a/Note.md", "# Note\n");
let saved = tauri::async_runtime::block_on(crate::save_note(None, "# Hi\n".into(), notes.state())).unwrap();
assert_eq!(notes.tree(), ["Hi.md", "a/Note.md"]);
notes.save_artifact("my_test"); // writes target/test-artifacts/my_test.txt
```
