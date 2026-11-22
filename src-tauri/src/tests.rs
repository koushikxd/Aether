use crate::test_support::TestNotes;

#[test]
fn save_note_writes_markdown_file_named_after_title() {
    let notes = TestNotes::new();
    notes.write("Projects/Plan.md", "# Plan\n");

    let saved = tauri::async_runtime::block_on(crate::save_note(
        None,
        "# Hello World\n\nFirst line.\n".to_string(),
        notes.state(),
    ))
    .expect("save_note");

    notes.save_artifact("save_note_writes_markdown_file_named_after_title");
    assert_eq!(saved.id, "Hello World");
    assert_eq!(
        notes.read("Hello World.md"),
        "# Hello World\n\nFirst line.\n"
    );
    assert_eq!(notes.tree(), ["Hello World.md", "Projects/Plan.md"]);
}

fn copy_image(notes: &TestNotes, source: &std::path::Path) -> Result<String, String> {
    tauri::async_runtime::block_on(crate::copy_image_to_assets(
        source.to_string_lossy().into_owned(),
        notes.state(),
    ))
}

fn paste_image(notes: &TestNotes, bytes: &[u8]) -> Result<String, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    tauri::async_runtime::block_on(crate::save_clipboard_image(data, notes.state()))
}

#[test]
fn copy_image_to_assets_keeps_sanitized_name_and_suffixes_collisions() {
    let notes = TestNotes::new();
    let outside = tempfile::TempDir::new().expect("source dir");
    let source = outside.path().join("Trip: Day 1.png");
    std::fs::write(&source, b"png-bytes").expect("write source");
    notes.write("assets/Trip- Day 1.png", "already here");

    let first = copy_image(&notes, &source).expect("first copy");
    let second = copy_image(&notes, &source).expect("second copy");

    notes.save_artifact("copy_image_to_assets_keeps_sanitized_name_and_suffixes_collisions");
    assert_eq!(first, "assets/Trip- Day 1-1.png");
    assert_eq!(second, "assets/Trip- Day 1-2.png");
    assert_eq!(notes.read("assets/Trip- Day 1-2.png"), "png-bytes");
    assert_eq!(notes.read("assets/Trip- Day 1.png"), "already here");
}

#[test]
fn save_clipboard_image_keeps_the_real_image_type() {
    let notes = TestNotes::new();
    let samples: [(&[u8], &str); 6] = [
        (b"\x89PNG\r\n\x1a\n rest", "png"),
        (b"\xff\xd8\xff\xe0 rest", "jpg"),
        (b"GIF89a rest", "gif"),
        (b"RIFF\x10\0\0\0WEBPVP8 rest", "webp"),
        (b"BM rest", "bmp"),
        (b"II*\0 rest", "tiff"),
    ];

    for (bytes, ext) in samples {
        let saved = paste_image(&notes, bytes).expect("paste");
        assert!(saved.starts_with("assets/screenshot-"), "{saved}");
        assert!(
            saved.ends_with(&format!(".{ext}")),
            "{saved} should end in .{ext}"
        );
        assert_eq!(
            std::fs::read(notes.root().join(&saved)).expect("read"),
            bytes
        );
    }
    notes.save_artifact("save_clipboard_image_keeps_the_real_image_type");
}

#[test]
fn save_clipboard_image_rejects_unknown_data() {
    let notes = TestNotes::new();
    assert_eq!(
        paste_image(&notes, b"plain text, not an image"),
        Err("Unsupported image type".to_string())
    );
    assert!(notes.tree().is_empty(), "{:?}", notes.tree());
}

fn copy_file(notes: &TestNotes, source: &std::path::Path) -> Result<String, String> {
    tauri::async_runtime::block_on(crate::copy_file_to_assets(
        source.to_string_lossy().into_owned(),
        notes.state(),
    ))
}

#[test]
fn copy_file_to_assets_copies_any_file_with_sanitized_name_and_suffixes() {
    let notes = TestNotes::new();
    let outside = tempfile::TempDir::new().expect("source dir");
    let pdf = outside.path().join("Q3: report.pdf");
    let bare = outside.path().join("Makefile");
    std::fs::write(&pdf, b"%PDF-1.7").expect("write pdf");
    std::fs::write(&bare, b"all:").expect("write bare");

    let first = copy_file(&notes, &pdf).expect("first copy");
    let second = copy_file(&notes, &pdf).expect("second copy");
    let no_ext = copy_file(&notes, &bare).expect("copy without extension");

    notes.save_artifact("copy_file_to_assets_copies_any_file_with_sanitized_name_and_suffixes");
    assert_eq!(first, "assets/Q3- report.pdf");
    assert_eq!(second, "assets/Q3- report-1.pdf");
    assert_eq!(no_ext, "assets/Makefile");
    assert_eq!(notes.read("assets/Q3- report-1.pdf"), "%PDF-1.7");
    assert_eq!(
        copy_file(&notes, outside.path()),
        Err("Only files can be attached".to_string())
    );
    assert_eq!(
        copy_file(&notes, &outside.path().join("missing.pdf")),
        Err("Only files can be attached".to_string())
    );
}

#[test]
fn get_asset_size_reads_files_in_assets_only() {
    let notes = TestNotes::new();
    notes.write("assets/report.pdf", "0123456789");
    notes.write("Secret.md", "# Secret\n");
    let size = |rel: &str| {
        let path = notes.root().join(rel).to_string_lossy().into_owned();
        tauri::async_runtime::block_on(crate::get_asset_size(path, notes.state()))
    };

    assert_eq!(size("assets/report.pdf"), Ok(10));
    let refused = Err("Not a file in the assets folder".to_string());
    assert_eq!(size("Secret.md"), refused);
    assert_eq!(size("assets/../Secret.md"), refused);
    assert_eq!(size("assets/missing.pdf"), refused);
}

fn move_note(notes: &TestNotes, id: &str, target: &str) -> String {
    tauri::async_runtime::block_on(crate::move_note(
        id.to_string(),
        target.to_string(),
        notes.state(),
    ))
    .expect("move_note")
}

const TRIP: &str = "# Trip

