//! Private pages. Their plaintext stays on disk, excluded from git through
//! `.git/info/exclude`, and only encrypted blobs in `.aether/vault/` are
//! committed. Local state (the marks and a per-file cache) lives in
//! `.git/aether-vault.json`, which is never committed.

use crate::git;
use crate::relink;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use walkdir::WalkDir;

const SERVICE: &str = "app.aether.vault";
const KEY_PREFIX: &str = "aether-key-";
const KEY_CHECK: &[u8] = b"aether-key-check";
const KEY_CHECK_AAD: &str = "keyCheck";
const NONCE_LEN: usize = 24;
const BLOCK_BEGIN: &str = "# aether-private-begin";
const BLOCK_END: &str = "# aether-private-end";
const HOOK_MARKER: &str = "# aether-private-pages";
/// Refuses a commit made outside the app whose index holds a private file.
/// The hook runs at the top of the work tree, where `ls-files` lists all of
/// the index. Only the patterns of the Aether block are passed, so a
/// `.gitignore` negation does not hide a staged private file.
const HOOK: &str = r##"#!/bin/sh
# aether-private-pages
# Installed by Aether. Refuses commits that hold private pages unencrypted.
exclude=$(git rev-parse --git-path info/exclude)
[ -f "$exclude" ] || exit 0
while IFS= read -r line; do
	case $line in
	"# aether-private-begin") on=1 ;;
	"# aether-private-end") on= ;;
	*) [ -n "$on" ] && set -- "$@" "--exclude=$line" ;;
	esac
done <"$exclude"
[ $# -eq 0 ] && exit 0
leaks=$(git ls-files --cached --ignored "$@")
[ -z "$leaks" ] && exit 0
{
	echo "Aether: these files belong to private pages and would be committed unencrypted:"
	echo "$leaks" | sed 's/^/  /'
	echo "Commit from the Aether app, which encrypts them first."
} >&2
exit 1
"##;
const FILES: &str = "files";
const ROOTS: &str = "roots";

/// Where the key of each vault is kept, by vault id.
pub trait KeyStore: Send + Sync {
    fn get(&self, vault_id: &str) -> Result<Option<String>, String>;
    fn set(&self, vault_id: &str, key: &str) -> Result<(), String>;
}

/// The OS keychain.
pub struct OsKeyStore;

fn keychain_error(e: keyring::Error) -> String {
    format!("Could not use the system keychain: {e}")
}

impl KeyStore for OsKeyStore {
    fn get(&self, vault_id: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, vault_id).map_err(keychain_error)?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(e)),
        }
    }

    fn set(&self, vault_id: &str, key: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, vault_id)
            .and_then(|entry| entry.set_password(key))
            .map_err(keychain_error)
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryKeyStore(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl KeyStore for MemoryKeyStore {
    fn get(&self, vault_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .0
            .lock()
            .expect("key store lock")
            .get(vault_id)
            .cloned())
    }

    fn set(&self, vault_id: &str, key: &str) -> Result<(), String> {
        self.0
            .lock()
            .expect("key store lock")
            .insert(vault_id.to_string(), key.to_string());
        Ok(())
    }
}

/// The OS keychain, or in tests a store in memory.
pub fn default_store() -> Arc<dyn KeyStore> {
    #[cfg(test)]
    return Arc::new(MemoryKeyStore::default());
    #[cfg(not(test))]
    Arc::new(OsKeyStore)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub has_vault: bool,
    pub unlocked: bool,
    pub locked_count: usize,
    pub private_roots: Vec<String>,
    pub private_note_ids: Vec<String>,
}

pub struct Key([u8; 32]);

impl Key {
    pub fn generate() -> Self {
        Key(rand::random())
    }

