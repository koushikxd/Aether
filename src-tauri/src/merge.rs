//! The conflicts of an unfinished merge, public and private, for the merge editor.

use crate::git;
use crate::vault::{self, Key};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConflictChunk {
    Same { text: String },
    Conflict { ours: String, theirs: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub is_private: bool,
    pub pick_only: bool,
    pub ours_deleted: bool,
    pub theirs_deleted: bool,
    pub chunks: Vec<ConflictChunk>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConflictResolution {
    Text { content: String },
    Ours,
    Theirs,
}

enum Source {
    Public,
    /// A file blob that git could not merge.
    Blob(String),
    /// Two blobs that the merge left with the same plaintext path.
    Duplicate {
        ours: String,
        theirs: String,
    },
}

struct Conflict {
    path: String,
    source: Source,
    base: Option<Vec<u8>>,
    ours: Option<Vec<u8>>,
    theirs: Option<Vec<u8>>,
}

/// Stage `n` (1 base, 2 ours, 3 theirs) of `path` in the index.
fn stage(root: &Path, n: u8, path: &str) -> Option<Vec<u8>> {
    git::run(root, &["show", &format!(":{n}:{path}")]).ok()
}

fn blob_conflict(root: &Path, key: &Key, path: &str, id: String) -> Result<Conflict, String> {
    let mut sides = Vec::new();
    for n in 1..=3 {
        sides.push(
            stage(root, n, path)
                .map(|blob| vault::open_file_blob(key, &id, &blob))
                .transpose()?,
        );
    }
    let [base, ours, theirs]: [Option<(String, Vec<u8>)>; 3] =
        sides.try_into().expect("three stages");
    let plain_path = ours
        .as_ref()
        .or(theirs.as_ref())
        .map(|(p, _)| p.clone())
        .ok_or("A private page could not be decrypted")?;
    Ok(Conflict {
        path: plain_path,
        source: Source::Blob(id),
        base: base.map(|(_, c)| c),
        ours: ours.map(|(_, c)| c),
        theirs: theirs.map(|(_, c)| c),
    })
}

/// Blobs that decrypt to the same path, such as one new private page made on
/// each device. Ours is the one in HEAD.
fn duplicates(root: &Path, key: &Key, unmerged: &[String]) -> Result<Vec<Conflict>, String> {
    let mut by_path: BTreeMap<String, Vec<(String, Vec<u8>)>> = BTreeMap::new();
    for (id, blob) in vault::file_blobs(root)? {
        if unmerged.contains(&vault::file_blob_path(&id)) {
            continue;
        }
        let (path, content) = vault::open_file_blob(key, &id, &blob)?;
        by_path.entry(path).or_default().push((id, content));
    }
    let mut found = Vec::new();
    for (path, mut blobs) in by_path.into_iter().filter(|(_, b)| b.len() > 1) {
        let in_head = |id: &str| {
            git::run(
                root,
                &[
                    "cat-file",
                    "-e",
                    &format!("HEAD:{}", vault::file_blob_path(id)),
                ],
            )
            .is_ok()
        };
        let ours_at = blobs.iter().position(|(id, _)| in_head(id)).unwrap_or(0);
        let (ours_id, ours) = blobs.remove(ours_at);
        let (theirs_id, theirs) = blobs.remove(0);
        found.push(Conflict {
            path,
            source: Source::Duplicate {
                ours: ours_id,
                theirs: theirs_id,
            },
            base: None,
            ours: Some(ours),
            theirs: Some(theirs),
        });
    }
    Ok(found)
}

fn unmerged_paths(root: &Path) -> Result<Vec<String>, String> {
    let out = git::run(root, &["diff", "--name-only", "-z", "--diff-filter=U"])?;
    Ok(String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

fn find(root: &Path, key: Option<&Key>) -> Result<Vec<Conflict>, String> {
    if !git::merge_in_progress(root) {
        return Ok(Vec::new());
    }
    let unmerged = unmerged_paths(root)?;
    let mut found = Vec::new();
    for path in &unmerged {
        match vault::file_blob_id(path) {
            Some(id) => {
                let key = key.ok_or("Enter the key to resolve conflicts in private pages")?;
                found.push(blob_conflict(root, key, path, id)?);
            }
            None => found.push(Conflict {
                path: path.clone(),
                source: Source::Public,
                base: stage(root, 1, path),
                ours: stage(root, 2, path),
                theirs: stage(root, 3, path),
            }),
        }
    }
    if let Some(key) = key {
        found.extend(duplicates(root, key, &unmerged)?);
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

/// Whether the merge in progress gave two blobs the same path.
pub fn has_duplicates(root: &Path, key: &Key) -> Result<bool, String> {
    Ok(!duplicates(root, key, &unmerged_paths(root)?)?.is_empty())
}

/// Splits `git merge-file` output into shared text and conflicts.
fn parse_chunks(merged: &str) -> Vec<ConflictChunk> {
    enum Side {
        Same,
        Ours,
        Theirs,
    }
    let mut chunks = Vec::new();
    let (mut same, mut ours, mut theirs) = (String::new(), String::new(), String::new());
    let mut side = Side::Same;
    for line in merged.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        match side {
            Side::Same if bare == "<<<<<<< ours" => {
                if !same.is_empty() {
                    chunks.push(ConflictChunk::Same {
                        text: std::mem::take(&mut same),
                    });
                }
                side = Side::Ours;
            }
            Side::Ours if bare == "=======" => side = Side::Theirs,
            Side::Theirs if bare == ">>>>>>> theirs" => {
                chunks.push(ConflictChunk::Conflict {
                    ours: std::mem::take(&mut ours),
                    theirs: std::mem::take(&mut theirs),
                });
                side = Side::Same;
            }
            Side::Same => same.push_str(line),
            Side::Ours => ours.push_str(line),
            Side::Theirs => theirs.push_str(line),
        }
    }
    if !same.is_empty() {
        chunks.push(ConflictChunk::Same { text: same });
    }
    chunks
}

/// Merges the three texts with `git merge-file`, in temp files inside
/// `.git` so private text stays in the notes folder.
fn merge_chunks(
    root: &Path,
    base: &str,
    ours: &str,
    theirs: &str,
) -> Result<Vec<ConflictChunk>, String> {
    let dir = tempfile::tempdir_in(root.join(".git")).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for (name, text) in [("ours", ours), ("base", base), ("theirs", theirs)] {
        let path = dir.path().join(name);
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        paths.push(path.to_string_lossy().into_owned());
    }
    let mut args = vec!["-c", "merge.conflictStyle=merge", "merge-file", "-p"];
    args.extend(["-L", "ours", "-L", "base", "-L", "theirs"]);
    args.extend(paths.iter().map(String::as_str));
    // merge-file exits with the number of conflicts, so only stdout tells.
    let out = git::output(root, &args, b"")?;
    if !out.status.code().is_some_and(|c| (0..128).contains(&c)) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_chunks(&String::from_utf8_lossy(&out.stdout)))
}

fn as_text(side: &Option<Vec<u8>>) -> Option<&str> {
    match side {
        Some(bytes) => std::str::from_utf8(bytes)
            .ok()
            .filter(|t| !t.contains('\0')),
        None => Some(""),
    }
}

fn to_file(root: &Path, c: Conflict) -> Result<ConflictFile, String> {
    let texts = (as_text(&c.base), as_text(&c.ours), as_text(&c.theirs));
    let chunks = match texts {
        (Some(base), Some(ours), Some(theirs)) if c.ours.is_some() && c.theirs.is_some() => {
            merge_chunks(root, base, ours, theirs)?
        }
        _ => Vec::new(),
    };
    Ok(ConflictFile {
        is_private: !matches!(c.source, Source::Public),
        pick_only: chunks.is_empty(),
        ours_deleted: c.ours.is_none(),
        theirs_deleted: c.theirs.is_none(),
        path: c.path,
        chunks,
    })
}

/// The conflicting files of the merge in progress; empty when there is none.
pub fn conflicts(root: &Path, store: &dyn vault::KeyStore) -> Result<Vec<ConflictFile>, String> {
    let key = vault::key_for(root, store)?;
    find(root, key.as_ref())?
        .into_iter()
        .map(|c| to_file(root, c))
        .collect()
}

fn stage_path(root: &Path, path: &str) -> Result<(), String> {
    git::run(root, &["--literal-pathspecs", "add", "--", path]).map(drop)
}

fn remove_path(root: &Path, path: &str) -> Result<(), String> {
    git::run(
        root,
        &[
            "--literal-pathspecs",
            "rm",
            "--quiet",
            "--force",
            "--",
            path,
        ],
    )
    .map(drop)
}

/// Writes and stages the resolution of the conflict at `path`, encrypting it
/// when the file is private.
pub fn resolve(
    root: &Path,
    store: &dyn vault::KeyStore,
    path: &str,
    resolution: ConflictResolution,
) -> Result<(), String> {
    let key = vault::key_for(root, store)?;
    let conflict = find(root, key.as_ref())?
        .into_iter()
        .find(|c| c.path == path)
        .ok_or("That file has no conflict to resolve")?;
    let content = match resolution {
        ConflictResolution::Text { content } => Some(content.into_bytes()),
        ConflictResolution::Ours => conflict.ours,
        ConflictResolution::Theirs => conflict.theirs,
    };
    // Private sources are only found with the key.
    let key = || key.as_ref().expect("private conflicts need the key");
    match (conflict.source, content) {
        (Source::Public, Some(content)) => {
            let target = crate::dir_from_id(root, path);
            std::fs::create_dir_all(target.parent().expect("file has a parent"))
                .map_err(|e| e.to_string())?;
            std::fs::write(target, content).map_err(|e| e.to_string())?;
            stage_path(root, path)
        }
        (Source::Public, None) => remove_path(root, path),
        (Source::Blob(id), Some(content)) => {
            vault::write_private(root, key(), &id, path, &content)?;
            stage_path(root, &vault::file_blob_path(&id))
        }
        (Source::Blob(id), None) => {
            remove_path(root, &vault::file_blob_path(&id))?;
            vault::remove_private(root, path)
        }
        (Source::Duplicate { ours, theirs }, content) => {
            if let Some(content) = content {
                vault::write_private(root, key(), &ours, path, &content)?;
                stage_path(root, &vault::file_blob_path(&ours))?;
            }
            remove_path(root, &vault::file_blob_path(&theirs))
        }
    }
}

/// Commits the merge once nothing is left to resolve, then decrypts it.
pub fn finish(
    root: &Path,
    ignored: &[String],
    store: &dyn vault::KeyStore,
) -> Result<git::GitResult, String> {
    let key = vault::key_for(root, store)?;
    if !find(root, key.as_ref())?.is_empty() {
        return Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Resolve every conflict first".to_string()),
        });
    }
    let result = vault::commit_merge(root, ignored, key.as_ref())?;
    if let Some(key) = key {
        vault::sync_plaintext(root, ignored, &key)?;
    }
    Ok(result)
}

/// `git merge --abort`, then the private plaintext from before the pull.
pub fn abort(
    root: &Path,
    ignored: &[String],
    store: &dyn vault::KeyStore,
) -> Result<git::GitResult, String> {
    let result = git::abort_merge(root);
    vault::decrypt(root, ignored, store)?;
    Ok(result)
}
