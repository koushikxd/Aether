//! Zip export of notes with the assets they use, and import of such zips.

use crate::relink;
use crate::vault::PrivateSet;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::read::ZipFile;
use zip::{ZipArchive, ZipWriter};

type Zip = ZipWriter<File>;

fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn add_file(zip: &mut Zip, name: &str, mut content: impl Read) -> Result<(), String> {
    zip.start_file(name, SimpleFileOptions::default())
        .map_err(message)?;
    std::io::copy(&mut content, zip).map_err(message)?;
    Ok(())
}

fn add_asset(zip: &mut Zip, root: &Path, path: &str) -> Result<(), String> {
    add_file(zip, path, File::open(root.join(path)).map_err(message)?)
}

/// The files in `assets/` that `markdown`, the note at `note_path`, links to.
fn used_assets(root: &Path, markdown: &str, note_path: &str) -> Vec<String> {
    relink::linked_paths(markdown, note_path)
        .into_iter()
        .filter(|path| path.starts_with("assets/") && root.join(path).is_file())
        .collect()
}

/// Writes a zip to `dest` with `fill`, removing it again if that fails.
fn write_zip(dest: &Path, fill: impl FnOnce(&mut Zip) -> Result<(), String>) -> Result<(), String> {
    let mut zip = ZipWriter::new(File::create(dest).map_err(message)?);
    let result = fill(&mut zip).and_then(|()| zip.finish().map(drop).map_err(message));
    if result.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    result
}

/// Zips the note `id` as `<name>.md` at the zip root, with the files in
/// `assets/` it links to beside it. Its relative paths are rewritten for the
/// new location.
pub fn export_note(root: &Path, id: &str, markdown: &str, dest: &Path) -> Result<(), String> {
    let note_path = format!("{id}.md");
    let name = format!("{}.md", id.rsplit('/').next().unwrap_or(id));
    let moves = [(note_path.clone(), name.clone())];
    let assets: BTreeSet<String> = used_assets(root, markdown, &note_path)
        .into_iter()
        .collect();
    write_zip(dest, |zip| {
        let rewritten = relink::rewrite_links(root, markdown, &note_path, &name, &moves);
        add_file(zip, &name, rewritten.as_bytes())?;
        assets
            .iter()
            .try_for_each(|path| add_asset(zip, root, path))
    })
}

/// Zips `folder` (`""` for the whole notes folder): its notes and subfolders,
/// under the folder's own name, plus `assets/`. The whole notes folder takes
/// all of `assets/` and is zipped byte for byte. A subfolder takes only the
/// assets its notes link to, and its notes' relative paths are rewritten for
/// the shallower location. App and ignored folders, files other than notes,
/// and the files in `private` are left out.
pub fn export_folder(
    root: &Path,
    folder: &str,
    ignored_dirs: &[String],
    private: &PrivateSet,
    dest: &Path,
) -> Result<(), String> {
    let name = folder.rsplit('/').next().unwrap_or(folder);
    let moves = [(folder.to_string(), name.to_string())];
    let mut assets = BTreeSet::new();
    write_zip(dest, |zip| {
        let entries = WalkDir::new(root.join(folder))
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                crate::is_visible_notes_entry(e, ignored_dirs)
                    && !(e.file_type().is_dir() && private.contains_dir(&relative(root, e.path())))
            });
        for entry in entries {
            let entry = entry.map_err(message)?;
            let path = relative(root, entry.path());
            let zipped = relink::after_moves(&path, &moves);
            if entry.file_type().is_dir() {
                zip.add_directory(zipped, SimpleFileOptions::default())
                    .map_err(message)?;
                continue;
            }
            if crate::id_from_abs_path(root, entry.path(), ignored_dirs).is_none()
                || private.contains(&path)
            {
                continue;
            }
            let mut bytes = std::fs::read(entry.path()).map_err(message)?;
            if !folder.is_empty() {
                // Notes that are not UTF-8 are not ones Aether edits; they go as they are.
                if let Ok(markdown) = std::str::from_utf8(&bytes) {
                    assets.extend(used_assets(root, markdown, &path));
                    bytes = relink::rewrite_links(root, markdown, &path, &zipped, &moves).into_bytes();
                }
            }
            add_file(zip, &zipped, bytes.as_slice())?;
        }
        if !folder.is_empty() {
            return assets
                .iter()
                .try_for_each(|path| add_asset(zip, root, path));
        }
        let assets_dir = root.join("assets");
        if !assets_dir.is_dir() {
            return Ok(());
        }
        for entry in WalkDir::new(&assets_dir) {
            let entry = entry.map_err(message)?;
            let path = relative(root, entry.path());
            if entry.file_type().is_dir() {
                zip.add_directory(path, SimpleFileOptions::default())
                    .map_err(message)?;
            } else if !private.contains(&path) {
                add_asset(zip, root, &path)?;
            }
        }
        Ok(())
    })
}

fn same_content(path: &Path, entry: &mut impl Read, size: u64) -> Result<bool, String> {
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == size) {
        return Ok(false);
    }
    let mut zipped = Vec::new();
    entry.read_to_end(&mut zipped).map_err(message)?;
    Ok(std::fs::read(path).map_err(message)? == zipped)
}

/// The path of the zip entry `name`, or None when it is absolute or climbs
/// out with `..`. enclosed_name drops a leading `/` and resolves `..`; any
/// entry it had to change is refused rather than written somewhere unexpected.
pub fn safe_entry_path(entry: &ZipFile<'_, impl Read>, name: &str) -> Option<PathBuf> {
    entry.enclosed_name().filter(|p| {
        p.to_string_lossy().replace('\\', "/") == name.replace('\\', "/").trim_end_matches('/')
    })
}

/// Unpacks the zip at `zip_path` into `root` and returns how many files it
/// wrote. Entries in app folders (`.git`, `.aether`, ...) are skipped, and so
/// are files identical to ones already there. Nothing is written when an
/// entry's path would leave `root` or a different file already has its path.
pub fn import(root: &Path, zip_path: &Path) -> Result<usize, String> {
    let file = File::open(zip_path).map_err(|_| "Could not open the zip file".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| "Not a valid zip file".to_string())?;
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<(usize, PathBuf)> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(message)?;
        let name = entry.name().map_err(message)?.into_owned();
        let rel = safe_entry_path(&entry, &name).ok_or_else(|| {
            format!("Nothing was imported: the zip holds an unsafe path, \"{name}\"")
        })?;
        let in_app_dir = rel.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(|dir| crate::is_reserved_dir(dir) && !dir.eq_ignore_ascii_case("assets"))
        });
        if in_app_dir {
            continue;
        }
        let target = root.join(&rel);
        if entry.is_dir() {
            dirs.push(target);
        } else if !target.exists() {
            files.push((index, target));
        } else {
            let size = entry.size();
            if !same_content(&target, &mut entry, size)? {
                conflicts.push(name);
            }
        }
    }
    if let Some(first) = conflicts.first() {
        return Err(format!(
            "Nothing was imported: {} file(s) already exist with different content, such as \"{first}\". Import into an empty folder.",
            conflicts.len()
        ));
    }
    for dir in dirs {
        std::fs::create_dir_all(dir).map_err(message)?;
    }
    for (index, target) in &files {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(message)?;
        }
        let mut out = File::create_new(target).map_err(message)?;
        let mut entry = archive.by_index(*index).map_err(message)?;
        std::io::copy(&mut entry, &mut out).map_err(message)?;
    }
    Ok(files.len())
}
