//! Git for the agent CLI. `commit` and `sync` run in the app, which holds
//! the vault key: the CLI writes a request into a mailbox in the app data
//! folder and the app writes back a reply. Replies name public pages only
//! and give private ones as a count.

use crate::merge::{self, ConflictFile, ConflictResolution};
use crate::vault::{self, KeyStore};
use crate::{git, git::GitResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const WRONG_FOLDER: &str =
    "Aether has a different notes folder open: open this one in Aether first";
/// The message of the app's own quick commit.
const DEFAULT_MESSAGE: &str = "Quick commit from Aether";
const WITHHELD: &str =
    "Aether could not finish this, for a reason that names a private page: see the app";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Commit,
    Sync,
    SyncContinue,
    SyncAbort,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// The notes folder, canonical.
    pub folder: PathBuf,
    pub action: Action,
    /// The commit message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Error,
    /// Public conflicts for the agent to resolve.
    Conflicts,
    /// Private conflicts, handed to the user in the app.
    HandedOff,
}

/// A public file of an unfinished merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    /// The page id when the file is a page.
    pub page: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub outcome: Outcome,
    pub message: String,
    #[serde(default)]
    pub conflicts: Vec<Conflict>,
    #[serde(default)]
    pub private_conflicts: usize,
}