![Beach](assets/beach%20day.png)
<img src=\"assets/beach%20day.png\" width=\"320\">
[Ticket](assets/ticket.pdf)
[Packing](Lists/Packing%20List.md#shoes \"Packing list\")
[Me](Trip.md#top) [Missing](Nowhere.md)
[Site](https://example.com/x.md) [Top](#top) [[Lists/Packing List]] [Root](/Trip.md)
`[code](Lists/Packing%20List.md)` and ``[code](Trip.md)``

```md
[fenced](Lists/Packing%20List.md)
```
";

const PACKING: &str = "# Packing List

[Trip](../Trip.md#day-1) and [again](<../Trip.md>)
";

const OTHER: &str = "# Other

[Trip](Trip.md) [Missing](Nowhere.md)
~~~
[Trip](Trip.md)
~~~
";

#[test]
fn move_note_rewrites_its_links_and_links_to_it() {
    let notes = TestNotes::new();
    notes.write("Trip.md", TRIP);
    notes.write("Lists/Packing List.md", PACKING);
    notes.write("Other.md", OTHER);
    notes.write("a/b/Readme.md", "# Readme\n");
    notes.write("assets/beach day.png", "png");
    notes.write("assets/ticket.pdf", "pdf");

    assert_eq!(move_note(&notes, "Trip", "a/b"), "a/b/Trip");

    notes.save_artifact("move_note_rewrites_its_links_and_links_to_it");
    assert_eq!(
        notes.read("a/b/Trip.md"),
        "# Trip

![Beach](../../assets/beach%20day.png)
<img src=\"../../assets/beach%20day.png\" width=\"320\">
[Ticket](../../assets/ticket.pdf)
[Packing](../../Lists/Packing%20List.md#shoes \"Packing list\")
[Me](Trip.md#top) [Missing](Nowhere.md)
[Site](https://example.com/x.md) [Top](#top) [[Lists/Packing List]] [Root](/Trip.md)
`[code](Lists/Packing%20List.md)` and ``[code](Trip.md)``

```md
[fenced](Lists/Packing%20List.md)
```
"
    );
    assert_eq!(
        notes.read("Lists/Packing List.md"),
        "# Packing List

[Trip](../a/b/Trip.md#day-1) and [again](../a/b/Trip.md)
"
    );
    assert_eq!(
        notes.read("Other.md"),
        "# Other

[Trip](a/b/Trip.md) [Missing](Nowhere.md)
~~~
[Trip](Trip.md)
~~~
"
    );

    assert_eq!(move_note(&notes, "a/b/Trip", ""), "Trip");

    assert_eq!(notes.read("Trip.md"), TRIP);
    assert_eq!(
        notes.read("Lists/Packing List.md"),
        "# Packing List

[Trip](../Trip.md#day-1) and [again](../Trip.md)
"
    );
    assert_eq!(notes.read("Other.md"), OTHER);
}

#[test]
fn move_folder_rewrites_links_inside_and_into_it() {
    let notes = TestNotes::new();
    notes.write(
        "Projects/Plan.md",
        "# Plan\n\n[Notes](Notes.md) [Inbox](../Inbox.md) ![](../assets/x.png) [Spec](spec.pdf)\n",
    );
    notes.write("Projects/Deep/Notes.md", "# Notes\n\n[Plan](../Plan.md#goals)\n");
    notes.write("Projects/Notes.md", "# Notes\n\n[Plan](Plan.md)\n");
    notes.write("Projects/spec.pdf", "pdf");
    notes.write("assets/x.png", "png");
    notes.write(
        "Inbox.md",
        "# Inbox\n\n[Plan](Projects/Plan.md) [Spec](Projects/spec.pdf) [Deep](Projects/Deep/Notes.md)\n",
    );

    tauri::async_runtime::block_on(crate::move_folder(
        "Projects".to_string(),
        "Archive/2026".to_string(),
        notes.state(),
    ))
    .expect("move_folder");

    notes.save_artifact("move_folder_rewrites_links_inside_and_into_it");
    assert_eq!(
        notes.read("Archive/2026/Projects/Plan.md"),
        "# Plan\n\n[Notes](Notes.md) [Inbox](../../../Inbox.md) ![](../../../assets/x.png) [Spec](spec.pdf)\n"
    );
    assert_eq!(
        notes.read("Archive/2026/Projects/Deep/Notes.md"),
        "# Notes\n\n[Plan](../Plan.md#goals)\n"
    );
    assert_eq!(
        notes.read("Archive/2026/Projects/Notes.md"),
        "# Notes\n\n[Plan](Plan.md)\n"
    );
    assert_eq!(
        notes.read("Inbox.md"),
        "# Inbox\n\n[Plan](Archive/2026/Projects/Plan.md) [Spec](Archive/2026/Projects/spec.pdf) [Deep](Archive/2026/Projects/Deep/Notes.md)\n"
    );
}

#[test]
fn rename_folder_rewrites_links_into_it() {
    let notes = TestNotes::new();
    notes.write("Projects/Plan.md", "# Plan\n\n[Inbox](../Inbox.md)\n");
    notes.write("Inbox.md", "# Inbox\n\n[Plan](Projects/Plan.md)\n");

    tauri::async_runtime::block_on(crate::rename_folder(
        "Projects".to_string(),
        "Work Stuff".to_string(),
        notes.state(),
    ))
    .expect("rename_folder");

    notes.save_artifact("rename_folder_rewrites_links_into_it");
    assert_eq!(notes.read("Work Stuff/Plan.md"), "# Plan\n\n[Inbox](../Inbox.md)\n");
    assert_eq!(notes.read("Inbox.md"), "# Inbox\n\n[Plan](Work%20Stuff/Plan.md)\n");
}

#[test]
fn save_note_title_rename_rewrites_links_to_the_note() {
    let notes = TestNotes::new();
    notes.write("a/Draft.md", "# Draft\n\n[Self](Draft.md)\n");
    notes.write("Index.md", "# Index\n\n[Draft](a/Draft.md#intro) [Kept](a/Draft.mdx)\n");

    let saved = tauri::async_runtime::block_on(crate::save_note(
        Some("a/Draft".to_string()),
        "# Final Plan\n\n[Self](Draft.md)\n".to_string(),
        notes.state(),
    ))
    .expect("save_note");

    notes.save_artifact("save_note_title_rename_rewrites_links_to_the_note");
    assert_eq!(saved.id, "a/Final Plan");
    assert_eq!(saved.content, "# Final Plan\n\n[Self](Final%20Plan.md)\n");
    assert_eq!(notes.read("a/Final Plan.md"), saved.content);
    assert_eq!(
        notes.read("Index.md"),
        "# Index\n\n[Draft](a/Final%20Plan.md#intro) [Kept](a/Draft.mdx)\n"
    );
    assert_eq!(notes.tree(), ["Index.md", "a/Final Plan.md"]);
}

fn run<T>(future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::block_on(future)
}

fn pinned(notes: &TestNotes) -> Vec<String> {
    notes
        .state()
        .settings
        .read()
        .expect("settings read lock")
        .pinned_note_ids
        .clone()
        .unwrap_or_default()
}

fn pin(notes: &TestNotes, ids: &[&str]) {
    notes.state().settings.write().expect("settings write lock").pinned_note_ids =
        Some(ids.iter().map(|id| id.to_string()).collect());
}

#[test]
fn list_output_holds_a_page_as_note_and_folder_with_the_same_path() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/Child.md", "# Child\n");
    notes.write("Folder/Note.md", "# Note\n");

    let mut ids: Vec<String> = run(crate::list_notes(notes.state()))
        .expect("list_notes")
        .into_iter()
        .map(|n| n.id)
        .collect();
    ids.sort();
    let folders = run(crate::list_folders(notes.state())).expect("list_folders");

    assert_eq!(ids, ["Folder/Note", "Page", "Page/Child"]);
    assert_eq!(folders, ["Folder", "Page"]);
}

#[test]
fn create_note_in_a_page_creates_its_sub_page_folder() {
    let notes = TestNotes::new();
    notes.write("a/Page.md", "# Page\n");

    let created = run(crate::create_note(Some("a/Page".to_string()), notes.state()))
        .expect("create_note");

    notes.save_artifact("create_note_in_a_page_creates_its_sub_page_folder");
    assert_eq!(created.id, "a/Page/Untitled");
    assert_eq!(notes.tree(), ["a/Page.md", "a/Page/Untitled.md"]);
    assert_eq!(notes.read("a/Page/Untitled.md"), "# Untitled\n\n");
}

#[test]
fn renaming_a_page_through_its_title_moves_its_sub_pages() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n\n[Child](Page/Child.md)\n");
    notes.write("Page/Child.md", "# Child\n\n[Up](../Page.md) [Deep](Deep/Leaf.md)\n");
    notes.write("Page/Deep/Leaf.md", "# Leaf\n\n[Top](../../Page.md)\n");
    notes.write("Index.md", "# Index\n\n[Page](Page.md) [Leaf](Page/Deep/Leaf.md)\n");
    pin(&notes, &["Page", "Page/Deep/Leaf", "Index"]);

    let saved = run(crate::save_note(
        Some("Page".to_string()),
        "# New Name\n\n[Child](Page/Child.md)\n".to_string(),
        notes.state(),
    ))
    .expect("save_note");

    notes.save_artifact("renaming_a_page_through_its_title_moves_its_sub_pages");
    assert_eq!(saved.id, "New Name");
    assert_eq!(saved.content, "# New Name\n\n[Child](New%20Name/Child.md)\n");
    assert_eq!(
        notes.tree(),
        [
            ".aether/settings.json",
            "Index.md",
            "New Name.md",
            "New Name/Child.md",
            "New Name/Deep/Leaf.md"
        ]
    );
    assert_eq!(
        notes.read("New Name/Child.md"),
        "# Child\n\n[Up](../New%20Name.md) [Deep](Deep/Leaf.md)\n"
    );
    assert_eq!(notes.read("New Name/Deep/Leaf.md"), "# Leaf\n\n[Top](../../New%20Name.md)\n");
    assert_eq!(
        notes.read("Index.md"),
        "# Index\n\n[Page](New%20Name.md) [Leaf](New%20Name/Deep/Leaf.md)\n"
    );
    assert_eq!(pinned(&notes), ["New Name", "New Name/Deep/Leaf", "Index"]);
}

#[test]
fn renaming_a_page_skips_titles_whose_folder_is_taken() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/Child.md", "# Child\n");
    notes.write("Taken/Other.md", "# Other\n");

    let saved = run(crate::save_note(
        Some("Page".to_string()),
        "# Taken\n".to_string(),
        notes.state(),
    ))
    .expect("save_note");

    assert_eq!(saved.id, "Taken-1");
    assert_eq!(notes.tree(), ["Taken-1.md", "Taken-1/Child.md", "Taken/Other.md"]);
}

#[test]
fn renaming_a_page_skips_titles_that_are_reserved_folders() {
    let notes = TestNotes::new();
    notes.write("Folder/Page.md", "# Page\n");
    notes.write("Folder/Page/Child.md", "# Child\n");

    let saved = save(&notes, Some("Folder/Page"), "# Assets\n").expect("save_note");

    assert_eq!(saved.id, "Folder/Assets-1");
    assert_eq!(notes.tree(), ["Folder/Assets-1.md", "Folder/Assets-1/Child.md"]);

    // `build` is ignored by default, so the sub-pages would vanish there too
    let saved = save(&notes, Some("Folder/Assets-1"), "# build\n").expect("save_note");
    assert_eq!(saved.id, "Folder/build-1");
}

#[test]
fn new_sub_pages_of_a_page_named_like_a_hidden_folder_are_refused() {
    let notes = TestNotes::new();
    notes.write("Folder/build.md", "# build\n");

    let created = run(crate::create_note(Some("Folder/build".to_string()), notes.state()));

    assert_eq!(
        created.map(|note| note.id),
        Err("The sidebar hides notes in a folder named \"build\". Rename the page first.".to_string())
    );
    assert_eq!(notes.tree(), ["Folder/build.md"]);
}

#[test]
fn a_note_named_like_a_reserved_folder_can_still_move() {
    let notes = TestNotes::new();
    notes.write("Assets.md", "# Assets\n");
    notes.write("Folder/Other.md", "# Other\n");

    assert_eq!(move_note(&notes, "Assets", "Folder"), "Folder/Assets");
}

#[test]
fn deleting_a_page_deletes_its_sub_pages() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/A.md", "# A\n");
    notes.write("Page/B.md", "# B\n");
    notes.write("Page/B/C.md", "# C\n");
    notes.write("Page/spec.pdf", "pdf");
    notes.write("Page 2.md", "# Page 2\n");
    notes.write("Pages/Kept.md", "# Kept\n");

    run(crate::delete_note("Page".to_string(), notes.state())).expect("delete_note");

    notes.save_artifact("deleting_a_page_deletes_its_sub_pages");
    assert_eq!(notes.tree(), ["Page 2.md", "Pages/Kept.md"]);
    assert!(!notes.root().join("Page").exists());
}

#[test]
fn deleting_a_page_whose_file_is_gone_keeps_the_folder_of_the_same_name() {
    let notes = TestNotes::new();
    notes.write("Page/x.md", "# x\n");

    run(crate::delete_note("Page".to_string(), notes.state())).expect("delete_note");

    assert_eq!(notes.tree(), ["Page/x.md"]);
}

#[test]
fn deleting_the_last_sub_page_turns_the_page_back_into_a_note() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/A.md", "# A\n");
    notes.write("Page/B.md", "# B\n");
    std::fs::create_dir(notes.root().join("Empty")).expect("create plain folder");
    notes.write("Empty/Last.md", "# Last\n");

    run(crate::delete_note("Page/A".to_string(), notes.state())).expect("delete A");
    assert!(notes.root().join("Page").is_dir());
    run(crate::delete_note("Page/B".to_string(), notes.state())).expect("delete B");
    run(crate::delete_note("Empty/Last".to_string(), notes.state())).expect("delete Last");

    assert!(!notes.root().join("Page").exists());
    assert!(notes.root().join("Empty").is_dir(), "plain folders stay");
    assert_eq!(notes.tree(), ["Page.md"]);
}

#[test]
fn moving_a_page_moves_its_sub_pages() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n\n[Child](Page/Child.md) ![](assets/x.png)\n");
    notes.write("Page/Child.md", "# Child\n\n[Up](../Page.md) ![](../assets/x.png)\n");
    notes.write("Index.md", "# Index\n\n[Page](Page.md) [Child](Page/Child.md)\n");
    notes.write("Archive/Old.md", "# Old\n");
    notes.write("assets/x.png", "png");
    pin(&notes, &["Page/Child"]);

    assert_eq!(move_note(&notes, "Page", "Archive"), "Archive/Page");

    notes.save_artifact("moving_a_page_moves_its_sub_pages");
    assert_eq!(
        notes.tree(),
        [
            ".aether/settings.json",
            "Archive/Old.md",
            "Archive/Page.md",
            "Archive/Page/Child.md",
            "Index.md",
            "assets/x.png"
        ]
    );
    assert_eq!(
        notes.read("Archive/Page.md"),
        "# Page\n\n[Child](Page/Child.md) ![](../assets/x.png)\n"
    );
    assert_eq!(
        notes.read("Archive/Page/Child.md"),
        "# Child\n\n[Up](../Page.md) ![](../../assets/x.png)\n"
    );
    assert_eq!(
        notes.read("Index.md"),
        "# Index\n\n[Page](Archive/Page.md) [Child](Archive/Page/Child.md)\n"
    );
    assert_eq!(pinned(&notes), ["Archive/Page/Child"]);
}

#[test]
fn moving_a_note_into_a_note_makes_it_a_sub_page_and_moving_it_out_undoes_that() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Loose.md", "# Loose\n");

    assert_eq!(move_note(&notes, "Loose", "Page"), "Page/Loose");
    assert_eq!(notes.tree(), ["Page.md", "Page/Loose.md"]);

    assert_eq!(move_note(&notes, "Page/Loose", ""), "Loose");
    assert!(!notes.root().join("Page").exists());
    assert_eq!(notes.tree(), ["Loose.md", "Page.md"]);
}

#[test]
fn a_page_cannot_move_into_its_own_sub_pages() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/Child.md", "# Child\n");

    for target in ["Page", "Page/Child"] {
        assert_eq!(
            run(crate::move_note("Page".to_string(), target.to_string(), notes.state())),
            Err("Cannot move a page into its own sub-pages".to_string())
        );
    }
    assert_eq!(notes.tree(), ["Page.md", "Page/Child.md"]);
}

fn search(notes: &TestNotes, query: &str) -> Vec<String> {
    let state = notes.state();
    let guard = state.search_index.lock().expect("search index mutex");
    let index = guard.as_ref().expect("search index");
    index.reader.reload().expect("reload reader");
    let mut ids: Vec<String> = index
        .search(query, 10)
        .expect("search")
        .into_iter()
        .map(|r| r.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn search_index_follows_page_renames_and_deletes() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n\nzebra\n");
    notes.write("Page/Child.md", "# Child\n\nzebra\n");
    let index_dir = tempfile::TempDir::new().expect("index dir");
    let index = crate::SearchIndex::new(&index_dir.path().to_path_buf()).expect("index");
    index.rebuild_index(&notes.root().to_path_buf(), &[]).expect("rebuild");
    *notes.state().search_index.lock().expect("search index mutex") = Some(index);
    // The app lists notes on start, which fills the cache
    run(crate::list_notes(notes.state())).expect("list_notes");
    assert_eq!(search(&notes, "zebra"), ["Page", "Page/Child"]);

    run(crate::save_note(
        Some("Page".to_string()),
        "# New\n\nzebra\n".to_string(),
        notes.state(),
    ))
    .expect("save_note");
    assert_eq!(search(&notes, "zebra"), ["New", "New/Child"]);

    move_note(&notes, "New", "Archive");
    assert_eq!(search(&notes, "zebra"), ["Archive/New", "Archive/New/Child"]);

    run(crate::delete_note("Archive/New".to_string(), notes.state())).expect("delete_note");
    assert!(search(&notes, "zebra").is_empty());
}

/// Indexes the notes folder and fills the notes cache, as the app does on
/// start. Keep the returned dir alive while searching.
fn index_notes(notes: &TestNotes) -> tempfile::TempDir {
    let index_dir = tempfile::TempDir::new().expect("index dir");
    let index = crate::SearchIndex::new(&index_dir.path().to_path_buf()).expect("index");
    index.rebuild_index(&notes.root().to_path_buf(), &[]).expect("rebuild");
    *notes.state().search_index.lock().expect("search index mutex") = Some(index);
    run(crate::list_notes(notes.state())).expect("list_notes");
    index_dir
}

fn search_notes(notes: &TestNotes, query: &str) -> Vec<crate::SearchResult> {
    let state = notes.state();
    state
        .search_index
        .lock()
        .expect("search index mutex")
        .as_ref()
        .expect("search index")
        .reader
        .reload()
        .expect("reload reader");
    run(crate::search_notes(query.to_string(), notes.state())).expect("search_notes")
}

#[test]
fn search_matches_typed_words_in_order_with_a_partial_last_word() {
    let notes = TestNotes::new();
    notes.write("Standup.md", "# Standup\n\nThe meeting notes are here.\n");
    notes.write("Agenda.md", "# Agenda\n\nA meeting about the roadmap.\n");
    let _index_dir = index_notes(&notes);

    assert_eq!(search(&notes, "meeting no"), ["Standup"]);
    assert_eq!(search(&notes, "meet"), ["Agenda", "Standup"]);
}

#[test]
fn search_does_not_match_words_out_of_order() {
    let notes = TestNotes::new();
    notes.write("Standup.md", "# Standup\n\nThe meeting notes are here.\n");
    let _index_dir = index_notes(&notes);

    assert!(search(&notes, "notes meeting").is_empty());
    assert!(search_notes(&notes, "notes meeting").is_empty());
}

#[test]
fn search_ranks_title_matches_above_body_matches() {
    let notes = TestNotes::new();
    notes.write(
        "Meeting Notes.md",
        &format!("# Meeting Notes\n\n{}\n", "A long body about other things. ".repeat(20)),
    );
    notes.write("Weekly.md", "# Weekly\n\nmeeting notes, meeting notes, meeting notes\n");
    for i in 0..20 {
        notes.write(&format!("Other {i}.md"), &format!("# Other {i}\n\nunrelated text\n"));
    }
    let _index_dir = index_notes(&notes);

    let results = search_notes(&notes, "meeting notes");
    crate::test_support::save_text_artifact(
        "search_ranks_title_matches_above_body_matches",
        &format!("{results:#?}"),
    );
    let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["Meeting Notes", "Weekly"]);
}

#[test]
fn search_preview_is_a_snippet_around_the_match() {
    let notes = TestNotes::new();
    notes.write(
        "Log.md",
        &format!(
            "# Log\n\n{}\n\nWe wrote meeting notes today.\n",
            "Filler sentence about the garden. ".repeat(10)
        ),
    );
    let _index_dir = index_notes(&notes);

    let phrase = search_notes(&notes, "meeting no");
    let prefix = search_notes(&notes, "meet");
    crate::test_support::save_text_artifact(
        "search_preview_is_a_snippet_around_the_match",
        &format!("{phrase:#?}\n{prefix:#?}"),
    );
    assert!(phrase[0].preview.contains("meeting notes"), "{:?}", phrase[0].preview);
    assert!(prefix[0].preview.contains("meeting"), "{:?}", prefix[0].preview);
}

#[test]
fn search_preview_is_the_line_holding_the_phrase() {
    let notes = TestNotes::new();
    notes.write(
        "Log.md",
        &format!(
            "# Log\n\n{}\n\n{}\n\nWe wrote meeting notes today.\n",
            "meeting tomorrow, ".repeat(10),
            "Filler sentence about the garden. ".repeat(8)
        ),
    );
    let _index_dir = index_notes(&notes);

    let results = search_notes(&notes, "meeting no");
    crate::test_support::save_text_artifact(
        "search_preview_is_the_line_holding_the_phrase",
        &format!("{results:#?}"),
    );
    assert!(results[0].preview.contains("meeting notes"), "{:?}", results[0].preview);
}

#[test]
fn search_expands_a_partial_word_past_fifty_completions() {
    let notes = TestNotes::new();
    // 78 words that sort before "notes" and share its "no" prefix
    let words: Vec<String> = ('a'..='c')
        .flat_map(|a| ('a'..='z').map(move |b| format!("no{a}{b}")))
        .collect();
    notes.write(
        "Standup.md",
        &format!("# Standup\n\nThe meeting notes are here.\n\n{}\n", words.join(" ")),
    );
    let _index_dir = index_notes(&notes);

    // The index alone, so the substring fallback cannot hide a miss
    assert_eq!(search(&notes, "meeting no"), ["Standup"]);
}

#[test]
fn search_falls_back_to_substring_matching_when_the_index_finds_nothing() {
    let notes = TestNotes::new();
    notes.write("Standup.md", "# Standup\n\nFirst paragraph.\n\nThe meeting notes are here.\n");
    let _index_dir = index_notes(&notes);

    assert!(search(&notes, "eting no").is_empty());
    let results = search_notes(&notes, "eting no");
    let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["Standup"]);
    assert_eq!(results[0].preview, "The meeting notes are here.");
}