    fn text(&self) -> String {
        format!("{KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(self.0))
    }

    fn parse(text: &str) -> Option<Self> {
        let bytes = URL_SAFE_NO_PAD
            .decode(text.trim().strip_prefix(KEY_PREFIX)?)
            .ok()?;
        Some(Key(bytes.try_into().ok()?))
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(&self.0.into())
    }
}

/// Encrypts `plaintext` with a random nonce, bound to `aad` (the blob's name),
/// as `nonce || ciphertext`.
pub fn seal(key: &Key, aad: &str, plaintext: &[u8]) -> Vec<u8> {
    let nonce: [u8; NONCE_LEN] = rand::random();
    let payload = Payload {
        msg: plaintext,
        aad: aad.as_bytes(),
    };
    let sealed = key
        .cipher()
        .encrypt(&XNonce::from(nonce), payload)
        .expect("XChaCha20-Poly1305 seals any note-sized input");
    [nonce.as_slice(), &sealed].concat()
}

pub fn open(key: &Key, aad: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    let damaged = || "A private page could not be decrypted".to_string();
    let nonce: [u8; NONCE_LEN] = blob
        .get(..NONCE_LEN)
        .and_then(|n| n.try_into().ok())
        .ok_or_else(damaged)?;
    let payload = Payload {
        msg: &blob[NONCE_LEN..],
        aad: aad.as_bytes(),
    };
    key.cipher()
        .decrypt(&XNonce::from(nonce), payload)
        .map_err(|_| damaged())
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn new_id() -> String {
    rand::random::<[u8; 16]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

/// `rel`, a `/`-separated path relative to `root`, as a path on disk.
fn abs(root: &Path, rel: &str) -> PathBuf {
    crate::dir_from_id(root, rel)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Whether `path` is strictly inside folder `dir`.
fn inside(path: &str, dir: &str) -> bool {
    path.strip_prefix(dir)
        .is_some_and(|rest| rest.starts_with('/'))
}

fn vault_dir(root: &Path) -> PathBuf {
    root.join(".aether").join("vault")
}

/// A blob's name, `files/<id>` or `roots/<id>`, which is also its associated data.
fn blob_name(kind: &str, id: &str) -> String {
    format!("{kind}/{id}")
}

/// The path of a file blob relative to the notes folder, as git shows it.
pub fn file_blob_path(id: &str) -> String {
    format!(".aether/vault/{FILES}/{id}.enc")
}

/// The blob id of a file blob path, the inverse of `file_blob_path`.
pub fn file_blob_id(path: &str) -> Option<String> {
    let id = path
        .strip_prefix(".aether/vault/files/")?
        .strip_suffix(".enc")?;
    (!id.contains('/')).then(|| id.to_string())
}

fn blob_file(root: &Path, kind: &str, id: &str) -> PathBuf {
    vault_dir(root).join(kind).join(format!("{id}.enc"))
}

/// Every blob of `kind` on disk, by id.
fn blobs(root: &Path, kind: &str) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let dir = vault_dir(root).join(kind);
    let mut found = BTreeMap::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(found);
    };
    for entry in entries {
        let path = entry.map_err(io)?.path();
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".enc"))
        else {
            continue;
        };
        found.insert(id.to_string(), fs::read(&path).map_err(io)?);
    }
    Ok(found)
}

pub fn file_blobs(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    blobs(root, FILES)
}

/// A file blob's plaintext path and content.
pub fn open_file_blob(key: &Key, id: &str, blob: &[u8]) -> Result<(String, Vec<u8>), String> {
    let plain = open(key, &blob_name(FILES, id), blob)?;
    let split = plain
        .iter()
        .position(|&b| b == 0)
        .ok_or("A private page could not be decrypted")?;
    let path = String::from_utf8(plain[..split].to_vec())
        .map_err(|_| "A private page could not be decrypted")?;
    let safe = !path.is_empty()
        && !path.starts_with(".git/")
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."));
    if !safe {
        return Err("A private page could not be decrypted".to_string());
    }
    Ok((path, plain[split + 1..].to_vec()))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u32,
    vault_id: String,
    key_check: String,
}

fn read_vault(root: &Path) -> Result<Option<VaultFile>, String> {
    match fs::read_to_string(vault_dir(root).join("vault.json")) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|_| "This folder's private pages file is damaged".to_string()),
        Err(_) => Ok(None),
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Local {
    /// The note ids marked private on this device.
    marks: BTreeSet<String>,
    /// Root blobs as of the last commit or sync, by blob id.
    roots: BTreeMap<String, CachedRoot>,
    /// Private files as of the last commit or sync, by plaintext path.
    files: BTreeMap<String, CachedFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedRoot {
    path: String,
    blob_hash: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFile {
    blob: String,
    /// Hash of the plaintext.
    hash: String,
    /// Hash of the encrypted blob, to notice blobs that a pull changed.
    blob_hash: String,
}

fn local_path(root: &Path) -> PathBuf {
    root.join(".git").join("aether-vault.json")
}

fn load(root: &Path) -> Result<Local, String> {
    match fs::read_to_string(local_path(root)) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|_| "This device's private pages state is damaged".to_string()),
        Err(_) => Ok(Local::default()),
    }
}

fn save(root: &Path, local: &Local) -> Result<(), String> {
    let text = serde_json::to_string_pretty(local).map_err(|e| e.to_string())?;
    fs::write(local_path(root), text).map_err(io)
}

/// Pinned private pages, kept out of the committed settings file. A file of
/// their own, so saving pins never races with saving marks.
fn pins_path(root: &Path) -> PathBuf {
    root.join(".git").join("aether-pins.json")
}

/// Where private plaintext waits while `pull` runs.
fn stash_dir(root: &Path) -> PathBuf {
    root.join(".git").join("aether-stash")
}

fn require_repo(root: &Path) -> Result<(), String> {
    if git::is_git_repo(root) {
        Ok(())
    } else {
        Err("Set up Git for this folder first".to_string())
    }
}

/// This device's key for the folder's vault, if both exist.
pub fn key_for(root: &Path, store: &dyn KeyStore) -> Result<Option<Key>, String> {
    if !git::is_git_repo(root) {
        return Ok(None);
    }
    let Some(vault) = read_vault(root)? else {
        return Ok(None);
    };
    Ok(store
        .get(&vault.vault_id)?
        .and_then(|text| Key::parse(&text)))
}