impl Reply {
    fn new(outcome: Outcome, message: impl Into<String>) -> Self {
        Reply {
            outcome,
            message: message.into(),
            conflicts: Vec::new(),
            private_conflicts: 0,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Reply::new(Outcome::Error, message)
    }
}

impl From<GitResult> for Reply {
    fn from(result: GitResult) -> Self {
        match result {
            GitResult {
                success: true,
                message,
                ..
            } => Reply::new(Outcome::Ok, message.unwrap_or_default()),
            GitResult { error, .. } => Reply::error(error.unwrap_or_default()),
        }
    }
}

/// Runs `request` on `open`, the notes folder open in the app, and returns
/// a reply that names nothing private.
pub fn handle(
    request: &Request,
    open: Option<&Path>,
    ignored: &[String],
    store: &dyn KeyStore,
) -> Reply {
    let Some(root) = open.filter(|root| same_folder(root, &request.folder)) else {
        return Reply::error(WRONG_FOLDER);
    };
    // Before and after, since a pull can change what is private.
    let before = vault::private_names(root, ignored);
    let reply = match request.action {
        Action::Commit => {
            let message = request.message.as_deref().unwrap_or(DEFAULT_MESSAGE);
            vault::commit(root, ignored, store, message).into()
        }
        Action::Sync => sync(root, ignored, store),
        Action::SyncContinue => continue_sync(root, ignored, store),
        Action::SyncAbort => {
            merge::abort(root, ignored, store).map_or_else(Reply::error, Reply::from)
        }
    };
    let after = vault::private_names(root, ignored);
    redact(reply, &[before, after])
}

fn same_folder(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}

/// `reply` with its message withheld when it names a private page or file,
/// or when the private names could not be read.
fn redact(mut reply: Reply, names: &[Result<BTreeSet<String>, String>]) -> Reply {
    let leaks = names.iter().any(|names| match names {
        Ok(names) => names
            .iter()
            .any(|name| reply.message.contains(name.as_str())),
        Err(_) => true,
    });
    if leaks {
        reply.message = WITHHELD.to_string();
    }
    reply
}

fn sync(root: &Path, ignored: &[String], store: &dyn KeyStore) -> Reply {
    let pulled = vault::pull(root, ignored, store);
    if pulled.success {
        return push_if_ahead(root, pulled.message.as_deref().unwrap_or_default());
    }
    if git::merge_in_progress(root) {
        return match conflicts(root, ignored, store) {
            Ok((public, private)) => conflict_reply(root, ignored, &public, private),
            Err(error) => Reply::error(error),
        };
    }
    pulled.into()
}

/// Pushes when the branch has commits its upstream lacks, as the app's sync does.
fn push_if_ahead(root: &Path, done: &str) -> Reply {
    let status = git::get_status(root);
    if !(status.has_upstream && status.ahead_count > 0) {
        return Reply::new(Outcome::Ok, done);
    }
    match git::push(root) {
        GitResult { success: true, .. } => Reply::new(Outcome::Ok, format!("{done}, and pushed")),
        GitResult { error, .. } => Reply::error(format!(
            "{done}, but the push failed: {}",
            error.unwrap_or_default()
        )),
    }
}

/// The public conflicts of the merge in progress, and how many are private.
/// A public path that is private on this device counts as private.
fn conflicts(
    root: &Path,
    ignored: &[String],
    store: &dyn KeyStore,
) -> Result<(Vec<ConflictFile>, usize), String> {
    let private_set = vault::current_private_set(root, ignored)?;
    let (private, public): (Vec<_>, Vec<_>) = merge::conflicts(root, store)?
        .into_iter()
        .partition(|f| f.is_private || private_set.contains(&f.path));
    Ok((public, private.len()))
}

fn private_count(n: usize) -> String {
    match n {
        1 => "1 private page needs you in Aether".to_string(),
        n => format!("{n} private pages need you in Aether"),
    }
}

fn conflict_reply(
    root: &Path,
    ignored: &[String],
    public: &[ConflictFile],
    private: usize,
) -> Reply {
    let mut message = "Sync stopped on conflicts. Remove the conflict markers from the files listed, then run aether sync --continue".to_string();
    if private > 0 {
        message.push_str(&format!(". After that, {}", private_count(private)));
    }
    Reply {
        conflicts: public
            .iter()
            .map(|f| Conflict {
                path: f.path.clone(),
                page: crate::id_from_abs_path(root, &crate::dir_from_id(root, &f.path), ignored),
            })
            .collect(),
        private_conflicts: private,
        ..Reply::new(Outcome::Conflicts, message)
    }
}

/// Whether `path` still holds a git conflict marker, inside fenced code too,
/// where git writes them as well.
fn has_markers(root: &Path, path: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(crate::dir_from_id(root, path)) else {
        return false;
    };
    text.lines().any(|line| {
        ["<<<<<<<", ">>>>>>>"].iter().any(|marker| {
            line.strip_prefix(marker)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
        })
    })
}

/// The file as it is on disk, which is how the agent resolved it. A deleted
/// file takes the side that deleted it. A binary file keeps the version git
/// left, which is this device's.
fn resolution(root: &Path, file: &ConflictFile) -> ConflictResolution {
    match std::fs::read(crate::dir_from_id(root, &file.path)) {
        Err(_) if file.theirs_deleted && !file.ours_deleted => ConflictResolution::Theirs,
        Err(_) => ConflictResolution::Ours,
        Ok(bytes) => String::from_utf8(bytes).map_or(ConflictResolution::Ours, |content| {
            ConflictResolution::Text { content }
        }),
    }
}

fn continue_sync(root: &Path, ignored: &[String], store: &dyn KeyStore) -> Reply {
    if !git::merge_in_progress(root) {
        return Reply::error("There is no sync to continue");
    }
    let (public, private) = match conflicts(root, ignored, store) {
        Ok(found) => found,
        Err(error) => return Reply::error(error),
    };
    let unresolved: Vec<ConflictFile> = public
        .iter()
        .filter(|f| has_markers(root, &f.path))
        .map(|f| ConflictFile {
            path: f.path.clone(),
            is_private: false,
            pick_only: f.pick_only,
            ours_deleted: f.ours_deleted,
            theirs_deleted: f.theirs_deleted,
            chunks: Vec::new(),
        })
        .collect();
    if !unresolved.is_empty() {
        return conflict_reply(root, ignored, &unresolved, private);
    }
    for file in &public {
        if let Err(error) = merge::resolve(root, store, &file.path, resolution(root, file)) {
            return Reply::error(error);
        }
    }
    if private > 0 {
        return Reply {
            private_conflicts: private,
            ..Reply::new(Outcome::HandedOff, private_count(private))
        };
    }
    match merge::finish(root, ignored, store) {
        Ok(GitResult { success: true, .. }) => push_if_ahead(root, "Merged"),
        Ok(result) => result.into(),
        Err(error) => Reply::error(error),
    }
}
