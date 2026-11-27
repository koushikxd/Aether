# CLI

The `aether` command lets people and AI agents read and change notes from a terminal, with or without the app running. It cannot see private pages. Commit and sync go through the running app, which holds the vault key.

## Behavior

- Settings, Integrations, Install CLI Tool puts `aether` on PATH on macOS, Windows, and Linux. `aether --help` lists every command.
- `list`, `search`, `read`, and `check` find and read pages. `create`, `append`, `edit`, and `move` change them. There is no delete. `--json` prints one JSON object, errors included.
- The notes folder is `--folder`, else the nearest folder above the current directory that holds `.aether/`, else the folder open in the app.
- Private pages do not exist for the CLI. A command that touches one fails with `path unavailable` and names nothing.
- `read` prints a hash. `edit` needs it as `--if-match <hash>` and fails with exit code 3 if the page changed since. A new first heading renames the page and rewrites links, as in the app. Moves and renames keep pins.
- `status` shows the branch, ahead and behind, changed public pages by id, and private changes only as a count. It works with the app closed.
- `commit [-m <message>]` and `sync` hand the work to the app, starting it if needed. The app answers only for the notes folder it has open. Replies never name a private page.
- A `sync` that stops on conflicts exits with code 3 and lists the public conflicting files. Fix their markers, then `sync --continue` finishes the merge and pushes, or `sync --abort` cancels it. When private pages conflict too, `--continue` exits with code 4 and the app brings its merge editor forward for them.
- `aether .` or `aether open <folder>` opens a folder as the notes folder. `aether note.md` opens a note. `aether` alone starts the app.
- Install Agent Skill writes a skill that teaches agents the CLI, to `~/.claude/skills/aether/` (Claude Code) and `~/.agents/skills/aether/` (Codex and others). The button reads Update Agent Skill when an installed copy differs from this version.

## Implementation

| File                              | Role                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `src-tauri/src/bin/aether-cli.rs` | The CLI (`clap`)                                              |
| `src-tauri/src/notes.rs`          | Note core shared with the app: list, read, save, create, move |
| `src-tauri/src/agent_git.rs`      | `status`, the request mailbox, and the handler the app runs   |
| `src-tauri/src/install.rs`        | Puts the CLI on PATH and installs the skill                   |
| `skills/aether/SKILL.md`          | The agent skill, embedded with `include_str!`                 |
| `src-tauri/tests/cli.rs`          | Runs the built CLI; transcripts go to `test-results/cli/`     |

When the CLI's commands or output change, update `skills/aether/SKILL.md`: the app installs that text for agents.

### Binary and folder

- The binary is `aether-cli`, not `aether`, because `aether` and `Aether` collide on case-insensitive file systems. The install names the link or copy `aether`.
- Without `--folder` or a `.aether/` above the current directory, it reads `notes_folder` from the app's `config.json` (`dirs::data_dir()/com.aether.app`).
- The Tauri bundler ships every `src/bin` binary next to the app binary: `Contents/MacOS/` on macOS, `usr/bin/` in the deb, next to `Aether.exe` on Windows. No `externalBin` is used.

### Keeping private pages out

- Every input and output is filtered through `vault::current_private_set`, which needs no key. Errors for private paths say `path unavailable`, including name collisions and the `-2` suffixes a new name would pass over.
- Pages reached through a symlink count as private. A page id resolves only when spelled exactly as on disk (no other casing, `//`, or `.`).
- A folder inside another notes folder that has marks is refused, since its marks live at that root.

### Reading and writing

- `read` returns a SHA-256 hash of the markdown, and `edit --if-match` compares it before writing.
- Renames and moves run `notes::after_moves` (links and private marks), then `notes::follow_pins`, which rewrites pins in `.aether/settings.json`.
- `search` scans the `.md` files with the same matching as the app's fallback search. It does not open the Tantivy index, which the running app holds.
- `open` and a bare path spawn the app binary next to the CLI, detached, with the path. The app's `handle_cli_args` and the single-instance plugin take it from there.

### Status, commit, and sync

- `status` runs in the CLI alone with `GIT_OPTIONAL_LOCKS=0`. Private changes come from `vault::pending_count` and the private set.
- `commit` and `sync` write a request (folder, action, message) to `{APP_DATA}/agent/requests/<id>.json`, through a temp file and a rename, in folders with mode 0700 on Unix. Then the CLI spawns the app with `--agent-request <id>`. The single-instance plugin forwards that to the running app's `handle_cli_args`, which takes the request, deletes it, and runs `agent_git::handle` under `git_lock`. The reply goes to `responses/<id>.json`, and the CLI polls for it every 100 ms for up to 10 minutes. The app then emits `git-state-changed`, and on a hand-off it shows its window. At startup the app removes mailbox files older than one hour.
- `run_agent_request` refuses when git is off for the folder, and `agent_git::handle` refuses a folder other than the open one.
- `commit` runs `vault::commit`, refused while a merge is in progress. `sync` runs `vault::pull`, then pushes when ahead.
- `sync-continue` lists public files that still hold markers (a line starting with 7 or more `<` or `>`, code fences included), and refuses while a conflicted page is away from its path (renamed or moved, including a case-only rename). It stages the rest as they are on disk (`git add -A`, so a removed file is deleted) and hands off when private conflicts remain. Otherwise it runs `merge::finish`, then pushes. `sync-abort` runs `merge::abort`.
- A public conflicted path that is private on this device counts as private. A reply message that contains a private name, read from before and after the action, as written or as git quotes it, is replaced with a generic one.

### Install (`install.rs`)

- macOS and Linux: a symlink named `aether` to the bundled `aether-cli`, in Homebrew's bin folder on macOS and `~/.local/bin` on Linux. It replaces the shell wrapper older versions installed (marked `# AETHER_CLI_WRAPPER`) and never touches an `aether` that Aether did not install.
- Windows: copies `aether-cli.exe` to `%LOCALAPPDATA%\com.aether.app\bin\aether.exe`, writes the app's path beside it in `aether-app.txt` (how the copy finds the app for `aether open`), and adds that folder to the user `PATH` in the registry. At startup the app re-copies an installed CLI that an update left out of date.
- The Linux AppImage refuses to install: it runs from a temporary mount that a link would outlive.
- Status reads installed only when the entry is this app's CLI.