const PLAN: &str = "# Plan

<img src=\"../../assets/chart.png\" width=\"320\">

[spec v2.pdf](../../assets/spec%20v2.pdf)

Back [home](../../Home.md), see [Sub](Plan/Sub.md).

`![](../../assets/unused.png)`
";

const SUB: &str = "# Sub

![](../../../assets/sub.png)

Up to [Plan](../Plan.md)
";

/// Notes at three depths, a page with a sub-page, an empty folder, images
/// (one not valid UTF-8), a file card, links between notes, and files that
/// exports leave out.
fn sample_workspace() -> TestNotes {
    let notes = TestNotes::new();
    notes.write(
        "Home.md",
        "# Home\n\n[Plan](Work/Projects/Plan.md) and ![logo](assets/logo.png)\n",
    );
    notes.write("Work/Projects/Plan.md", PLAN);
    notes.write("Work/Projects/Plan/Sub.md", SUB);
    std::fs::create_dir_all(notes.root().join("Work/Projects/Empty")).expect("empty folder");
    notes.write_bytes("assets/logo.png", b"\x89PNG\r\n\x1a\n\xff\x00logo");
    notes.write_bytes("assets/chart.png", b"\x89PNG chart");
    notes.write_bytes("assets/spec v2.pdf", b"%PDF-1.7 spec");
    notes.write_bytes("assets/sub.png", b"\x89PNG sub");
    notes.write_bytes("assets/unused.png", b"\x89PNG unused");
    notes.write(".aether/settings.json", "{}");
    notes.write(".git/HEAD", "ref: refs/heads/main\n");
    notes.write("node_modules/pkg/README.md", "# Package\n");
    notes.write("Work/notes.txt", "not a note");
    notes
}

