# Aether: Product Spec

Aether is an offline-first markdown note-taking app for macOS, Windows, and Linux. Notes are plain `.md` files in a folder you pick. There is no account and no cloud service. Optional git sync moves notes between devices, and private pages are encrypted before they leave the device.

## Notes folder

- On first launch you pick a notes folder. Every `.md` file in it (recursively) is a note.
- A note's file name follows its title (the first heading). Renaming the title renames the file. Name clashes get a `-1`, `-2` suffix.
- New notes use the "Default Note Name" template from settings. Tags such as `{date}`, `{time}`, `{year}`, `{month}`, `{day}`, `{weekday}`, `{timestamp}` and `{counter}` are expanded.
- Images and attached files are copied into `assets/` at the root of the folder and linked with relative paths, so the folder works in other markdown apps.
- App folders (`.git`, `.aether`, `.obsidian`, `.trash`, `assets`) never hold notes. Common build folders (`node_modules`, `dist`, `target`, ...) are ignored by default. The list is editable under Settings, Ignored Folders.
- Edits made outside the app (another editor, an AI agent) are picked up by a file watcher.

## Sidebar

- The sidebar is a page tree. Sub-pages sit under their page, which expands and collapses. Pages are ordered by last modified, newest first, at every level.
- A "Pinned" section above the tree lists pinned pages, sub-pages included, in the order they were pinned. Pinned pages also stay in their place in the tree.
- The "+" on a row (shown on hover) creates a sub-page of that page. `Cmd+N`, the "+" in the sidebar header, and New Note in the command menu create a top-level page.
- The row context menu has new sub-page, pin, duplicate, copy file path, select multiple, make private or public, move to, move to parent page, and delete.
- Drag a page onto another page to make it a sub-page. Drop it on the empty space below the tree to move it to the top level.
- "Move to..." opens a searchable list of pages plus "Top level". It is in the row menu, the selection bar, and the command menu. The list leaves out the moved pages and their sub-pages.
- `Up` and `Down` outside the sidebar move through the rows the tree shows, in order.
- Moving or renaming a page rewrites the relative links and image paths that point at it.

### Selection mode

- "Select Multiple" in a note row's context menu turns on selection mode with that row selected. `Shift+click` on a row selects every row from the open note to that row (in the order the rows show) and also turns it on.
- In selection mode a click selects or deselects a row instead of opening it. A bar above the footer shows the count, Move to..., Delete, and Done.
- Done or `Esc` ends selection mode. So does deselecting the last row, moving, deleting, or dragging the selection.
- Dragging a selected row onto a page, or onto the top-level area, moves the whole selection.
- Delete asks once, and the dialog counts every page that goes, sub-pages of the selected pages included.

## Sub-pages

- A page can hold sub-pages: `Page.md` plus a `Page/` folder next to it. The sidebar shows them as one node.
- Create one with the "+" on a row, "New sub-page" in the row menu, `Cmd+Shift+N`, the "New Sub-page" command, or the "Sub-page" slash command.
- A page's file stays where it is when the page gains or loses sub-pages. When its last sub-page is deleted or moved away, the empty `Page/` folder is removed.
- Deleting a page deletes its sub-pages. The delete dialog says how many.
- A folder with no matching `.md` (such as `Work/` with no `Work.md`, left by a git clone or Finder) shows as a page that holds only its title. Opening it writes nothing. `Work.md` is created on the first save, or when the page is made private or moved. Its last modified time is the folder's. Deleting it deletes the folder.

## Tabs

Notes open in tabs shown in the editor header. A plain open replaces the active tab's note; `Cmd+T`, `Cmd+click`, `Cmd+Enter` in the command menu, and every create action open a new tab. Each tab has its own back and forward history. Tabs are saved per notes folder. The full behavior is in [tabs.md](tabs.md).

## Editor

