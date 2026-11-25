//! Pages on disk: list, read, save, create, move, and search. Free of Tauri
//! types, so the app's commands and the `aether` CLI share one
//! implementation. Every function takes the notes folder `root` and the
//! user's ignored folder names.

use crate::{
    abs_path_from_id, bare_page_markdown, create_bare_page_file, dir_from_id, extract_title,
    generate_preview, get_effective_ignored_dirs, id_from_abs_path, is_hidden_dir,
    is_visible_notes_entry, modified_secs, note_name_taken, parent_folder, relink,
    remove_empty_sub_page_dir, rename_page, sanitize_filename, sub_page_dir, validate_folder_path,
    vault, Note, NoteMetadata, SearchResult,
};
use std::collections::HashSet;
use std::path::Path;

pub use crate::relink::{Move, Moved};
pub use crate::vault::PrivateSet;

/// The folder names the user chose to ignore, from the folder's settings
/// file, without creating it.
pub fn ignored_dirs(root: &Path) -> Vec<String> {
    let settings = std::fs::read_to_string(root.join(".aether").join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    get_effective_ignored_dirs(&settings)
}

/// The private pages, their sub-pages, and the assets only they use, from
/// this device's marks. Needs no key.
pub fn private_set(root: &Path, ignored: &[String]) -> Result<PrivateSet, String> {
    vault::current_private_set(root, ignored)
}

/// Checks that `id` is a note id inside the notes folder (no `..`, no
/// absolute path, no backslash).
pub fn check_id(root: &Path, id: &str) -> Result<(), String> {
    abs_path_from_id(root, id).map(|_| ())
}

/// Whether `id` sits in an app or ignored folder, where no page is listed.
pub fn in_hidden_folder(ignored: &[String], id: &str) -> bool {
    parent_folder(id)
        .split('/')
        .any(|dir| is_hidden_dir(dir, ignored))
}

/// A saved page, and the renames the save made (empty when it kept its name).
pub struct Saved {
    pub note: Note,
    pub moves: Vec<Move>,
    pub moved: Vec<Moved>,
}

/// Every page: notes, and bare pages (folders with no matching `.md`), in
/// the order the walk finds them.
pub fn list(root: &Path, ignored: &[String]) -> Vec<NoteMetadata> {
    let mut results: Vec<NoteMetadata> = Vec::new();
    let mut folders: Vec<(String, i64)> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| is_visible_notes_entry(e, ignored))
        .flatten()
    {
        let file_path = entry.path();
        if entry.depth() > 0
            && entry.file_type().is_dir()
            && !entry.file_name().to_string_lossy().starts_with('.')
        {
            if let (Ok(rel), Ok(metadata)) = (file_path.strip_prefix(root), entry.metadata()) {
                let id = rel.to_string_lossy().replace('\\', "/");
                folders.push((id, modified_secs(&metadata)));
            }
        }
        if !file_path.is_file() {
            continue;
        }
        if let Some(id) = id_from_abs_path(root, file_path, ignored) {
            if let Ok(content) = std::fs::read_to_string(file_path) {
                let modified = entry.metadata().map(|m| modified_secs(&m)).unwrap_or(0);
                results.push(NoteMetadata {
                    id,
                    title: extract_title(&content),
                    preview: generate_preview(&content),
                    modified,
                });
            }
        }
    }
    // Exact names, as in sub_page_dir: on a case-insensitive file system
    // `page/` next to `Page.md` is a bare page of its own.
    let pages: HashSet<String> = results.iter().map(|n| n.id.clone()).collect();
    for (id, modified) in folders {
        if !pages.contains(&id) {
            let title = id.rsplit('/').next().unwrap_or(&id).to_string();
            results.push(NoteMetadata {
                id,
                title,
                preview: String::new(),
                modified,
            });
        }
    }
    results
}

/// Page `id`. A bare page reads as its title, without writing a file.
pub fn read(root: &Path, ignored: &[String], id: &str) -> Result<Note, String> {
    let file_path = abs_path_from_id(root, id)?;
    if !file_path.exists() {
        let dir = sub_page_dir(root, id, ignored).ok_or("Note not found")?;
        let metadata = std::fs::metadata(&dir).map_err(|e| e.to_string())?;
        let content = bare_page_markdown(id);
        return Ok(Note {
            id: id.to_string(),
            title: extract_title(&content),
            content,
            path: file_path.to_string_lossy().into_owned(),
            modified: modified_secs(&metadata),
        });
    }
    let content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let metadata = std::fs::metadata(&file_path).map_err(|e| e.to_string())?;
    Ok(Note {
        id: id.to_string(),
        title: extract_title(&content),
        content,
        path: file_path.to_string_lossy().into_owned(),
        modified: modified_secs(&metadata),
    })
}