fn export_folder(notes: &TestNotes, folder: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let out = tempfile::TempDir::new().expect("output dir");
    let dest = out.path().join("export.zip");
    run(crate::export_folder_zip(
        folder.to_string(),
        dest.to_string_lossy().into_owned(),
        false,
        notes.state(),
    ))
    .expect("export_folder_zip");
    (out, dest)
}

fn import(notes: &TestNotes, zip: &std::path::Path) -> Result<usize, String> {
    run(crate::import_zip(zip.to_string_lossy().into_owned(), notes.state()))
}

fn bytes(notes: &TestNotes, rel: &str) -> Vec<u8> {
    std::fs::read(notes.root().join(rel)).expect("read file")
}

/// Every entry of a zip, as `(name, content)`, sorted by name.
fn zip_entries(path: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(path).expect("open zip")).expect("read zip");
    let mut entries: Vec<(String, Vec<u8>)> = (0..archive.len())
        .map(|i| {
            let mut file = archive.by_index(i).expect("zip entry");
            let mut content = Vec::new();
            file.read_to_end(&mut content).expect("read entry");
            (file.name().expect("entry name").into_owned(), content)
        })
        .collect();
    entries.sort();
    entries
}

#[test]
fn workspace_zip_imports_into_an_empty_folder_as_the_same_tree() {
    let notes = sample_workspace();
    let (_out, zip) = export_folder(&notes, "");
    let fresh = TestNotes::new();

    let imported = import(&fresh, &zip).expect("import_zip");

    fresh.save_artifact("workspace_zip_imports_into_an_empty_folder_as_the_same_tree");
    let exported = [
        "Home.md",
        "Work/Projects/Plan.md",
        "Work/Projects/Plan/Sub.md",
        "assets/chart.png",
        "assets/logo.png",
        "assets/spec v2.pdf",
        "assets/sub.png",
        "assets/unused.png",
    ];
    assert_eq!(fresh.tree(), exported);
    for rel in exported {
        assert_eq!(bytes(&fresh, rel), bytes(&notes, rel), "{rel}");
    }
    assert!(fresh.root().join("Work/Projects/Empty").is_dir());
    assert_eq!(imported, exported.len());
}

