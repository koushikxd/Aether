# Notion import

Imports a Notion HTML export as notes. Pages become Aether pages with sub-pages, files go to `assets/`, and links between pages point at the imported notes. The markdown takes the forms the editor writes, so the first save of an imported note changes nothing.

## Behavior

- Settings, Folder, Export and Import, "Import from Notion". In Notion, export as HTML with sub-pages included and folders for sub-pages. Pick every zip of the export: a large export comes in parts, and a zip whose root holds other zips (Notion's wrapper) is opened as part of the same export.
- Top-level Notion pages land at the root of the notes folder. A name taken on disk or earlier in the same import (case-insensitive), or one that matches an app or ignored folder, gets `-1`, `-2`.
- The dialog shows progress, then a summary: pages, images, and files imported, and every skipped item with its reason. "Select private pages" then offers only the imported pages.
- A block or header element with no mapping is kept as plain text and listed as skipped. So are links to pages missing from the export (the label stays), and zip entries whose path would leave the folder.

## Mapping

| Notion                          | Markdown                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Page                            | `<parent>/<title>.md`; its sub-pages go in `<parent>/<title>/`                              |
| Page properties                 | YAML frontmatter. Checkbox as `true`/`false`, multi-select as a list, dates from `datetime` |
| Title, description              | `# Title`, then the description as a paragraph                                              |
| Headings, paragraphs, divider   | `#` to `######`, paragraphs, `---`                                                          |
| Bulleted, numbered, to-do lists | `-`, `1.` (keeps the start number), `- [ ]` / `- [x]`. Consecutive lists join               |
| Code                            | Fenced with the language, the fence longer than any backtick run inside                     |
| Quote                           | `>`                                                                                         |
| Toggle                          | `<details><summary>`                                                                        |
| Callout                         | `> [!note] <emoji>`                                                                         |
| Equation, inline equation       | `$$ ... $$`, `$...$`                                                                        |
| Columns, indented blocks        | Flattened into the page                                                                     |
| Simple table                    | Markdown table, first row as header, padded as the editor pads it                           |
| Image                           | Copied to `assets/`, `![](...)`, or `<img width>` when Notion set a width                   |
| File                            | Copied to `assets/`, linked as a file card                                                  |
| Bookmark                        | `[title](url)`                                                                              |
| Link to a page                  | Relative link to the imported note, found by path or by `data-notion-page-id`               |
| Text color, background          | `<span style="color: ...">` with the editor's palette, `<mark>`                             |
| Underline                       | `<u>`                                                                                       |
| Inline database                 | Index note `<page>/<database>.md` holding a table of the rows, and a link to it             |
| Full-page database              | The page's own body is the rows table                                                       |

In a database table, the title cell links to the row's page, a checkbox reads `Yes` or `No`, and multi-select values are joined with commas. Each row page is a sub-page of the database.

## Implementation

| File                                             | Role                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `src-tauri/src/notion_import.rs`                 | The whole import: zips, page tree, ids, HTML to markdown, assets        |
| `src-tauri/src/lib.rs` (`import_notion`)         | Runs the import in `spawn_blocking`, emits progress, rebuilds the index |
| `src/services/export.ts` (`importNotion`)        | Picks the zips, listens for `notion-import-progress`                    |
| `src/components/settings/NotionImportDialog.tsx` | Steps `ready`, `importing`, `done`, `private`                           |
| `src/components/vault/PrivatePagePicker.tsx`     | The private page picker after the import                                |

`notion_import::import` runs in four passes:

1. `Export::open` indexes every file of every zip by its path in the export, opening nested part zips. Unsafe entries go to the skipped list (`export::safe_entry_path`).
2. `scan` reads each HTML page for its title, Notion id, sub-page links, and databases, without rendering. `assign_parents` picks each page's parent: the database that lists it as a row, else the page whose sub-page folder holds it (when several share a name, the one that links to it).
3. `place` gives every node its note id, adding `-N` while the name is taken.
4. `Importer::page` renders each page and writes it. An inline database's index note is queued in `pending` and written right after its page. `progress(written, total)` runs after each note.

To map a new Notion block, add a case to `Importer::block` (or `inline_element` for inline content) that emits what the editor's markdown serializer writes for that node. The round-trip E2E test catches any difference.

## Tests

- `src-tauri/src/tests.rs`, `notion_import_*`: the fixture export in `tests/fixtures/notion`, multi-part and wrapped zips, name clashes, reserved and ignored names, unsafe entries, unknown blocks, backticks in code.
- `tests/e2e/notion-import.spec.ts`: imported notes save back unchanged from the editor; the dialog's progress, summary, and private page picker.