/// The files that are private: marked pages, everything in their sub-page
/// folders, and assets that only private pages use.
#[derive(Default)]
pub struct PrivateSet {
    roots: BTreeSet<String>,
    assets: BTreeSet<String>,
    /// Public notes that link to a private file, which would expose its path.
    linked_from_public: BTreeSet<String>,
}

impl PrivateSet {
    /// The marked pages and their sub-pages, without the assets.
    fn pages(marks: &BTreeSet<String>) -> Self {
        PrivateSet {
            roots: marks.clone(),
            ..PrivateSet::default()
        }
    }

    fn in_pages(&self, path: &str) -> bool {
        self.roots
            .iter()
            .any(|r| path.strip_suffix(".md") == Some(r.as_str()) || inside(path, r))
    }

    pub fn contains(&self, path: &str) -> bool {
        self.assets.contains(path) || self.in_pages(path)
    }

    pub fn contains_dir(&self, dir: &str) -> bool {
        self.roots.iter().any(|r| dir == r || inside(dir, r))
    }

    /// The private files that exist on disk.
    fn files(&self, root: &Path) -> BTreeSet<String> {
        let mut files = self.assets.clone();
        for r in &self.roots {
            let page = format!("{r}.md");
            if abs(root, &page).is_file() {
                files.insert(page);
            }
            let under = WalkDir::new(abs(root, r))
                .min_depth(1)
                .into_iter()
                .flatten();
            files.extend(
                under
                    .filter(|e| e.file_type().is_file())
                    .map(|e| relative(root, e.path())),
            );
        }
        files
    }
}

/// Paths (`<id>.md`) of every note.
fn note_paths(root: &Path, ignored: &[String]) -> Vec<String> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| crate::is_visible_notes_entry(e, ignored))
        .flatten()
        .filter_map(|e| crate::id_from_abs_path(root, e.path(), ignored))
        .map(|id| format!("{id}.md"))
        .collect()
}

/// The titles in the `[[Title]]` wikilinks of `markdown`, lowercased.
fn wikilinks(markdown: &str) -> Vec<String> {
    markdown
        .split("[[")
        .skip(1)
        .filter_map(|rest| rest.split_once("]]"))
        .map(|(title, _)| title)
        .filter(|title| !title.is_empty() && !title.contains(']'))
        .map(str::to_lowercase)
        .collect()
}

fn private_set(root: &Path, local: &Local, ignored: &[String]) -> PrivateSet {
    let mut set = PrivateSet::pages(&local.marks);
    if local.marks.is_empty() && local.files.is_empty() {
        return set;
    }
    // An asset stays private once encrypted, until a public page uses it.
    let mut private: BTreeSet<String> = local
        .files
        .keys()
        .filter(|p| p.starts_with("assets/"))
        .cloned()
        .collect();
    let mut public = BTreeSet::new();
    let mut private_titles = BTreeSet::new();
    let mut public_wikilinks = Vec::new();
    for note in note_paths(root, ignored) {
        let Ok(markdown) = fs::read_to_string(abs(root, &note)) else {
            continue;
        };
        let links = relink::linked_paths(&markdown, &note);
        let used = links.iter().filter(|p| p.starts_with("assets/")).cloned();
        if set.in_pages(&note) {
            private.extend(used);
            private_titles.insert(crate::extract_title(&markdown).to_lowercase());
        } else {
            public.extend(used);
            if links.iter().any(|p| set.in_pages(p)) {
                set.linked_from_public.insert(note);
            } else {
                public_wikilinks.push((note, wikilinks(&markdown)));
            }
        }
    }
    for (note, titles) in public_wikilinks {
        if titles.iter().any(|t| private_titles.contains(t)) {
            set.linked_from_public.insert(note);
        }
    }
    set.assets = private
        .difference(&public)
        .filter(|p| abs(root, p).is_file())
        .cloned()
        .collect();
    set
}

/// The private set from this device's marks, for leaving private files out of an export.
pub fn current_private_set(root: &Path, ignored: &[String]) -> Result<PrivateSet, String> {
    Ok(private_set(root, &load(root)?, ignored))
}

