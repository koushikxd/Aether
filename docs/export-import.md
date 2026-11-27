# Export and import

Copy or export one note, zip a page or the whole workspace, and unpack a zip back into a notes folder. Importing from Notion has its own doc: [notion-import.md](notion-import.md).

## Behavior

- Per note (`Cmd+Shift+C`): copy as markdown, plain text, or HTML; print as PDF; export markdown; export a zip (the page, its sub-pages, and their assets); export self-contained HTML.
- Zip export of a page: when a sub-page is private, a dialog asks whether to include private pages (off by default). When the page itself is private, it shows a warning instead, and Export includes the page and its sub-pages unencrypted.
- Settings, Folder, Export and Import, "Export Workspace" zips every note and asset. When the folder has private pages, a dialog asks whether to include them unencrypted (off by default).
- "Import Zip" unpacks a zip into the notes folder. Files identical to ones already there are skipped. If any file would overwrite one with different content, or any path would leave the folder, nothing is written.

## Implementation

| File                                       | Role                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `src-tauri/src/export.rs`                  | Zip export (page with sub-pages, workspace) and zip import       |
| `src/services/export.ts`                   | Zip export and import calls, self-contained HTML, clipboard HTML |
| `src/services/pdf.ts`                      | PDF, markdown, and text file downloads                           |
| `src/components/vault/ExportZipDialog.tsx` | The include-private dialog                                       |

- `export_note_zip(id, markdown, dest, includePrivate)` takes the editor's current markdown and adds the page's sub-page folder with the assets its notes use.
- `export_folder_zip(folder, dest, includePrivate)` zips the folder. The workspace export calls it on the whole notes folder and asks only when the folder has a vault.
- Both leave out `vault::current_private_set` unless `includePrivate`.
- `import_zip` (`export::import`) skips entries in app folders (`.git`, `.aether`, ...) but keeps `assets/`. `export::safe_entry_path` refuses absolute paths and `..`, and the Notion import reuses it.

## Tests

`tests/e2e/export.spec.ts` covers the note export menu, HTML and print, the include-private dialog, and the workspace export and import. `src-tauri/src/tests.rs` covers what the zips hold and the import's refusals.
