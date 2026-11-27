# Tabs

Aether opens notes in tabs, like a browser. Each tab shows one note and keeps its own back and forward history. The tab strip sits in the editor header. The sidebar toggle is pinned beside the window controls, so with the sidebar hidden the strip starts after it.

## Behavior

### What opens where

- A plain open replaces the note in the active tab. This covers a sidebar click, a link or wikilink click, a command menu pick, and the arrow keys in the note list.
- A note has at most one tab. Opening a note that already has a tab switches to that tab.
- These open the note in a new tab, placed right after the active tab:
  - `Cmd+T`, then pick a note.
  - `Cmd+Enter` on a note in the command menu (root, Search Notes, or Recent Notes).
  - `Cmd+click` on a sidebar page row, a link to a note or sub-page in the editor, or a wikilink.
  - Every create action: `Cmd+N`, `Cmd+Shift+N`, the sidebar + button, New Note in the command menu, a row's + or New sub-page, Duplicate (`Cmd+D` or the menu item), and the Sub-page slash command. The slash command inserts the link first, then opens the sub-page.
- With no tabs open (first launch, or a folder with no notes), the first note you open creates a tab.

### `Cmd+T`

`Cmd+T` opens the command menu in Search Notes, in "new tab" mode. The placeholder reads "Open a note in a new tab...".

- With an empty query, the list shows the 9 most recent notes. Typing searches note contents as in Search Notes.
- `Enter`, a click, or `Cmd+1` to `Cmd+9` opens the note in a new tab, or switches to its tab if it has one.
- `Esc` closes the menu and opens nothing.

### Back and forward

- `Cmd+[` and `Cmd+]` move through the active tab's own history. A new tab starts with an empty history.
- Back and forward skip notes that were deleted, and notes that are open in another tab.
- History lasts for the session. It is not restored after a restart or by `Cmd+Shift+T`.
- Recent Notes (`Cmd+Shift+O`) stays one list for the whole folder, across tabs.

### Closing and reopening

- The x on a tab closes it. The x shows on the active tab and on hover. With one tab left, there is no x.
- Closing the active tab switches to the tab on its right, or to the one on its left if it was last.
- `Cmd+W` closes the active tab. With one tab left, `Cmd+W` closes the window. In Settings and in the preview window, `Cmd+W` closes the window.
- `Cmd+Shift+T` reopens the most recently closed tab at its old position. It skips tabs whose note was deleted or is open again. The closed list lasts for the session.

### Notes that change

- Deleting a note closes its tab. Deleting a page also closes the tabs of its sub-pages. Deletes from outside the app, picked up by the file watcher, close the tabs of other notes. The open note keeps its tab.
- Renaming or moving a note keeps its tab. The tab, its history, and the closed-tab list follow the new path. Sub-pages of a renamed or moved page follow too.

### Scroll position

Switching tabs restores the scroll position the tab had when you left it. Cursor position and undo history are not kept per tab.

### The tab strip