#[test]
fn folder_zip_holds_its_notes_and_only_the_assets_they_use() {
    let notes = sample_workspace();
    let (_out, zip) = export_folder(&notes, "Work/Projects");
    let fresh = TestNotes::new();

    import(&fresh, &zip).expect("import_zip");

    fresh.save_artifact("folder_zip_holds_its_notes_and_only_the_assets_they_use");
    assert_eq!(
        fresh.tree(),
        [
            "Projects/Plan.md",
            "Projects/Plan/Sub.md",
            "assets/chart.png",
            "assets/spec v2.pdf",
            "assets/sub.png",
        ]
    );
    assert_eq!(
        fresh.read("Projects/Plan.md"),
        "# Plan

<img src=\"../assets/chart.png\" width=\"320\">

[spec v2.pdf](../assets/spec%20v2.pdf)

Back [home](../Home.md), see [Sub](Plan/Sub.md).

`![](../../assets/unused.png)`
"
    );
    assert_eq!(
        fresh.read("Projects/Plan/Sub.md"),
        "# Sub\n\n![](../../assets/sub.png)\n\nUp to [Plan](../Plan.md)\n"
    );
    assert!(fresh.root().join("Projects/Empty").is_dir());
    assert_eq!(bytes(&fresh, "assets/sub.png"), bytes(&notes, "assets/sub.png"));
}

#[test]
fn note_zip_holds_the_note_at_its_root_and_the_assets_it_uses() {
    let notes = sample_workspace();
    let out = tempfile::TempDir::new().expect("output dir");
    let dest = out.path().join("Plan.zip");

    run(crate::export_note_zip(
        "Work/Projects/Plan".to_string(),
        PLAN.to_string(),
        dest.to_string_lossy().into_owned(),
        notes.state(),
    ))
    .expect("export_note_zip");

    let entries = zip_entries(&dest);
    let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["Plan.md", "assets/chart.png", "assets/spec v2.pdf"]);
    assert_eq!(
        String::from_utf8_lossy(&entries[0].1),
        "# Plan

<img src=\"assets/chart.png\" width=\"320\">

[spec v2.pdf](assets/spec%20v2.pdf)

Back [home](Home.md), see [Sub](Work/Projects/Plan/Sub.md).

`![](../../assets/unused.png)`
"
    );
    assert_eq!(entries[1].1, bytes(&notes, "assets/chart.png"));
}

/// The editor saves a resized image as `<img>` with its path HTML-escaped.
const ESCAPED_IMG: &str = "# A\n\n<img src=\"assets/R&amp;D.png\" width=\"300\">\n";

#[test]
fn moving_a_note_rewrites_html_escaped_image_paths() {
    let notes = TestNotes::new();
    notes.write("A.md", ESCAPED_IMG);
    notes.write("assets/R&D.png", "png");
    notes.write("Folder/Other.md", "# Other\n");

    move_note(&notes, "A", "Folder");

    assert_eq!(
        notes.read("Folder/A.md"),
        "# A\n\n<img src=\"../assets/R&amp;D.png\" width=\"300\">\n"
    );
}

#[test]
fn note_zip_holds_images_whose_html_path_is_escaped() {
    let notes = TestNotes::new();
    notes.write("A.md", ESCAPED_IMG);
    notes.write("assets/R&D.png", "png");
    let out = tempfile::TempDir::new().expect("output dir");
    let dest = out.path().join("A.zip");

    run(crate::export_note_zip(
        "A".to_string(),
        ESCAPED_IMG.to_string(),
        dest.to_string_lossy().into_owned(),
        notes.state(),
    ))
    .expect("export_note_zip");

    let entries = zip_entries(&dest);
    let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["A.md", "assets/R&D.png"]);
}

fn zip_with(entries: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf) {
    use std::io::Write;
    let out = tempfile::TempDir::new().expect("output dir");
    let path = out.path().join("crafted.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).expect("create zip"));
    for (name, content) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .expect("start entry");
        zip.write_all(content.as_bytes()).expect("write entry");
    }
    zip.finish().expect("finish zip");
    (out, path)
}

#[test]
fn import_zip_rejects_paths_that_leave_the_folder_and_writes_nothing() {
    for bad in ["../evil.md", "a/../../evil.md", "/tmp/aether-evil.md"] {
        let notes = TestNotes::new();
        let (_out, zip) = zip_with(&[("ok.md", "# Ok\n"), (bad, "# Evil\n")]);

        let result = import(&notes, &zip);

        assert!(
            result.as_ref().is_err_and(|e| e.contains(bad)),
            "{bad}: {result:?}"
        );
        assert!(notes.tree().is_empty(), "{bad}: {:?}", notes.tree());
        assert!(!notes.root().parent().expect("parent").join("evil.md").exists());
    }
    assert!(!std::path::Path::new("/tmp/aether-evil.md").exists());
}

#[test]
fn import_zip_skips_app_folders() {
    let notes = TestNotes::new();
    let (_out, zip) = zip_with(&[
        ("Note.md", "# Note\n"),
        (".git/config", "[core]\n"),
        (".GIT/hooks/post-commit", "#!/bin/sh\n"),
        (".aether/settings.json", "{}"),
    ]);

    assert_eq!(import(&notes, &zip), Ok(1));
    assert_eq!(notes.tree(), ["Note.md"]);
}

#[test]
fn import_zip_skips_identical_files_and_refuses_to_overwrite_others() {
    let notes = sample_workspace();
    let (_out, zip) = export_folder(&notes, "Work/Projects");
    let fresh = TestNotes::new();
    fresh.write("Projects/Plan.md", "# My own plan\n");
    fresh.write_bytes("assets/chart.png", &bytes(&notes, "assets/chart.png"));

    let refused = import(&fresh, &zip);

    fresh.save_artifact("import_zip_skips_identical_files_and_refuses_to_overwrite_others");
    assert!(
        refused.as_ref().is_err_and(|e| e.contains("Projects/Plan.md")),
        "{refused:?}"
    );
    assert_eq!(fresh.tree(), ["Projects/Plan.md", "assets/chart.png"]);
    assert_eq!(fresh.read("Projects/Plan.md"), "# My own plan\n");

    std::fs::remove_file(fresh.root().join("Projects/Plan.md")).expect("remove");
    assert_eq!(import(&fresh, &zip), Ok(4));
    assert_eq!(import(&fresh, &zip), Ok(0));
}

#[test]
fn read_asset_base64_reads_files_inside_the_notes_folder_only() {
    use base64::Engine;
    let notes = sample_workspace();
    let read = |path: &str| run(crate::read_asset_base64(path.to_string(), notes.state()));

    assert_eq!(
        read("assets/logo.png"),
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes(&notes, "assets/logo.png")))
    );
    assert!(read("../outside.png").is_err());
    assert!(read("/etc/hosts").is_err());
}

fn notion_fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/notion")
}

/// The fixture zip's entries, as `(name, content)`, in zip order.
fn notion_fixture_entries() -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let file = std::fs::File::open(notion_fixture_dir().join("aether-import-fixture.zip"))
        .expect("open fixture");
    let mut archive = zip::ZipArchive::new(file).expect("read fixture");
    (0..archive.len())
        .map(|i| {
            let mut entry = archive.by_index(i).expect("zip entry");
            let mut content = Vec::new();
            entry.read_to_end(&mut content).expect("read entry");
            (entry.name().expect("entry name").into_owned(), content)
        })
        .collect()
}

fn write_zip(path: &std::path::Path, entries: &[(String, Vec<u8>)]) {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).expect("create zip"));
    for (name, content) in entries {
        zip.start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .expect("start entry");
        zip.write_all(content).expect("write entry");
    }
    zip.finish().expect("finish zip");
}

fn import_notion(
    notes: &TestNotes,
    zips: &[std::path::PathBuf],
) -> crate::notion_import::Summary {
    crate::notion_import::import(notes.root(), zips, None, &crate::get_default_ignored_patterns(), |_, _| {}).expect("notion import")
}

const NOTION_TREE: [&str; 12] = [
    "Notion Import/Aether Import Fixture.md",
    "Notion Import/Aether Import Fixture/Child Page-1.md",
    "Notion Import/Aether Import Fixture/Child Page.md",
    "Notion Import/Aether Import Fixture/Child Page/Grandchild Page.md",
    "Notion Import/Aether Import Fixture/Tasks DB.md",
    "Notion Import/Aether Import Fixture/Tasks DB/Check layout.md",
    "Notion Import/Aether Import Fixture/Tasks DB/Draft outline.md",
    "Notion Import/Aether Import Fixture/Tasks DB/Review export.md",
    "Notion Import/Aether Import Fixture/Untitled.md",
    "assets/fixture-document.pdf",
    "assets/image-1.png",
    "assets/image.png",
];