/// The first of `base`, `base-1`, `base-2`, ... that `taken` does not
/// reject, with the ids passed over on the way.
fn first_free(base: &str, mut taken: impl FnMut(&str) -> bool) -> (String, Vec<String>) {
    let mut passed = Vec::new();
    let mut id = base.to_string();
    let mut counter = 1;
    while taken(&id) {
        passed.push(id);
        id = format!("{base}-{counter}");
        counter += 1;
    }
    (id, passed)
}

/// The id a new page with `content` gets in sub-page folder `parent` (the
/// root when None), from its title, and the ids passed over because they
/// were taken.
pub fn new_page_id(root: &Path, parent: Option<&str>, content: &str) -> (String, Vec<String>) {
    let leaf = sanitize_filename(&extract_title(content));
    let base = match parent {
        Some(parent) => format!("{parent}/{leaf}"),
        None => leaf,
    };
    first_free(&base, |id| note_name_taken(root, id, &[]))
}

/// Where page `id` goes when saved with `content`: None when its name
/// already follows the title, else the new id and the ids passed over
/// because they were taken.
pub fn rename_target(
    root: &Path,
    ignored: &[String],
    id: &str,
    content: &str,
) -> Result<Option<(String, Vec<String>)>, String> {
    let leaf = sanitize_filename(&extract_title(content));
    let desired = match id.rfind('/') {
        Some(pos) => format!("{}/{}", &id[..pos], leaf),
        None => leaf,
    };
    if desired == id {
        return Ok(None);
    }
    let file = abs_path_from_id(root, id)?;
    let sub_pages = sub_page_dir(root, id, ignored);
    let own: Vec<&Path> = [Some(file.as_path()), sub_pages.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    // A page named like a folder the scanner skips would hide its sub-pages there
    let hidden = |id: &str| is_hidden_dir(id.rsplit('/').next().unwrap_or(id), ignored);
    let (new_id, passed) = first_free(&desired, |candidate| {
        candidate != id && (hidden(candidate) || note_name_taken(root, candidate, &own))
    });
    Ok((new_id != id).then_some((new_id, passed)))
}

/// Writes a new page with `content` in sub-page folder `parent` (the root
/// when None), named after its title.
pub fn create(
    root: &Path,
    ignored: &[String],
    parent: Option<&str>,
    content: &str,
) -> Result<Note, String> {
    // A sub-page of a page named like a skipped folder would not show
    if let Some(hidden) = parent
        .iter()
        .flat_map(|p| p.split('/'))
        .find(|dir| is_hidden_dir(dir, ignored))
    {
        return Err(format!(
            "The sidebar hides notes in a folder named \"{hidden}\". Rename the page first."
        ));
    }
    let (id, _) = new_page_id(root, parent, content);
    let file_path = abs_path_from_id(root, &id)?;
    if parent.is_some() {
        if let Some(dir) = file_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&file_path, content).map_err(|e| e.to_string())?;
    saved_note(root, ignored, &id, content.to_string(), &file_path)
}

/// Saves `content` to page `id`, or to a new page at the root when None.
/// The file name follows the first heading: a changed title renames the
/// page and its sub-page folder, and links follow (`after_moves`).
pub fn save(
    root: &Path,
    ignored: &[String],
    id: Option<&str>,
    content: &str,
) -> Result<Saved, String> {
    let Some(id) = id else {
        let note = create(root, ignored, None, content)?;
        return Ok(Saved {
            note,
            moves: Vec::new(),
            moved: Vec::new(),
        });
    };
    let old_path = abs_path_from_id(root, id)?;
    let target = rename_target(root, ignored, id, content)?;
    // A rename saves in place first, so a failed rename loses no edits
    std::fs::write(&old_path, content).map_err(|e| e.to_string())?;
    let Some((new_id, _)) = target else {
        let note = saved_note(root, ignored, id, content.to_string(), &old_path)?;
        return Ok(Saved {
            note,
            moves: Vec::new(),
            moved: Vec::new(),
        });
    };
    let new_path = abs_path_from_id(root, &new_id)?;
    let sub_pages = sub_page_dir(root, id, ignored);
    let new_dir = dir_from_id(root, &new_id);
    rename_page(
        &old_path,
        &new_path,
        sub_pages.as_deref().map(|dir| (dir, new_dir.as_path())),
    )
    .map_err(|e| format!("Could not rename the note: {e}"))?;
    let mut moves = vec![(format!("{id}.md"), format!("{new_id}.md"))];
    if sub_pages.is_some() {
        moves.push((id.to_string(), new_id.clone()));
    }
    let moved = after_moves(root, ignored, &moves);
    // A rename can rewrite links in this note too (links to itself)
    let content = std::fs::read_to_string(&new_path).map_err(|e| e.to_string())?;
    let note = saved_note(root, ignored, &new_id, content, &new_path)?;
    Ok(Saved { note, moves, moved })
}

/// The note just written to `path`, after updating private pages for it.
fn saved_note(
    root: &Path,
    ignored: &[String],
    id: &str,
    content: String,
    path: &Path,
) -> Result<Note, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if let Err(e) = vault::page_saved(root, ignored, id, &content) {
        eprintln!("Failed to update private pages after a save: {e}");
    }
    Ok(Note {
        id: id.to_string(),
        title: extract_title(&content),
        content,
        path: path.to_string_lossy().into_owned(),
        modified: modified_secs(&metadata),
    })
}