- WYSIWYG editing (TipTap) that saves as markdown. Saving is automatic.
- Markdown source mode toggles with `Cmd+Shift+M`.
- Slash menu (`/`): text, headings 1 to 4, bullet, numbered and task lists, blockquote, code block, callout, toggle, Mermaid diagram, block and inline math, horizontal rule, file, image, table, sub-page, wikilink.
- Selecting text shows a toolbar: turn into another block type, bold, italic and other marks, text color, and link.
- A handle next to each block opens a menu to turn it into another type, duplicate it (`Cmd+D` in the editor), or delete it.
- Highlight and text color are stored as inline HTML (`<mark>`, `<span style="color: ...">`) so other markdown apps keep them.
- Code blocks have syntax highlighting. Mermaid blocks render as diagrams. KaTeX renders math.
- Wikilinks: type `[[` to link to another note with autocomplete.
- Images can be pasted, dropped in, and resized. Other files show as file cards.
- Find in note (`Cmd+F`) and focus mode (`Cmd+Shift+Enter`), which fades the sidebar and toolbar.
- The Info button next to Export in the editor header shows the note's last modified date, created date (hidden when the system does not record it, common on Linux), word and character count, and path relative to the notes folder. Click the path to copy it. Not shown in the preview window.

## Command menu and search

- `Cmd+K` opens the command menu: new note or sub-page, back and forward, parent page, pin, duplicate, move to, delete, copy and export, git commit and sync, focus mode, source mode, open the notes folder, shortcuts, settings.
- Sub-views: Search Notes, Recent Notes, Theme, Edit with AI, and Copy / Export. `Cmd+1` to `Cmd+9` run a row in a sub-view.
- Search matches the typed words in order, with the last word as a prefix. Title hits rank first. Results show the matching line with the match highlighted.
- Recent notes are kept per notes folder. Back and forward move through the active tab's history for the current session.
- `Cmd+Enter` on a note opens it in a new tab.

## Copy, export, import

- Per note (`Cmd+Shift+C`): copy as markdown, plain text, or HTML; print as PDF; export markdown; export a zip (the page, its sub-pages, and their assets); export self-contained HTML. When a sub-page is private, the zip export asks whether to include private pages (off by default). When the page itself is private, it shows a warning instead, and Export includes the page and its sub-pages unencrypted.
- Settings, Export and Import: "Export Workspace" zips every note and asset. When the folder has private pages, a dialog asks whether to include them unencrypted (off by default).
- "Import Zip" unpacks an exported zip into the notes folder.
- "Import from Notion" takes the zip files of a Notion HTML export (with subpages and folders for subpages). Top-level Notion pages land at the root of the notes folder. Name clashes get a `-1`, `-2` suffix. After the import you can pick which imported pages to make private.

## Git sync

- Optional, under Settings, Version Control. Aether can run `git init`, add or change the `origin` remote, and push with upstream.
- The footer shows the branch, uncommitted changes, and a sync button. The command menu has "Git: Quick Commit" and "Git: Sync (Pull and Push)".
- Commit stages everything and commits. Sync pulls, then pushes when the local branch is ahead.
- With a remote set, Aether fetches every 60 seconds to show incoming changes.

## Merge editor

When a pull conflicts, a "Resolve conflicts" dialog lists the conflicting notes, public and private.

- For each conflict, keep "This device", "Other device", or "Both", and edit the result by hand.
- Binary files and files deleted on one side can only keep one side.
- Finishing commits the merge and pushes. "Cancel sync" aborts the merge and restores the state before the pull.
- If the folder opens in the middle of a merge, the dialog opens again.

## Private pages

Private pages let you sync a folder through git while keeping some pages unreadable to anyone without your key.