/// The notes match `tests/fixtures/notion/expected/` byte for byte (the E2E
/// test `notion-import.spec.ts` checks that the editor saves those back
/// unchanged), and the assets are the fixture's files.
fn assert_imported_fixture(notes: &TestNotes) {
    assert_eq!(notes.tree(), NOTION_TREE);
    let expected = notion_fixture_dir().join("expected");
    for path in NOTION_TREE.iter().filter(|p| p.ends_with(".md")) {
        let golden = std::fs::read_to_string(expected.join(path)).expect("read expected note");
        assert_eq!(notes.read(path), golden, "{path}");
    }
    let entries = notion_fixture_entries();
    let fixture_file = |name: &str| {
        entries
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, content)| content.clone())
            .expect("fixture file")
    };
    for (asset, source) in [
        ("assets/image.png", "Aether Import Fixture/image.png"),
        ("assets/image-1.png", "Aether Import Fixture/Child Page/image.png"),
        ("assets/fixture-document.pdf", "Aether Import Fixture/fixture-document.pdf"),
    ] {
        assert_eq!(bytes(notes, asset), fixture_file(source), "{asset}");
    }
}

#[test]
fn notion_import_maps_the_fixture_export() {
    let notes = TestNotes::new();
    let mut progress = Vec::new();

    let summary = crate::notion_import::import(
        notes.root(),
        &[notion_fixture_dir().join("aether-import-fixture.zip")],
        None,
        &crate::get_default_ignored_patterns(),
        |current, total| progress.push((current, total)),
    )
    .expect("notion import");

    notes.save_artifact("notion_import_maps_the_fixture_export");
    assert_imported_fixture(&notes);
    assert_eq!(summary.folder, "Notion Import");
    assert_eq!((summary.pages, summary.images, summary.files), (9, 2, 1));
    assert_eq!(summary.skipped, []);
    assert_eq!(progress.first(), Some(&(1, 9)));
    assert_eq!(progress.last(), Some(&(9, 9)));
}

#[test]
fn notion_import_joins_a_multi_part_export() {
    let notes = TestNotes::new();
    let out = tempfile::TempDir::new().expect("parts dir");
    let entries = notion_fixture_entries();
    let (first, second): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .enumerate()
        .partition(|(i, _)| i % 2 == 0);
    let parts = [first, second].map(|part| part.into_iter().map(|(_, e)| e).collect::<Vec<_>>());
    let paths = [1, 2].map(|n| out.path().join(format!("Export-Part-{n}.zip")));
    write_zip(&paths[0], &parts[0]);
    write_zip(&paths[1], &parts[1]);

    import_notion(&notes, &paths);

    assert_imported_fixture(&notes);
}

#[test]
fn notion_import_opens_part_zips_wrapped_in_an_outer_zip() {
    let notes = TestNotes::new();
    let out = tempfile::TempDir::new().expect("parts dir");
    let entries = notion_fixture_entries();
    let (first, second) = entries.split_at(5);
    let part = |n: usize, entries: &[(String, Vec<u8>)]| {
        let path = out.path().join(format!("Export-Part-{n}.zip"));
        write_zip(&path, entries);
        (format!("Export-Part-{n}.zip"), std::fs::read(path).expect("read part"))
    };
    let outer = out.path().join("Export.zip");
    write_zip(&outer, &[part(1, first), part(2, second)]);

    import_notion(&notes, &[outer]);

    assert_imported_fixture(&notes);
}