/// Escapes the characters that gitignore patterns treat as wildcards.
fn escape_pattern(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Rewrites the Aether block of `.git/info/exclude` to list `set`.
fn write_exclude(root: &Path, set: &PrivateSet) -> Result<(), String> {
    let path = root.join(".git").join("info").join("exclude");
    let current = fs::read_to_string(&path).unwrap_or_default();
    let mut text = String::new();
    let mut in_block = false;
    for line in current.lines() {
        match line {
            BLOCK_BEGIN => in_block = true,
            BLOCK_END => in_block = false,
            _ if !in_block => {
                text.push_str(line);
                text.push('\n');
            }
            _ => {}
        }
    }
    let mut patterns: Vec<String> = Vec::new();
    for r in &set.roots {
        patterns.push(format!("/{}.md", escape_pattern(r)));
        patterns.push(format!("/{}/", escape_pattern(r)));
    }
    patterns.extend(set.assets.iter().map(|a| format!("/{}", escape_pattern(a))));
    if !patterns.is_empty() {
        install_hook(root)?;
        text.push_str(&format!(
            "{BLOCK_BEGIN}\n{}\n{BLOCK_END}\n",
            patterns.join("\n")
        ));
    }
    if text == current {
        return Ok(());
    }
    fs::create_dir_all(path.parent().expect("exclude has a parent")).map_err(io)?;
    fs::write(path, text).map_err(io)
}

/// Writes `HOOK` as the pre-commit and pre-merge-commit hooks. Leaves alone a hook that is not
/// Aether's, and skips when `core.hooksPath` makes git ignore `.git/hooks`.
fn install_hook(root: &Path) -> Result<(), String> {
    // A terminal `git merge` that commits runs `pre-merge-commit`, not `pre-commit`.
    for name in ["pre-commit", "pre-merge-commit"] {
        let path = root.join(".git").join("hooks").join(name);
        if let Ok(current) = fs::read(&path) {
            let ours = String::from_utf8_lossy(&current)
                .lines()
                .any(|line| line == HOOK_MARKER);
            if current == HOOK.as_bytes() || !ours {
                continue;
            }
        }
        if git::run(root, &["config", "core.hooksPath"]).is_ok() {
            return Ok(());
        }
        fs::create_dir_all(path.parent().expect("hook has a parent")).map_err(io)?;
        fs::write(&path, HOOK).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(io)?;
        }
    }
    Ok(())
}

fn save_and_exclude(root: &Path, local: &Local, ignored: &[String]) -> Result<(), String> {
    save(root, local)?;
    resplit_pins(root)?;
    let set = private_set(root, local, ignored);
    write_exclude(root, &set)?;
    // Excluded files that git tracks still get staged. A merge keeps its
    // conflicts for the editor; `commit_merge` untracks then.
    if git::merge_in_progress(root) {
        return Ok(());
    }
    untrack(root, &set.files(root))
}

/// The pins in `pinned` that are public, for the committed settings file.
/// The private ones go to local state, where `private_pins` reads them.
pub fn keep_private_pins(root: &Path, pinned: &[String]) -> Result<Vec<String>, String> {
    let marks = load(root)?.marks;
    let pins = private_pins(root);
    if marks.is_empty() && pins.is_empty() {
        return Ok(pinned.to_vec());
    }
    let pages = PrivateSet::pages(&marks);
    let (private, public): (Vec<String>, Vec<String>) = pinned
        .iter()
        .cloned()
        .partition(|id| pages.in_pages(&format!("{id}.md")));
    if pins != private {
        let text = serde_json::to_string(&private).map_err(|e| e.to_string())?;
        fs::write(pins_path(root), text).map_err(io)?;
    }
    Ok(public)
}