- Right-click a page and choose "Make private". Its sub-pages, and assets used only by private pages, become private too. A lock icon marks private rows.
- The first time, Aether asks you to generate a key. Store it somewhere safe: without it, private pages cannot be opened on another device or recovered.
- On disk the page stays readable as normal markdown. Git never sees the plaintext. Each commit from Aether encrypts private files into `.aether/vault/`, and only those encrypted files are committed and pushed.
- On another device, the pages show as locked ("Private pages locked") until you enter the key. Then they are decrypted into place, and stay in sync on every pull.
- Settings, Private Pages: generate, show, or enter the key.
- "Make public" asks for confirmation, because the page will be pushed unencrypted on the next commit. A sub-page of a private page cannot be made public on its own.
- A commit is refused while a public page links to a private page, since the link would expose its path.
- A sync is refused while private changes are uncommitted.
- Pins of private pages are kept on the device, out of the committed settings file.
- Aether installs git hooks in the notes folder that refuse a terminal commit holding a private file in plaintext. Commit from the app.

## AI editing

Edit the current note with a local CLI: Claude Code, OpenAI Codex, OpenCode, or Ollama (fully offline). Open it from the command menu ("Edit with AI"). Aether runs the tool on the note file and reloads the note.

## Preview mode and CLI

- Opening a `.md` file from outside the notes folder (drag-and-drop or "Open With") shows it in a standalone preview window, which can save it into the notes folder.
- On macOS, Settings, Integrations can install an `aether` shell command. `aether .` opens a folder as the notes folder.

## Settings

Tabs: Folder (`Cmd+1`), Integrations (`Cmd+2`), Appearance (`Cmd+3`), Shortcuts (`Cmd+4`), About (`Cmd+5`).

- Folder: folder location, export and import, version control, private pages, default note name, ignored folders.
- Integrations: AI providers and the CLI tool.
- Appearance: light, dark, or system theme with custom colors, typography (font, size, bold weight, line height), page width, and text direction (including RTL).

## Keyboard shortcuts

`Cmd` is `Ctrl` on Windows and Linux.

| Shortcut                      | Action                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `Cmd+K`                       | Command menu                                                    |
| `Cmd+1` to `Cmd+9`            | Run a row in a menu sub-view (while the menu is open)           |
| `Cmd+Shift+F`                 | Search notes                                                    |
| `Cmd+Shift+O`                 | Recent notes                                                    |
| `Cmd+[` / `Cmd+]`             | Back / Forward in the active tab                                |
| `Cmd+T`                       | Open a note in a new tab                                        |
| `Cmd+Shift+T`                 | Reopen closed tab                                               |
| `Cmd+1` to `Cmd+8`, `Cmd+9`   | Go to tab 1 to 8, go to the last tab                            |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab                                             |
| `Cmd+Alt+Up`                  | Go to parent page                                               |
| `Cmd+\`                       | Toggle sidebar                                                  |
| `Cmd+,`                       | Settings                                                        |
| `Cmd+/`                       | Keyboard shortcuts                                              |
| `Cmd+W`                       | Close tab (the last tab closes the window)                      |
| `Cmd+=` / `Cmd+-` / `Cmd+0`   | Zoom in / out / reset                                           |
| `Cmd+N`                       | New top-level note                                              |
| `Cmd+Shift+N`                 | New sub-page                                                    |
| `Cmd+D`                       | Duplicate note (duplicates the block when the editor has focus) |
| `Cmd+R`                       | Reload note                                                     |
| `Delete` or `Cmd+Backspace`   | Delete note                                                     |
| `Up` / `Down`                 | Move through notes in sidebar order                             |
| `Enter` / `Esc`               | Focus editor / back to note list                                |
| `Cmd+B` / `Cmd+I`             | Bold / Italic                                                   |
| `Cmd+Shift+L`                 | Add or edit link                                                |
| `Cmd+F`                       | Find in note                                                    |
| `Cmd+Shift+C`                 | Copy and export menu                                            |
| `Cmd+Shift+P`                 | Print / export as PDF                                           |
| `Cmd+Shift+M`                 | Markdown source                                                 |
| `Cmd+Shift+Enter`             | Focus mode                                                      |
| `/`                           | Slash commands                                                  |

The full list, including markdown syntax, is in Settings, Shortcuts (source: `src/lib/shortcuts.ts`).