- Each tab shows the note title. Hover a tab for the full title.
- Tabs share the space evenly and shrink to a minimum of 100px. Past that, the strip scrolls sideways and keeps the active tab in view.
- Drag a tab to reorder it.
- Empty space in the strip still drags the window.
- Hiding the sidebar (`Cmd+\`) gives the strip more room.
- Focus mode hides the strip with the rest of the header. Tab shortcuts still work.
- Settings and the preview window have no tabs.

### Saved tabs

Open tabs, their order, and the active tab are saved per notes folder and restored on launch. Tabs whose note no longer exists are dropped on launch. Scroll positions and history are not saved.

## Shortcuts

`Cmd` is `Ctrl` on Windows and Linux.

| Shortcut                      | Action                                             |
| ----------------------------- | -------------------------------------------------- |
| `Cmd+T`                       | Open a note in a new tab                           |
| `Cmd+Enter` (in command menu) | Open the selected note in a new tab                |
| `Cmd+click`                   | Open a sidebar row, link, or wikilink in a new tab |
| `Cmd+W`                       | Close tab (the last tab closes the window)         |
| `Cmd+Shift+T`                 | Reopen closed tab                                  |
| `Cmd+1` to `Cmd+8`            | Go to tab 1 to 8                                   |
| `Cmd+9`                       | Go to the last tab                                 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab, wrapping around               |
| `Cmd+[` / `Cmd+]`             | Back / forward in the active tab                   |

While the command menu is open, `Cmd+1` to `Cmd+9` run its rows instead, and `Cmd+T`, `Cmd+Shift+T`, `Ctrl+Tab`, and `Ctrl+Shift+Tab` are off. In Settings, `Cmd+1` to `Cmd+5` switch settings sections.

## Implementation

| File                                                | Role                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/context/TabsContext.tsx`                       | Tab state, history, persistence, and the actions (`useTabs`).              |
| `src/components/editor/TabStrip.tsx`                | The strip in the editor header, with drag reorder (`@dnd-kit/sortable`).   |
| `src/lib/noteEvents.ts`                             | Typed events NotesContext emits when notes are created, moved, or deleted. |
| `src/lib/noteNavigation.ts`                         | Recent notes, and the active tab's back and forward for the command menu.  |
| `src/App.tsx`                                       | Tab shortcuts and `Cmd+T`.                                                 |
| `src/components/command-palette/CommandPalette.tsx` | New tab mode (`newTab` prop) and `Cmd+Enter`.                              |
| `src/components/editor/Editor.tsx`                  | Cmd+click on links, Sub-page in a new tab, scroll restore.                 |
| `tests/e2e/tabs.spec.ts`                            | E2E tests for everything above.                                            |

### State

`TabsProvider` sits inside `NotesProvider` and wraps `AppContent`. It holds:

- `tabs`: each tab is `{ id, history: { ids, index } }`. The tab's note is `history.ids[history.index]`.
- `activeTabId`.
- `closed`: closed tabs as `{ noteId, index }`, newest last.

`NotesContext` still holds one open note (`selectedNoteId`, `currentNote`). Only the active tab's note is loaded and only one editor is mounted. Tabs and the selection stay in step both ways:

- **Selection to tabs.** When `selectedNoteId` changes, the provider places that note: it switches to the note's tab if one exists, else it opens a new tab (for a just-created note) or pushes the note onto the active tab's history. So every existing caller of `selectNote` (sidebar, links, command menu, backend `select-note` events) works with tabs unchanged.
- **Tabs to selection.** When the active tab's note differs from `selectedNoteId`, an effect calls `selectNote` with it. Tab switches, closes, reopens, back, and forward only change tab state and rely on this effect.

### Note events

`NotesContext` emits events through `src/lib/noteEvents.ts` before it changes the selection, so the tabs see them first:

- `created`: a note from `createNote`, `createNoteInFolder`, or `duplicateNote`. The next selection of that id opens a new tab.
- `moved`: a rename (`saveNote` when the title changed) or `moveNote`. It carries a function from old id to new id, applied to every tab's history and to the closed list.
- `deleted`: `deleteNote` (the page and its sub-pages). It carries a predicate, and matching tabs close.

Notes deleted outside the app are caught when the notes list refreshes: tabs whose note is missing close, except the tab of the selected note. A just-renamed or just-created note can be briefly missing from the list, so the selected note's tab is never closed this way.

### Storage

Tabs are saved in `localStorage` under `aether:tabs:<notes folder path>` as `{ tabs: [{ id, noteId }], activeTabId }`, next to `aether:recentNotes:<folder>`. They are never saved to `.aether/settings.json`, because that file is committed through git.

### Scroll restore

Before a tab switch, the provider reads `[data-editor-scroll]`'s `scrollTop` and saves it for the tab being left. When the editor loads the new tab's note, it calls `takeScrollRestore(noteId)` and scrolls there instead of to the top.