#[test]
fn notion_import_into_a_taken_folder_name_adds_a_suffix() {
    let notes = TestNotes::new();
    let zip = notion_fixture_dir().join("aether-import-fixture.zip");
    import_notion(&notes, std::slice::from_ref(&zip));

    let summary = import_notion(&notes, &[zip]);

    assert_eq!(summary.folder, "Notion Import-1");
    let page = notes.read("Notion Import-1/Aether Import Fixture.md");
    assert!(page.contains(r#"<img src="../assets/image-2.png" width="32">"#), "{page}");
    assert!(page.contains("[Child Page](Aether%20Import%20Fixture/Child%20Page-1.md)"), "{page}");
    assert_eq!(
        notes.read("Notion Import-1/Aether Import Fixture/Child Page.md"),
        notes.read("Notion Import/Aether Import Fixture/Child Page.md")
            .replace("image-1.png", "image-3.png")
    );
}

const NOTION_PAGE_ID: &str = "0123456789abcdef0123456789abcdef";

fn notion_page(title: &str, body: &str) -> String {
    format!(
        r#"<html><body><article class="page sans"><header><h1 class="page-title">{title}</h1></header><div class="page-body">{body}</div></article></body></html>"#
    )
}

#[test]
fn notion_import_keeps_unknown_blocks_and_missing_files_as_text_and_lists_them() {
    let notes = TestNotes::new();
    let out = tempfile::TempDir::new().expect("zip dir");
    let zip = out.path().join("export.zip");
    let body = r#"<p>Before</p><div class="mystery-block">Kept as text</div><figure class="image"><a href="Page/missing.png"><img src="Page/missing.png"/></a></figure><p>After</p>"#;
    write_zip(
        &zip,
        &[(format!("Page {NOTION_PAGE_ID}.html"), notion_page("Page", body).into_bytes())],
    );

    let summary = import_notion(&notes, &[zip]);

    assert_eq!(
        notes.read("Notion Import/Page.md"),
        "# Page\n\nBefore\n\nKept as text\n\nPage/missing.png\n\nAfter"
    );
    let skipped: Vec<(&str, &str)> = summary
        .skipped
        .iter()
        .map(|s| (s.page.as_str(), s.reason.as_str()))
        .collect();
    assert_eq!(
        skipped,
        [
            (
                "Notion Import/Page",
                "Unsupported block div.mystery-block, kept as plain text"
            ),
            ("Notion Import/Page", "Page/missing.png is not in the export"),
        ]
    );
}

#[test]
fn notion_import_skips_zip_entries_that_leave_the_folder() {
    let notes = TestNotes::new();
    let out = tempfile::TempDir::new().expect("zip dir");
    let zip = out.path().join("export.zip");
    let body = r#"<figure class="image"><img src="../evil.png"/></figure>"#;
    let bad = ["../evil.png", "a/../../evil.html", "/tmp/aether-notion-evil.png"];
    let mut entries = vec![(format!("Page {NOTION_PAGE_ID}.html"), notion_page("Page", body).into_bytes())];
    entries.extend(bad.iter().map(|name| (name.to_string(), b"evil".to_vec())));
    write_zip(&zip, &entries);

    let summary = import_notion(&notes, &[zip]);

    assert_eq!(notes.tree(), ["Notion Import/Page.md"]);
    assert!(!notes.root().parent().expect("parent").join("evil.png").exists());
    assert!(!std::path::Path::new("/tmp/aether-notion-evil.png").exists());
    for name in bad {
        assert!(
            summary
                .skipped
                .iter()
                .any(|s| s.page == name && s.reason == "Unsafe path in the zip, not imported"),
            "{name}: {:?}",
            summary.skipped
        );
    }
}

#[test]
fn notion_import_skips_suffixed_names_that_are_ignored_folders() {
    let notes = TestNotes::new();
    let out = tempfile::TempDir::new().expect("zip dir");
    let zip = out.path().join("export.zip");
    let ids = ["11111111111111111111111111111111", "22222222222222222222222222222222"];
    let children = ["33333333333333333333333333333333", "44444444444444444444444444444444"];
    let mut entries = Vec::new();
    for (i, (id, child)) in ids.iter().zip(children).enumerate() {
        let body = format!(
            r#"<figure class="link-to-page"><a href="Projects/Child{i}%20{child}.html">Child{i}</a></figure>"#
        );
        entries.push((format!("Projects {id}.html"), notion_page("Projects", &body).into_bytes()));
        entries.push((
            format!("Projects/Child{i} {child}.html"),
            notion_page(&format!("Child{i}"), "<p>Hi</p>").into_bytes(),
        ));
    }
    write_zip(&zip, &entries);

    crate::notion_import::import(notes.root(), &[zip], None, &["Projects-1".to_string()], |_, _| {})
        .expect("notion import");

    assert_eq!(
        notes.tree(),
        [
            "Notion Import/Projects-2.md",
            "Notion Import/Projects-2/Child1.md",
            "Notion Import/Projects.md",
            "Notion Import/Projects/Child0.md",
        ]
    );
}

#[test]
fn notion_import_suffixes_page_names_that_are_reserved_folders() {
    // `build` is ignored by default
    for title in ["Assets", "build"] {
        let notes = TestNotes::new();
        let out = tempfile::TempDir::new().expect("zip dir");
        let zip = out.path().join("export.zip");
        let child_id = "fedcba9876543210fedcba9876543210";
        let body = format!(
            r#"<figure class="link-to-page"><a href="{title}/Child%20{child_id}.html">Child</a></figure>"#
        );
        write_zip(
            &zip,
            &[
                (format!("{title} {NOTION_PAGE_ID}.html"), notion_page(title, &body).into_bytes()),
                (format!("{title}/Child {child_id}.html"), notion_page("Child", "<p>Hi</p>").into_bytes()),
            ],
        );

        import_notion(&notes, &[zip]);

        notes.save_artifact("notion_import_suffixes_page_names_that_are_reserved_folders");
        assert_eq!(
            notes.tree(),
            [format!("Notion Import/{title}-1.md"), format!("Notion Import/{title}-1/Child.md")]
        );
        let parent = notes.read(&format!("Notion Import/{title}-1.md"));
        assert!(parent.contains(&format!("[Child]({title}-1/Child.md)")), "{parent}");
    }
}

fn save(notes: &TestNotes, id: Option<&str>, content: &str) -> Result<crate::Note, String> {
    run(crate::save_note(id.map(str::to_string), content.to_string(), notes.state()))
}

fn delete(notes: &TestNotes, id: &str) {
    run(crate::delete_note(id.to_string(), notes.state())).expect("delete_note");
}

#[test]
fn deleting_a_note_named_like_a_reserved_or_ignored_folder_keeps_that_folder() {
    let notes = TestNotes::new();
    notes.write("assets/img.png", "png");
    notes.write("Assets.md", "# Assets\n");
    notes.write("build.md", "# build\n");
    notes.write("build/out.bin", "bin");
    notes.write("vendor/lib.txt", "lib");
    notes.write("Vendor.md", "# Vendor\n");
    notes.write(".trash/old.md", "# Old\n");
    notes.write(".Trash.md", "# Trash\n");

    for id in ["Assets", "build", "Vendor", ".Trash"] {
        delete(&notes, id);
    }

    notes.save_artifact("deleting_a_note_named_like_a_reserved_or_ignored_folder_keeps_that_folder");
    assert_eq!(
        notes.tree(),
        [".trash/old.md", "assets/img.png", "build/out.bin", "vendor/lib.txt"]
    );
}

#[test]
fn retitling_or_moving_a_note_named_like_the_assets_folder_leaves_the_folder() {
    let notes = TestNotes::new();
    notes.write("assets/img.png", "png");
    notes.write("assets.md", "# assets\n");

    let saved = save(&notes, Some("assets"), "# Asset list\n").expect("save_note");
    assert_eq!(saved.id, "Asset list");
    assert_eq!(notes.tree(), ["Asset list.md", "assets/img.png"]);

    notes.write("build.md", "# build\n");
    notes.write("build/out.bin", "bin");
    assert_eq!(move_note(&notes, "build", "Archive"), "Archive/build");

    notes.save_artifact("retitling_or_moving_a_note_named_like_the_assets_folder_leaves_the_folder");
    assert_eq!(
        notes.tree(),
        ["Archive/build.md", "Asset list.md", "assets/img.png", "build/out.bin"]
    );
}

#[test]
fn reserved_folder_names_are_hidden_in_any_case() {
    let notes = TestNotes::new();
    notes.write("Assets/Inside.md", "# Inside\n");
    notes.write(".GIT/Inside.md", "# Inside\n");
    notes.write("Note.md", "# Note\n");

    let ids: Vec<String> = run(crate::list_notes(notes.state()))
        .expect("list_notes")
        .into_iter()
        .map(|n| n.id)
        .collect();
    let folders = run(crate::list_folders(notes.state())).expect("list_folders");

    assert_eq!(ids, ["Note"]);
    assert!(folders.is_empty(), "{folders:?}");
    assert_eq!(
        run(crate::create_folder("Assets".to_string(), notes.state())),
        Err("'Assets' is a reserved folder name".to_string())
    );
}

#[test]
fn retitling_a_note_to_a_plain_folder_name_does_not_adopt_the_folder() {
    let notes = TestNotes::new();
    notes.write("Note.md", "# Note\n");
    notes.write("Folder/Doc.md", "# Doc\n");
    notes.write("Folder/file.pdf", "pdf");
    notes.write("Archive/Loose/x.pdf", "pdf");
    notes.write("Loose.md", "# Loose\n");
    std::fs::create_dir(notes.root().join("Untitled")).expect("plain folder");

    let saved = save(&notes, Some("Note"), "# Folder\n").expect("rename");
    let created = save(&notes, None, "# Folder\n").expect("new note");
    let untitled = run(crate::create_note(None, notes.state())).expect("create_note");
    let moved = run(crate::move_note("Loose".to_string(), "Archive".to_string(), notes.state()));

    notes.save_artifact("retitling_a_note_to_a_plain_folder_name_does_not_adopt_the_folder");
    assert_eq!(saved.id, "Folder-1");
    assert_eq!(created.id, "Folder-2");
    assert_eq!(untitled.id, "Untitled-1");
    assert_eq!(
        moved,
        Err("A note with that name already exists in the target folder".to_string())
    );
    assert_eq!(
        notes.tree(),
        [
            "Archive/Loose/x.pdf",
            "Folder-1.md",
            "Folder-2.md",
            "Folder/Doc.md",
            "Folder/file.pdf",
            "Loose.md",
            "Untitled-1.md"
        ]
    );
}

fn delete_counts(notes: &TestNotes, id: &str) -> (usize, usize) {
    let counts = run(crate::sub_page_counts(id.to_string(), notes.state())).expect("sub_page_counts");
    (counts.sub_pages, counts.other_files)
}

#[test]
fn sub_page_counts_cover_everything_deleting_the_page_removes() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/A.md", "# A\n");
    notes.write("Page/B.md", "# B\n");
    notes.write("Page/B/C.md", "# C\n");
    notes.write("Page/spec.pdf", "pdf");
    notes.write("Page/build/out.md", "# Out\n");
    notes.write("Lonely.md", "# Lonely\n");
    notes.write("assets/img.png", "png");
    notes.write("Assets.md", "# Assets\n");

    assert_eq!(delete_counts(&notes, "Page"), (3, 2));
    assert_eq!(delete_counts(&notes, "Lonely"), (0, 0));
    assert_eq!(delete_counts(&notes, "Assets"), (0, 0));
}

/// Undoes `chflags uchg` when dropped, so the temporary folder can be removed.
#[cfg(target_os = "macos")]
struct Immutable(std::path::PathBuf);

#[cfg(target_os = "macos")]
impl Immutable {
    fn new(path: std::path::PathBuf) -> Self {
        let status = std::process::Command::new("chflags").arg("uchg").arg(&path).status();
        assert!(status.expect("run chflags").success());
        Self(path)
    }
}

#[cfg(target_os = "macos")]
impl Drop for Immutable {
    fn drop(&mut self) {
        let _ = std::process::Command::new("chflags").arg("nouchg").arg(&self.0).status();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_page_rename_whose_folder_cannot_move_keeps_the_old_names_and_fails() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/Child.md", "# Child\n");
    let _locked = Immutable::new(notes.root().join("Page"));

    let result = save(&notes, Some("Page"), "# New Name\n");

    assert!(result.is_err(), "{result:?}");
    assert_eq!(notes.tree(), ["Page.md", "Page/Child.md"]);
}

#[test]
fn rename_page_puts_everything_back_when_a_rename_fails() {
    let notes = TestNotes::new();
    notes.write("Page.md", "# Page\n");
    notes.write("Page/Child.md", "# Child\n");
    // Folders in the way: the page file cannot become `File.md`, and the
    // sub-page folder cannot replace a non-empty `Folder/`.
    notes.write("File.md/blocker.txt", "x");
    notes.write("Folder/blocker.txt", "x");
    let root = notes.root();
    let rename = |file: &str, folder: &str| {
        crate::rename_page(
            &root.join("Page.md"),
            &root.join(file),
            Some((&root.join("Page"), &root.join(folder))),
        )
    };

    assert!(rename("File.md", "File").is_err());
    assert!(rename("Folder.md", "Folder").is_err());

    assert_eq!(
        notes.tree(),
        ["File.md/blocker.txt", "Folder/blocker.txt", "Page.md", "Page/Child.md"]
    );
}

#[test]
fn a_case_only_title_change_renames_the_page_and_its_folder() {
    let notes = TestNotes::new();
    notes.write("page.md", "# page\n");
    notes.write("page/Child.md", "# Child\n\n[Up](../page.md)\n");

    let saved = save(&notes, Some("page"), "# Page\n").expect("save_note");

    notes.save_artifact("a_case_only_title_change_renames_the_page_and_its_folder");
    assert_eq!(saved.id, "Page");
    assert_eq!(notes.tree(), ["Page.md", "Page/Child.md"]);
    assert_eq!(notes.read("Page/Child.md"), "# Child\n\n[Up](../Page.md)\n");
}

const LINKS: &str = "# Links

[site](example.com) [q](file.pdf?x=1#p) [gone](Nowhere.md) [dir](Folder)
```js``` then [after](Other.md)

    [indented](Other.md)

- item
    - [nested](Other.md)

[ref]: Other.md \"Title\"
[angle]: <Other.md>
";

#[test]
fn moving_a_note_rewrites_only_links_to_files_and_leaves_urls_queries_and_code() {
    let notes = TestNotes::new();
    notes.write("Links.md", LINKS);
    notes.write("Other.md", "# Other\n");
    notes.write("file.pdf", "pdf");
    notes.write("Folder/x.md", "# X\n");

    assert_eq!(move_note(&notes, "Links", "a"), "a/Links");

    notes.save_artifact("moving_a_note_rewrites_only_links_to_files_and_leaves_urls_queries_and_code");
    assert_eq!(
        notes.read("a/Links.md"),
        "# Links

[site](example.com) [q](../file.pdf?x=1#p) [gone](Nowhere.md) [dir](../Folder)
```js``` then [after](../Other.md)

    [indented](Other.md)

- item
    - [nested](../Other.md)

[ref]: ../Other.md \"Title\"
[angle]: ../Other.md
"
    );
}

#[test]
fn notion_import_fences_code_and_inline_code_that_hold_backticks() {
    let notes = TestNotes::new();
    let out = tempfile::TempDir::new().expect("zip dir");
    let zip = out.path().join("export.zip");
    let body = r#"<pre class="code"><code>```js
x
````
y</code></pre><p>Use <code>a`b</code>, <code>`tick</code> and <code> pad </code></p>"#;
    write_zip(
        &zip,
        &[(format!("Page {NOTION_PAGE_ID}.html"), notion_page("Page", body).into_bytes())],
    );

    import_notion(&notes, &[zip]);

    assert_eq!(
        notes.read("Notion Import/Page.md"),
        "# Page\n\n`````\n```js\nx\n````\ny\n`````\n\nUse ``a`b``, `` `tick `` and `  pad  `"
    );
}

#[test]
fn read_asset_base64_reads_images_only() {
    let notes = sample_workspace();
    let read = |path: &str| run(crate::read_asset_base64(path.to_string(), notes.state()));

    assert!(read("assets/logo.png").is_ok());
    for refused in [".git/HEAD", ".aether/settings.json", "assets/spec v2.pdf", "Home.md"] {
        assert_eq!(read(refused), Err("Only images can be embedded".to_string()), "{refused}");
    }
}

#[test]
fn only_non_executable_files_in_assets_can_be_opened() {
    let notes = TestNotes::new();
    notes.write("assets/report.pdf", "pdf");
    notes.write("assets/setup.EXE", "exe");
    notes.write("assets/run.command", "sh");
    notes.write("Note.md", "# Note\n");
    notes.write("other/assets/x.pdf", "pdf");
    let root = notes.root();
    let check = |rel: &str| {
        crate::openable_asset(root, &root.join(rel).to_string_lossy())
    };

    let real_root = root.canonicalize().expect("canonical root");
    assert_eq!(check("assets/report.pdf"), Ok(real_root.join("assets/report.pdf")));
    let executable = Err("Aether won't open executable files. Reveal it in the folder instead.".to_string());
    assert_eq!(check("assets/setup.EXE"), executable);
    assert_eq!(check("assets/run.command"), executable);
    let refused = Err("Not a file in the assets folder".to_string());
    for rel in ["Note.md", "other/assets/x.pdf", "assets/../Note.md", "assets/missing.pdf"] {
        assert_eq!(check(rel), refused, "{rel}");
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = tempfile::TempDir::new().expect("outside dir");
        std::fs::write(outside.path().join("secret.pdf"), "pdf").expect("write outside file");
        symlink("run.command", root.join("assets/disguised.pdf")).expect("symlink to executable");
        symlink(outside.path().join("secret.pdf"), root.join("assets/out.pdf"))
            .expect("symlink outside");
        assert_eq!(check("assets/disguised.pdf"), executable);
        assert_eq!(check("assets/out.pdf"), refused);

        let linked = TestNotes::new();
        symlink(outside.path(), linked.root().join("assets")).expect("symlink assets folder");
        let path = linked.root().join("assets/secret.pdf");
        assert_eq!(
            crate::openable_asset(linked.root(), &path.to_string_lossy()),
            Ok(outside.path().canonicalize().expect("canonical outside").join("secret.pdf"))
        );
    }
}

/// 2000 notes of about 4 KB in 20 folders, each linking to a page with 50 sub-pages, and
/// a page with 50 sub-pages that nothing links to. Prints how long renames
/// and moves take, and a full index rebuild for reference; asserts nothing
/// about time.
#[test]
#[ignore = "timing report; run with --ignored"]
fn rename_and_move_timings_on_2000_notes() {
    use std::time::Instant;
    let notes = TestNotes::new();
    notes.write("Hub.md", "# Hub\n");
    for i in 0..50 {
        notes.write(&format!("Hub/Sub {i}.md"), &format!("# Sub {i}\n\n[Up](../Hub.md)\n"));
        notes.write(&format!("Quiet/Leaf {i}.md"), &format!("# Leaf {i}\n\n[Up](../Quiet.md)\n"));
    }
    notes.write("Quiet.md", "# Quiet\n");
    for f in 0..20 {
        for n in 0..97 {
            let body = format!("word{f}x{n} lorem ipsum dolor sit amet consectetur ").repeat(70);
            notes.write(
                &format!("f{f}/n{n}.md"),
                &format!("# n{n}\n\n{body}\n\n[Hub](../Hub.md) [Next](n{}.md)\n", n + 1),
            );
        }
    }
    let index_dir = tempfile::TempDir::new().expect("index dir");
    let index = crate::SearchIndex::new(&index_dir.path().to_path_buf()).expect("index");
    index.rebuild_index(&notes.root().to_path_buf(), &[]).expect("rebuild");
    *notes.state().search_index.lock().expect("search index mutex") = Some(index);
    run(crate::list_notes(notes.state())).expect("list_notes");

    let mut report = String::new();
    let mut time = |label: &str, f: &mut dyn FnMut()| {
        let start = Instant::now();
        f();
        report.push_str(&format!("{label}: {:?}\n", start.elapsed()));
    };
    time("save_note, same title", &mut || {
        save(&notes, Some("f0/n0"), "# n0\n\nEdited.\n").expect("save");
    });
    time("save_note, plain note title rename", &mut || {
        save(&notes, Some("f0/n1"), "# n1 renamed\n").expect("rename note");
    });
    time("save_note, page title rename (50 sub-pages)", &mut || {
        save(&notes, Some("Hub"), "# Hub Renamed\n").expect("rename page");
    });
    time("move_note, page with 50 sub-pages", &mut || {
        move_note(&notes, "Hub Renamed", "f1");
    });
    time("save_note, page title rename (50 sub-pages, no backlinks)", &mut || {
        save(&notes, Some("Quiet"), "# Quiet Renamed\n").expect("rename quiet page");
    });
    time("move_note, page with 50 sub-pages, no backlinks", &mut || {
        move_note(&notes, "Quiet Renamed", "f2");
    });
    time("reference: full rebuild_index", &mut || {
        let state = notes.state();
        let guard = state.search_index.lock().expect("search index mutex");
        let index = guard.as_ref().expect("search index");
        index.rebuild_index(&notes.root().to_path_buf(), &[]).expect("rebuild");
    });

    let path = crate::test_support::save_text_artifact("rename_and_move_timings_on_2000_notes", &report);
    println!("{report}written to {}", path.display());
    let found = search(&notes, "Sub");
    assert!(
        !found.is_empty() && found.iter().all(|id| id.starts_with("f1/Hub Renamed/Sub ")),
        "{found:?}"
    );
}