pub fn private_pins(root: &Path) -> Vec<String> {
    fs::read_to_string(pins_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Saves the settings file again, so its pins follow changed marks.
fn resplit_pins(root: &Path) -> Result<(), String> {
    let folder = root.to_string_lossy();
    let settings = crate::load_settings(&folder);
    if settings.pinned_note_ids.is_none() {
        return Ok(());
    }
    crate::save_settings(&folder, &settings).map_err(|e| e.to_string())
}

/// Updates the exclude block when a private page that uses assets is saved,
/// so an asset it just started using stays out of a commit from the terminal.
pub fn page_saved(root: &Path, ignored: &[String], id: &str, markdown: &str) -> Result<(), String> {
    let local = load(root)?;
    let path = format!("{id}.md");
    let uses_assets = || {
        relink::linked_paths(markdown, &path)
            .iter()
            .any(|p| p.starts_with("assets/"))
    };
    if PrivateSet::pages(&local.marks).in_pages(&path) && uses_assets() {
        write_exclude(root, &private_set(root, &local, ignored))?;
    }
    Ok(())
}

fn tracked_files(root: &Path) -> Result<BTreeSet<String>, String> {
    let out = git::run(root, &["ls-files", "-z"])?;
    Ok(String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

/// `git rm --cached` for the private files git still tracks, such as a page
/// that was public before, or one a `.gitignore` negation let `git add` stage.
pub fn untrack(root: &Path, files: &BTreeSet<String>) -> Result<(), String> {
    let tracked: Vec<String> = tracked_files(root)?
        .into_iter()
        .filter(|p| files.contains(p))
        .collect();
    if tracked.is_empty() {
        return Ok(());
    }
    let args = [
        "--literal-pathspecs",
        "rm",
        "--cached",
        "--quiet",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
    ];
    git::run_with_input(root, &args, tracked.join("\0").as_bytes()).map(drop)
}

/// Encrypts `content`, the private file at `path`, into file blob `id`.
fn write_file_blob(
    root: &Path,
    key: &Key,
    id: &str,
    path: &str,
    content: &[u8],
) -> Result<CachedFile, String> {
    let blob = seal(
        key,
        &blob_name(FILES, id),
        &[path.as_bytes(), &[0], content].concat(),
    );
    let file = blob_file(root, FILES, id);
    fs::create_dir_all(file.parent().expect("blob has a parent")).map_err(io)?;
    fs::write(file, &blob).map_err(io)?;
    Ok(CachedFile {
        blob: id.to_string(),
        hash: sha(content),
        blob_hash: sha(&blob),
    })
}

/// Writes `content` to private file `path` and into its blob `id`.
pub fn write_private(
    root: &Path,
    key: &Key,
    id: &str,
    path: &str,
    content: &[u8],
) -> Result<(), String> {
    let target = abs(root, path);
    fs::create_dir_all(target.parent().expect("file has a parent")).map_err(io)?;
    fs::write(target, content).map_err(io)?;
    let mut local = load(root)?;
    local.files.insert(
        path.to_string(),
        write_file_blob(root, key, id, path, content)?,
    );
    save(root, &local)
}

/// Deletes private file `path`, whose blob is gone.
pub fn remove_private(root: &Path, path: &str) -> Result<(), String> {
    let target = abs(root, path);
    if target.is_file() {
        fs::remove_file(&target).map_err(io)?;
    }
    let mut local = load(root)?;
    local.files.remove(path);
    save(root, &local)
}

/// Brings the blobs up to date with the private plaintext, before a commit.
/// Unchanged files keep their blobs byte for byte. Returns the private files,
/// for `untrack` once the commit has staged.
pub fn before_commit(
    root: &Path,
    ignored: &[String],
    store: &dyn KeyStore,
) -> Result<BTreeSet<String>, String> {
    let Some(key) = key_for(root, store)? else {
        return Ok(BTreeSet::new());
    };
    let mut local = load(root)?;
    let set = private_set(root, &local, ignored);
    if !set.linked_from_public.is_empty() {
        let pages: Vec<&str> = set
            .linked_from_public
            .iter()
            .map(|p| p.strip_suffix(".md").unwrap_or(p))
            .collect();
        return Err(format!(
            "These public pages link to private pages: {}. Remove those links or make those pages private, then commit again.",
            pages.join(", ")
        ));
    }
    let files = set.files(root);
    // The `git add -A` of the commit stages the files no longer private.
    for path in update_blobs(root, &mut local, &files, &key)? {
        local.files.remove(&path);
    }
    write_exclude(root, &set)?;
    save(root, &local)?;
    Ok(files)
}

/// Encrypts the private `files` that changed into their blobs, deletes the
/// blobs of files no longer private, and writes the root blobs of new marks.
/// Returns the paths no longer private, whose cache entries the caller drops.
fn update_blobs(
    root: &Path,
    local: &mut Local,
    files: &BTreeSet<String>,
    key: &Key,
) -> Result<Vec<String>, String> {
    for path in files {
        let content = fs::read(abs(root, path)).map_err(io)?;
        let id = match local.files.get(path) {
            Some(c) if c.hash == sha(&content) && blob_file(root, FILES, &c.blob).is_file() => {
                continue
            }
            Some(c) => c.blob.clone(),
            None => new_id(),
        };
        let cached = write_file_blob(root, key, &id, path, &content)?;
        local.files.insert(path.clone(), cached);
    }
    let gone: Vec<String> = local
        .files
        .keys()
        .filter(|p| !files.contains(*p))
        .cloned()
        .collect();
    for path in &gone {
        if let Some(c) = local.files.get(path) {
            let _ = fs::remove_file(blob_file(root, FILES, &c.blob));
        }
    }
    let mut rooted = BTreeSet::new();
    local.roots.retain(|id, r| {
        let keep = local.marks.contains(&r.path);
        if keep {
            rooted.insert(r.path.clone());
        } else {
            let _ = fs::remove_file(blob_file(root, ROOTS, id));
        }
        keep
    });
    for mark in local.marks.difference(&rooted) {
        let id = new_id();
        let blob = seal(key, &blob_name(ROOTS, &id), mark.as_bytes());
        let file = blob_file(root, ROOTS, &id);
        fs::create_dir_all(file.parent().expect("blob has a parent")).map_err(io)?;
        fs::write(file, &blob).map_err(io)?;
        local.roots.insert(
            id,
            CachedRoot {
                path: mark.clone(),
                blob_hash: sha(&blob),
            },
        );
    }
    Ok(gone)
}

/// Private changes git cannot see: edited, new or removed private files and
/// changed marks since the last commit.
pub fn pending_count(root: &Path, ignored: &[String]) -> usize {
    let Ok(local) = load(root) else {
        return 0;
    };
    if local.marks.is_empty() && local.files.is_empty() && local.roots.is_empty() {
        return 0;
    }
    let files = private_set(root, &local, ignored).files(root);
    let edited = files
        .iter()
        .filter(|p| {
            local
                .files
                .get(*p)
                .is_none_or(|c| !fs::read(abs(root, p)).is_ok_and(|b| sha(&b) == c.hash))
        })
        .count();
    let removed = local.files.keys().filter(|p| !files.contains(*p)).count();
    let rooted: BTreeSet<&String> = local.roots.values().map(|r| &r.path).collect();
    let marks: BTreeSet<&String> = local.marks.iter().collect();
    edited + removed + rooted.symmetric_difference(&marks).count()
}

/// Removes the empty folders above `file`, up to the notes folder and `assets/`.
fn remove_empty_parents(root: &Path, file: &Path) {
    let assets = root.join("assets");
    for dir in file.ancestors().skip(1) {
        if dir == root || dir == assets || fs::remove_dir(dir).is_err() {
            break;
        }
    }
}

/// Moves the private plaintext out of the way of `git pull`, which would
/// refuse to overwrite it with a file another device made public.
fn stash(root: &Path, local: &Local) -> Result<(), String> {
    let stash = stash_dir(root);
    for path in local.files.keys() {
        let target = abs(root, path);
        if !target.is_file() {
            continue;
        }
        let stashed = stash.join(path);
        fs::create_dir_all(stashed.parent().expect("file has a parent")).map_err(io)?;
        fs::rename(&target, &stashed).map_err(io)?;
        remove_empty_parents(root, &target);
    }
    Ok(())
}

/// Moves stashed file `path` back. A file saved here while the pull ran is
/// newer than the stashed one, which is dropped.
fn unstash(root: &Path, path: &str) -> Result<(), String> {
    let stashed = stash_dir(root).join(path);
    let target = abs(root, path);
    if stashed.is_file() && !target.exists() {
        fs::create_dir_all(target.parent().expect("file has a parent")).map_err(io)?;
        return fs::rename(stashed, target).map_err(io);
    }
    let _ = fs::remove_file(stashed);
    Ok(())
}

/// Brings the private plaintext and marks up to date with the blobs: after
/// a pull, when a folder opens, and when a key is entered. Local edits since
/// the last commit are kept.
pub fn sync_plaintext(root: &Path, ignored: &[String], key: &Key) -> Result<(), String> {
    let mut local = load(root)?;
    let stash = stash_dir(root);

    let roots = blobs(root, ROOTS)?;
    for (id, blob) in &roots {
        let blob_hash = sha(blob);
        if local
            .roots
            .get(id)
            .is_some_and(|r| r.blob_hash == blob_hash)
        {
            continue;
        }
        let path = String::from_utf8(open(key, &blob_name(ROOTS, id), blob)?)
            .map_err(|_| "A private page could not be decrypted")?;
        if let Some(old) = local.roots.get(id) {
            local.marks.remove(&old.path);
        }
        local.marks.insert(path.clone());
        local
            .roots
            .insert(id.clone(), CachedRoot { path, blob_hash });
    }
    local.roots.retain(|id, r| {
        let keep = roots.contains_key(id);
        if !keep {
            local.marks.remove(&r.path);
        }
        keep
    });

    let files = file_blobs(root)?;
    let known: BTreeMap<String, String> = local
        .files
        .iter()
        .map(|(path, c)| (c.blob.clone(), path.clone()))
        .collect();
    // Blobs this device knows come first, so they keep their paths when a
    // new blob claims the same one.
    let (old, new): (Vec<_>, Vec<_>) = files.iter().partition(|(id, _)| known.contains_key(*id));
    let unchanged = |id: &String, blob_hash: &String| {
        known
            .get(id)
            .and_then(|path| local.files.get(path))
            .is_some_and(|c| &c.blob_hash == blob_hash)
    };
    // Every changed blob opens before any plaintext is written, so a damaged
    // one leaves no plaintext behind without its exclusion.
    let mut opened = BTreeMap::new();
    for (id, blob) in &files {
        if !unchanged(id, &sha(blob)) {
            opened.insert(id.clone(), open_file_blob(key, id, blob)?);
        }
    }
    // Excluded before any write or unstash, so a failure leaves none unexcluded.
    let mut excluded = private_set(root, &local, ignored);
    excluded.assets.extend(local.files.keys().cloned());
    excluded
        .assets
        .extend(opened.values().map(|(path, _)| path.clone()));
    write_exclude(root, &excluded)?;
    let mut claimed = BTreeSet::new();
    for (id, blob) in old.into_iter().chain(new) {
        let blob_hash = sha(blob);
        if let Some(path) = known.get(id) {
            if local
                .files
                .get(path)
                .is_some_and(|c| c.blob_hash == blob_hash)
            {
                unstash(root, path)?;
                claimed.insert(path.clone());
                continue;
            }
        }
        let (path, content) = opened.remove(id).expect("changed blobs were opened above");
        if !claimed.insert(path.clone()) {
            continue;
        }
        unstash(root, &path)?;
        let target = abs(root, &path);
        let hash = sha(&content);
        let current = fs::read(&target).ok();
        let current_hash = current.as_deref().map(sha);
        let cached = local.files.get(&path).map(|c| &c.hash);
        let edited = current_hash.is_some() && current_hash.as_ref() != cached;
        let incoming = cached != Some(&hash) && current_hash.as_ref() != Some(&hash);
        // An edit made here since the last commit stays, and that commit
        // will encrypt it over this blob. When the blob changed too, as after
        // a pull from the terminal, a note keeps both versions.
        let write = match (edited, incoming, current) {
            (true, true, Some(here)) if path.ends_with(".md") => {
                Some(both_versions(&here, &content))
            }
            (false, true, _) | (_, _, None) => Some(content),
            _ => None,
        };
        if let Some(bytes) = write {
            fs::create_dir_all(target.parent().expect("file has a parent")).map_err(io)?;
            fs::write(&target, bytes).map_err(io)?;
        }
        local.files.insert(
            path,
            CachedFile {
                blob: id.clone(),
                hash,
                blob_hash,
            },
        );
    }

    let tracked = tracked_files(root)?;
    let removed: Vec<String> = local
        .files
        .iter()
        .filter(|(_, c)| !files.contains_key(&c.blob))
        .map(|(path, _)| path.clone())
        .collect();
    for path in removed {
        let Some(c) = local.files.remove(&path) else {
            continue;
        };
        let stashed = stash.join(&path);
        let target = abs(root, &path);
        if stashed.is_file() {
            fs::remove_file(stashed).map_err(io)?;
        } else if !tracked.contains(&path) && fs::read(&target).is_ok_and(|b| sha(&b) == c.hash) {
            fs::remove_file(&target).map_err(io)?;
            remove_empty_parents(root, &target);
        }
    }
    if stash.exists() {
        fs::remove_dir_all(&stash).map_err(io)?;
    }
    // A merge can drop a page's mark and keep its file blob. The page stays private.
    for path in local.files.keys() {
        if let Some(id) = path.strip_suffix(".md") {
            if !PrivateSet::pages(&local.marks).in_pages(path) {
                local.marks.insert(id.to_string());
            }
        }
    }
    save_and_exclude(root, &local, ignored)
}

/// A note holding both versions between conflict markers, for the user to merge.
fn both_versions(here: &[u8], other: &[u8]) -> Vec<u8> {
    let block = |text: &[u8]| {
        let mut text = text.to_vec();
        if !text.ends_with(b"\n") {
            text.push(b'\n');
        }
        text
    };
    [
        b"<<<<<<< This device\n".as_slice(),
        &block(here),
        b"=======\n",
        &block(other),
        b">>>>>>> Other device\n",
    ]
    .concat()
}

/// Commits the merge in progress without the private files, which a
/// resolution or the other clone may have staged, and with their blobs.
pub fn commit_merge(
    root: &Path,
    ignored: &[String],
    key: Option<&Key>,
) -> Result<git::GitResult, String> {
    let mut local = load(root)?;
    // From the resolved notes, so a file they made public can be staged.
    let set = private_set(root, &local, ignored);
    write_exclude(root, &set)?;
    let files = set.files(root);
    if let Some(key) = key {
        let gone = update_blobs(root, &mut local, &files, key)?;
        // Saved before staging, so a retry reuses the new blob ids and still
        // finds the files no longer private.
        save(root, &local)?;
        let public: Vec<String> = gone
            .iter()
            .filter(|p| abs(root, p).is_file())
            .cloned()
            .collect();
        // A file no longer private goes in as its public copy, replacing its blob.
        let paths = [vec![".aether/vault".to_string()], public].concat();
        git::run_with_input(
            root,
            &[
                "--literal-pathspecs",
                "add",
                "-A",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            paths.join("\0").as_bytes(),
        )?;
        for path in &gone {
            local.files.remove(path);
        }
        save(root, &local)?;
    }
    untrack(root, &files)?;
    Ok(git::finish_merge(root))
}

/// `sync_plaintext` when this device has the key.
pub fn decrypt(root: &Path, ignored: &[String], store: &dyn KeyStore) -> Result<(), String> {
    match key_for(root, store)? {
        Some(key) => sync_plaintext(root, ignored, &key),
        None => Ok(()),
    }
}

fn failed(error: impl Into<String>) -> git::GitResult {
    git::GitResult {
        success: false,
        message: None,
        error: Some(error.into()),
    }
}

/// `git pull` that keeps private pages working: it refuses while private
/// changes are uncommitted, and decrypts what the pull brought. A merge that
/// gave two blobs the same path stops before its commit, as a conflict.
pub fn pull(root: &Path, ignored: &[String], store: &dyn KeyStore) -> git::GitResult {
    let pull_private = || -> Result<git::GitResult, String> {
        let Some(key) = key_for(root, store)? else {
            return Ok(git::pull(root, false));
        };
        if pending_count(root, ignored) > 0 {
            return Ok(failed("Commit your changes before syncing"));
        }
        stash(root, &load(root)?)?;
        let result = git::pull(root, true);
        let merging = result.success && git::merge_in_progress(root);
        let duplicates = merging && crate::merge::has_duplicates(root, &key)?;
        // Before the merge commit, so it sees the plaintext and marks the pull brought.
        sync_plaintext(root, ignored, &key)?;
        if duplicates {
            Ok(failed(git::CONFLICTS))
        } else if merging {
            commit_merge(root, ignored, Some(&key))
        } else {
            Ok(result)
        }
    };
    pull_private().unwrap_or_else(failed)
}

pub fn status(
    root: &Path,
    ignored: &[String],
    store: &dyn KeyStore,
) -> Result<VaultStatus, String> {
    let Some(vault) = read_vault(root)? else {
        return Ok(VaultStatus::default());
    };
    // A keychain that cannot be read counts as locked; entering the key shows its error.
    if store.get(&vault.vault_id).unwrap_or_default().is_none() {
        return Ok(VaultStatus {
            has_vault: true,
            locked_count: file_blobs(root)?.len(),
            ..VaultStatus::default()
        });
    }
    let marks = load(root)?.marks;
    let pages = PrivateSet::pages(&marks);
    let mut private_note_ids: Vec<String> = note_paths(root, ignored)
        .into_iter()
        .filter(|p| pages.in_pages(p))
        .map(|p| p.strip_suffix(".md").unwrap_or(&p).to_string())
        .collect();
    private_note_ids.sort();
    Ok(VaultStatus {
        has_vault: true,
        unlocked: true,
        locked_count: 0,
        private_roots: marks.into_iter().collect(),
        private_note_ids,
    })
}

/// Creates the vault and its key, running `git init` when the folder is not
/// a repository yet. Returns the key as text.
pub fn generate_key(root: &Path, store: &dyn KeyStore) -> Result<String, String> {
    if read_vault(root)?.is_some() {
        return Err("This folder already has a key".to_string());
    }
    if !git::is_git_repo(root) {
        git::git_init(root)?;
    }
    let key = Key::generate();
    let vault = VaultFile {
        version: 1,
        vault_id: new_id(),
        key_check: STANDARD.encode(seal(&key, KEY_CHECK_AAD, KEY_CHECK)),
    };
    store.set(&vault.vault_id, &key.text())?;
    let dir = vault_dir(root);
    fs::create_dir_all(&dir).map_err(io)?;
    let json = serde_json::to_string_pretty(&vault).map_err(|e| e.to_string())?;
    fs::write(dir.join("vault.json"), json).map_err(io)?;
    // Blobs never merge as text.
    fs::write(dir.join(".gitattributes"), "*.enc binary\n").map_err(io)?;
    Ok(key.text())
}

/// Checks `text` against the vault's key check, saves it, and decrypts.
pub fn enter_key(
    root: &Path,
    ignored: &[String],
    store: &dyn KeyStore,
    text: &str,
) -> Result<(), String> {
    require_repo(root)?;
    let vault = read_vault(root)?.ok_or("This folder has no private pages yet")?;
    let key = Key::parse(text)
        .ok_or("That is not a valid key. Paste the whole key, starting with aether-key-")?;
    let check = STANDARD
        .decode(&vault.key_check)
        .map_err(|_| "This folder's private pages file is damaged")?;
    if open(&key, KEY_CHECK_AAD, &check).ok().as_deref() != Some(KEY_CHECK) {
        return Err("That key does not match this folder's private pages".to_string());
    }
    store.set(&vault.vault_id, &key.text())?;
    sync_plaintext(root, ignored, &key)
}

pub fn show_key(root: &Path, store: &dyn KeyStore) -> Result<String, String> {
    let vault = read_vault(root)?.ok_or("This folder has no key yet")?;
    store
        .get(&vault.vault_id)?
        .ok_or_else(|| "This device does not have the key. Enter it first".to_string())
}

/// Marks or unmarks note ids as private pages. Marking a page drops the
/// marks of its sub-pages; a sub-page of a private page cannot be unmarked.
pub fn set_private(
    root: &Path,
    ignored: &[String],
    store: &dyn KeyStore,
    ids: &[String],
    private: bool,
) -> Result<(), String> {
    require_repo(root)?;
    if key_for(root, store)?.is_none() {
        return Err("Generate or enter a key first".to_string());
    }
    for id in ids {
        crate::abs_path_from_id(root, id)?;
    }
    let mut local = load(root)?;
    for id in ids.iter().filter(|id| !id.is_empty()) {
        if private {
            if !local.marks.iter().any(|m| m == id || inside(id, m)) {
                local.marks.retain(|m| !inside(m, id));
                local.marks.insert(id.clone());
            }
        } else if local.marks.iter().any(|m| inside(id, m)) {
            return Err("This page is inside a private page".to_string());
        } else {
            local.marks.remove(id);
        }
    }
    save_and_exclude(root, &local, ignored)
}

/// Points marks at the new ids of the pages in `moves`.
pub fn follow_moves(root: &Path, ignored: &[String], moves: &[relink::Move]) -> Result<(), String> {
    let mut local = load(root)?;
    if local.marks.is_empty() {
        return Ok(());
    }
    local.marks = local
        .marks
        .iter()
        .map(|m| crate::moved_id(m, moves))
        .collect();
    save_and_exclude(root, &local, ignored)
}

/// Drops the marks of pages that no longer exist.
pub fn prune_marks(root: &Path, ignored: &[String]) -> Result<(), String> {
    let mut local = load(root)?;
    let before = local.marks.len();
    local
        .marks
        .retain(|m| crate::abs_path_from_id(root, m).is_ok_and(|p| p.is_file()));
    if local.marks.len() == before {
        return Ok(());
    }
    save_and_exclude(root, &local, ignored)
}