/// Moves page `id` and its sub-pages into sub-page folder `target_folder`
/// (`""` for the root). Returns the new id, the moves made, and the notes
/// that moved.
pub fn move_page(
    root: &Path,
    ignored: &[String],
    id: &str,
    target_folder: &str,
) -> Result<(String, Vec<Move>, Vec<Moved>), String> {
    let source_path = abs_path_from_id(root, id)?;
    let sub_pages = sub_page_dir(root, id, ignored);
    if !source_path.exists() && sub_pages.is_none() {
        return Err("Note not found".to_string());
    }
    let leaf = id.rsplit('/').next().unwrap_or(id);
    let new_id = if target_folder.is_empty() {
        leaf.to_string()
    } else {
        validate_folder_path(target_folder)?;
        format!("{target_folder}/{leaf}")
    };
    if new_id == id {
        return Ok((new_id, Vec::new(), Vec::new()));
    }
    if target_folder == id || target_folder.starts_with(&format!("{id}/")) {
        return Err("Cannot move a page into its own sub-pages".to_string());
    }
    let dest_path = abs_path_from_id(root, &new_id)?;
    let sub_pages_dest = dir_from_id(root, &new_id);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if note_name_taken(root, &new_id, &[]) {
        return Err("A note with that name already exists in the target folder".to_string());
    }
    create_bare_page_file(root, id, ignored)?;
    rename_page(
        &source_path,
        &dest_path,
        sub_pages
            .as_deref()
            .map(|dir| (dir, sub_pages_dest.as_path())),
    )
    .map_err(|e| e.to_string())?;
    let mut moves = vec![(format!("{id}.md"), format!("{new_id}.md"))];
    if sub_pages.is_some() {
        moves.push((id.to_string(), new_id.clone()));
    }
    remove_empty_sub_page_dir(root, parent_folder(id));
    let moved = after_moves(root, ignored, &moves);
    Ok((new_id, moves, moved))
}

/// The follow-up every rename or move needs, once `moves` happened on disk:
/// relative links across the folder and private-page marks. Returns the
/// notes that moved. Pinned ids follow separately, since the app keeps its
/// settings in memory.
pub fn after_moves(root: &Path, ignored: &[String], moves: &[Move]) -> Vec<Moved> {
    let moved = relink::relink_notes(root, moves, ignored);
    // After the relink, so private assets are found through the rewritten links.
    if let Err(e) = vault::follow_moves(root, ignored, moves) {
        eprintln!("Failed to update private pages after a move: {e}");
    }
    moved
}

/// Points the pinned ids in the folder's settings file at their ids after
/// `moves`, for writers that do not hold the settings in memory.
pub fn follow_pins(root: &Path, moves: &[Move]) {
    let folder = root.to_string_lossy();
    let mut settings = crate::load_settings(&folder);
    let Some(pinned) = settings.pinned_note_ids.as_mut() else {
        return;
    };
    let followed: Vec<String> = pinned.iter().map(|id| crate::moved_id(id, moves)).collect();
    if followed != *pinned {
        *pinned = followed;
        if let Err(e) = crate::save_settings(&folder, &settings) {
            eprintln!("Failed to update pinned pages after a move: {e}");
        }
    }
}

/// Substring search over every page, without the search index: a title that
/// holds `query` (any case) scores 50, a content line that holds it adds 10
/// alone or 5 with a title match, and becomes the preview. Best first.
pub fn search(root: &Path, ignored: &[String], query: &str, limit: usize) -> Vec<SearchResult> {
    let query = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();
    for page in list(root, ignored) {
        let mut score = 0.0f32;
        if page.title.to_lowercase().contains(&query) {
            score += 50.0;
        }
        let mut preview = page.preview;
        let content = abs_path_from_id(root, &page.id)
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok());
        if let Some(content) = content {
            // The query is one line of input, so a content match lies on one line
            if let Some(line) = content.lines().find(|l| l.to_lowercase().contains(&query)) {
                preview = line.trim().to_string();
                score += if score == 0.0 { 10.0 } else { 5.0 };
            }
        }
        if score > 0.0 {
            results.push(SearchResult {
                id: page.id,
                title: page.title,
                preview,
                modified: page.modified,
                score,
            });
        }
    }
    results.sort_by(|a, b| b.score.total_cmp(&a.score));
    results.truncate(limit);
    results
}
