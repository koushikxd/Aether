use crate::agent_git::{self, Action, Outcome, Reply, Request};
use crate::git::{self, GitResult};
use crate::merge::ConflictResolution;
use crate::test_support::{save_text_artifact, TestNotes};
use crate::vault::{self, VaultStatus};
use std::path::Path;
use std::process::Command;
use tauri::async_runtime::block_on;
use tempfile::TempDir;

fn git_out(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git")
}

/// Runs git in `dir` and returns its stdout, panicking when it fails.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_out(dir, args);
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Identity for the commits the app makes, and no signing from the user's config.
fn identify(dir: &Path) {
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
}

fn repo() -> TestNotes {
    let notes = TestNotes::new();
    git(notes.root(), &["init", "-q", "-b", "main"]);
    identify(notes.root());
    notes
}

fn status(notes: &TestNotes) -> VaultStatus {
    block_on(crate::vault_status(notes.state())).expect("vault_status")
}

fn generate(notes: &TestNotes) -> String {
    block_on(crate::vault_generate_key(notes.state())).expect("vault_generate_key")
}

fn enter(notes: &TestNotes, key: &str) -> Result<VaultStatus, String> {
    block_on(crate::vault_enter_key(key.to_string(), notes.state()))
}

fn set_private(notes: &TestNotes, ids: &[&str], private: bool) -> Result<VaultStatus, String> {
    let ids = ids.iter().map(|id| id.to_string()).collect();
    block_on(crate::vault_set_private(ids, private, notes.state()))
}

fn commit(notes: &TestNotes) -> GitResult {
    let result =
        block_on(crate::git_commit("Update".to_string(), notes.state())).expect("git_commit");
    assert!(result.success, "commit failed: {:?}", result.error);
    result
}

fn pull(notes: &TestNotes) -> GitResult {
    block_on(crate::git_pull(notes.state())).expect("git_pull")
}

fn push(notes: &TestNotes) -> GitResult {
    block_on(crate::git_push(notes.state())).expect("git_push")
}

fn changed_count(notes: &TestNotes) -> usize {
    block_on(crate::git_get_status(notes.state()))
        .expect("git_get_status")
        .changed_count
}

fn conflicts(notes: &TestNotes) -> Vec<crate::merge::ConflictFile> {
    block_on(crate::git_conflicts(notes.state())).expect("git_conflicts")
}

fn resolve(notes: &TestNotes, path: &str, resolution: ConflictResolution) {
    block_on(crate::git_resolve_conflict(
        path.to_string(),
        resolution,
        notes.state(),
    ))
    .expect("git_resolve_conflict");
}

/// Paths and text of every file outside `.git`, plus the git log and status,
/// of each clone, saved under `target/test-artifacts/<name>.txt`.
fn artifact(name: &str, clones: &[(&str, &TestNotes)]) {
    let mut dump = String::new();
    for (label, notes) in clones {
        dump.push_str(&format!("##### {label}\n"));
        for rel in notes.tree().iter().filter(|rel| !rel.starts_with(".git/")) {
            let bytes = std::fs::read(notes.root().join(rel)).expect("read file");
            dump.push_str(&format!("=== {rel}\n{}\n", String::from_utf8_lossy(&bytes)));
        }
        let log = git_out(
            notes.root(),
            &["log", "--oneline", "--graph", "--all", "--stat"],
        );
        dump.push_str(&format!(
            "=== git log\n{}\n",
            String::from_utf8_lossy(&log.stdout)
        ));
        let st = git_out(notes.root(), &["status", "--short"]);
        dump.push_str(&format!(
            "=== git status\n{}\n",
            String::from_utf8_lossy(&st.stdout)
        ));
    }
    save_text_artifact(name, &dump);
}

/// Every file under `.aether/vault/` with its bytes.
fn vault_files(notes: &TestNotes) -> Vec<(String, Vec<u8>)> {
    notes
        .tree()
        .into_iter()
        .filter(|rel| rel.starts_with(".aether/vault/"))
        .map(|rel| {
            let bytes = std::fs::read(notes.root().join(&rel)).expect("read blob");
            (rel, bytes)
        })
        .collect()
}

/// Names and content of every file in HEAD's tree.
fn committed_tree(dir: &Path) -> String {
    let mut out = String::new();
    for path in git(dir, &["ls-tree", "-r", "--name-only", "HEAD"]).lines() {
        out.push_str(path);
        out.push('\n');
        let blob = git_out(dir, &["show", &format!("HEAD:{path}")]);
        out.push_str(&String::from_utf8_lossy(&blob.stdout));
        out.push('\n');
    }
    out
}

fn assert_holds_none(haystack: &str, needles: &[&str]) {
    for needle in needles {
        assert!(!haystack.contains(needle), "found {needle:?}");
    }
}

fn finance_notes(notes: &TestNotes) {
    notes.write("Finance.md", "# Finance\n\nsecret-balance-4242\n");
    notes.write(
        "Finance/Bank.md",
        "# Bank\n\nline one\nline two\nline three\n\n![](../assets/card.png)\n",
    );
    notes.write_bytes("assets/card.png", b"\x89PNG card-image-bytes");
    notes.write("Home.md", "# Home\n\nhello\n");
}

// Step 1: vault core

#[test]
fn sealed_content_opens_with_the_same_key() {
    let key = vault::Key::generate();
    let blob = vault::seal(&key, "files/abc", b"secret-balance-4242");

    save_text_artifact(
        "sealed_content_opens_with_the_same_key",
        &format!("{blob:02x?}"),
    );
    assert_eq!(
        vault::open(&key, "files/abc", &blob).expect("open"),
        b"secret-balance-4242"
    );
    assert!(!String::from_utf8_lossy(&blob).contains("secret"));
}

#[test]
fn tampered_swapped_or_foreign_blobs_fail_to_open() {
    let key = vault::Key::generate();
    let blob = vault::seal(&key, "files/abc", b"secret");
    let mut tampered = blob.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;

    save_text_artifact(
        "tampered_swapped_or_foreign_blobs_fail_to_open",
        &format!("blob {blob:02x?}\ntampered {tampered:02x?}"),
    );
    assert!(vault::open(&key, "files/abc", &tampered).is_err());
    assert!(vault::open(&key, "files/xyz", &blob).is_err());
    assert!(vault::open(&vault::Key::generate(), "files/abc", &blob).is_err());
    assert!(vault::open(&key, "files/abc", &blob[..10]).is_err());
}

#[test]
fn wrong_or_malformed_key_is_rejected_by_key_check() {
    let notes = repo();
    let key = generate(&notes);
    let other = repo();
    other.write(
        ".aether/vault/vault.json",
        &notes.read(".aether/vault/vault.json"),
    );
    let wrong = generate(&repo());

    let wrong_result = enter(&other, &wrong);
    let malformed = enter(&other, "aether-key-tooshort");
    let right = enter(&other, &format!("  {key}\n"));

    artifact(
        "wrong_or_malformed_key_is_rejected_by_key_check",
        &[("other", &other)],
    );
    assert_eq!(
        wrong_result.unwrap_err(),
        "That key does not match this folder's private pages"
    );
    assert!(malformed.unwrap_err().contains("not a valid key"));
    assert!(right.expect("right key").unlocked);
}

#[test]
fn unchanged_private_file_keeps_its_blob_byte_identical() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    let first = vault_files(&notes);

    notes.write("Home.md", "# Home\n\nedited\n");
    commit(&notes);
    let second = vault_files(&notes);
    notes.write(
        "Finance/Bank.md",
        "# Bank\n\nchanged\n\n![](../assets/card.png)\n",
    );
    commit(&notes);
    let third = vault_files(&notes);

    artifact(
        "unchanged_private_file_keeps_its_blob_byte_identical",
        &[("notes", &notes)],
    );
    assert_eq!(first, second);
    let changed: Vec<&String> = second
        .iter()
        .zip(&third)
        .filter(|(a, b)| a != b)
        .map(|(a, _)| &a.0)
        .collect();
    assert_eq!(changed.len(), 1, "{changed:?}");
    assert!(changed[0].starts_with(".aether/vault/files/"));
}

#[test]
fn committed_tree_holds_no_private_name_or_content() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    commit(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);

    let tree = committed_tree(notes.root());
    save_text_artifact("committed_tree_holds_no_private_name_or_content", &tree);
    assert_holds_none(
        &tree,
        &["Finance", "Bank", "card", "secret-balance-4242", "line two"],
    );
    assert!(tree.contains("Home.md"));
    assert!(tree.contains(".aether/vault/.gitattributes\n*.enc binary"));
    assert_eq!(git(notes.root(), &["status", "--porcelain"]), "");
    assert_eq!(
        notes.read("Finance.md"),
        "# Finance\n\nsecret-balance-4242\n"
    );
}

// Step 2: privacy rules

#[test]
fn marking_covers_sub_pages_and_drops_redundant_marks() {
    let notes = repo();
    notes.write("Finance.md", "# Finance\n");
    notes.write("Finance/Bank.md", "# Bank\n");
    notes.write("Finance/Bank/2024.md", "# 2024\n");
    notes.write("Home.md", "# Home\n");
    generate(&notes);

    set_private(&notes, &["Finance/Bank"], true).expect("mark child");
    let marked = set_private(&notes, &["Finance"], true).expect("mark parent");
    notes.write("Finance/Later.md", "# Later\n");
    let later = status(&notes);
    let refused = set_private(&notes, &["Finance/Bank"], false);
    let unmarked = set_private(&notes, &["Finance"], false).expect("unmark");

    artifact(
        "marking_covers_sub_pages_and_drops_redundant_marks",
        &[("notes", &notes)],
    );
    assert_eq!(marked.private_roots, ["Finance"]);
    assert_eq!(
        marked.private_note_ids,
        ["Finance", "Finance/Bank", "Finance/Bank/2024"]
    );
    assert!(later
        .private_note_ids
        .contains(&"Finance/Later".to_string()));
    assert_eq!(refused.unwrap_err(), "This page is inside a private page");
    assert!(unmarked.private_roots.is_empty());
    assert!(unmarked.private_note_ids.is_empty());
}

#[test]
fn moving_a_page_in_makes_it_private_and_out_makes_it_public() {
    let notes = repo();
    notes.write("Finance.md", "# Finance\n");
    notes.write("Home.md", "# Home\n");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");

    let moved_in = block_on(crate::move_note(
        "Home".into(),
        "Finance".into(),
        notes.state(),
    ))
    .expect("move in");
    let inside = status(&notes);
    let inside_ignored = git_out(notes.root(), &["check-ignore", "-q", "Finance/Home.md"]);
    block_on(crate::move_note(
        moved_in.clone(),
        String::new(),
        notes.state(),
    ))
    .expect("move out");
    let outside = status(&notes);
    let outside_ignored = git_out(notes.root(), &["check-ignore", "-q", "Home.md"]);

    artifact(
        "moving_a_page_in_makes_it_private_and_out_makes_it_public",
        &[("notes", &notes)],
    );
    assert_eq!(moved_in, "Finance/Home");
    assert_eq!(inside.private_note_ids, ["Finance", "Finance/Home"]);
    assert!(inside_ignored.status.success());
    assert_eq!(outside.private_note_ids, ["Finance"]);
    assert!(!outside_ignored.status.success());
}

#[test]
fn a_marked_page_keeps_its_mark_through_moves_and_renames() {
    let notes = repo();
    notes.write("Finance.md", "# Finance\n");
    notes.write("Finance/Bank.md", "# Bank\n");
    std::fs::create_dir_all(notes.root().join("Archive")).expect("archive");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    let mut roots = Vec::new();

    block_on(crate::move_note(
        "Finance".into(),
        "Archive".into(),
        notes.state(),
    ))
    .expect("move");
    roots.push(status(&notes).private_roots);
    block_on(crate::save_note(
        Some("Archive/Finance".into()),
        "# Money\n".into(),
        notes.state(),
    ))
    .expect("retitle");
    roots.push(status(&notes).private_roots);
    block_on(crate::save_note(
        Some("Archive".into()),
        "# Old\n".into(),
        notes.state(),
    ))
    .expect("retitle the bare parent");
    roots.push(status(&notes).private_roots);
    std::fs::create_dir_all(notes.root().join("Deep")).expect("deep");
    block_on(crate::move_note("Old".into(), "Deep".into(), notes.state()))
        .expect("move the parent");
    let deep = status(&notes);
    let exclude = notes.read(".git/info/exclude");
    block_on(crate::delete_note("Deep/Old/Money".into(), notes.state())).expect("delete");
    let deleted = status(&notes);

    artifact(
        "a_marked_page_keeps_its_mark_through_moves_and_renames",
        &[("notes", &notes)],
    );
    assert_eq!(
        roots,
        [["Archive/Finance"], ["Archive/Money"], ["Old/Money"]]
    );
    assert_eq!(deep.private_roots, ["Deep/Old/Money"]);
    assert_eq!(
        deep.private_note_ids,
        ["Deep/Old/Money", "Deep/Old/Money/Bank"]
    );
    assert!(
        exclude.contains("/Deep/Old/Money.md\n/Deep/Old/Money/\n"),
        "{exclude}"
    );
    assert!(deleted.private_roots.is_empty());
}

#[test]
fn an_asset_is_private_only_when_only_private_pages_use_it() {
    let notes = repo();
    notes.write("Finance.md", "# Finance\n\n![](assets/card.png)\n");
    notes.write("Finance/Bank.md", "# Bank\n\n![](../assets/shared.png)\n");
    notes.write("Home.md", "# Home\n\n![](assets/shared.png)\n");
    notes.write_bytes("assets/card.png", b"card");
    notes.write_bytes("assets/shared.png", b"shared");
    notes.write_bytes("assets/unused.png", b"unused");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    let shared_tree = git(notes.root(), &["ls-tree", "-r", "--name-only", "HEAD"]);

    notes.write("Home.md", "# Home\n");
    commit(&notes);
    let private_tree = git(notes.root(), &["ls-tree", "-r", "--name-only", "HEAD"]);

    artifact(
        "an_asset_is_private_only_when_only_private_pages_use_it",
        &[("notes", &notes)],
    );
    assert!(!shared_tree.contains("assets/card.png"));
    assert!(shared_tree.contains("assets/shared.png"));
    assert!(shared_tree.contains("assets/unused.png"));
    assert!(!private_tree.contains("assets/shared.png"));
    assert!(private_tree.contains("assets/unused.png"));
    assert!(notes.root().join("assets/shared.png").is_file());
}

#[test]
fn exclude_block_lists_exactly_the_private_set() {
    let notes = repo();
    notes.write(".git/info/exclude", "# user line\n*.tmp\n");
    notes.write("Q1 [draft].md", "# Q1 [draft]\n\n![](assets/q.png)\n");
    notes.write("Q1 [draft]/Sub.md", "# Sub\n");
    notes.write("Home.md", "# Home\n");
    notes.write_bytes("assets/q.png", b"q");
    generate(&notes);

    set_private(&notes, &["Q1 [draft]"], true).expect("mark");
    let exclude = notes.read(".git/info/exclude");
    let ignored = |rel: &str| {
        git_out(notes.root(), &["check-ignore", "-q", rel])
            .status
            .success()
    };

    artifact(
        "exclude_block_lists_exactly_the_private_set",
        &[("notes", &notes)],
    );
    assert_eq!(
        exclude,
        "# user line\n*.tmp\n# aether-private-begin\n/Q1 \\[draft].md\n/Q1 \\[draft]/\n/assets/q.png\n# aether-private-end\n"
    );
    assert!(ignored("Q1 [draft].md"));
    assert!(ignored("Q1 [draft]/Sub.md"));
    assert!(ignored("assets/q.png"));
    assert!(!ignored("Home.md"));

    set_private(&notes, &["Q1 [draft]"], false).expect("unmark");
    assert_eq!(notes.read(".git/info/exclude"), "# user line\n*.tmp\n");
}

#[test]
fn making_a_bare_page_private_creates_its_file_first() {
    let notes = repo();
    notes.write("Work/a.md", "# a\n");
    generate(&notes);

    let marked = set_private(&notes, &["Work"], true).expect("mark");

    assert_eq!(notes.read("Work.md"), "# Work\n");
    assert_eq!(marked.private_roots, ["Work"]);
    assert_eq!(marked.private_note_ids, ["Work", "Work/a"]);
}

#[test]
fn page_export_leaves_private_sub_pages_out_unless_asked() {
    let notes = repo();
    finance_notes(&notes);
    notes.write("Finance/Budget.md", "# Budget\n");
    generate(&notes);
    set_private(&notes, &["Finance/Bank"], true).expect("mark");
    let out = TempDir::new().expect("out");
    let names = |include: bool| {
        let dest = out.path().join(format!("{include}.zip"));
        block_on(crate::export_note_zip(
            "Finance".to_string(),
            notes.read("Finance.md"),
            dest.to_string_lossy().into_owned(),
            include,
            notes.state(),
        ))
        .expect("export");
        let archive =
            zip::ZipArchive::new(std::fs::File::open(dest).expect("zip")).expect("read zip");
        let mut names: Vec<String> = archive
            .file_names()
            .map(|n| n.expect("name").into_owned())
            .collect();
        names.sort();
        names
    };

    let without = names(false);
    let with = names(true);

    save_text_artifact(
        "page_export_leaves_private_sub_pages_out_unless_asked",
        &format!("without: {without:?}\nwith: {with:?}"),
    );
    assert_eq!(without, ["Finance.md", "Finance/Budget.md"]);
    assert_eq!(
        with,
        [
            "Finance.md",
            "Finance/Bank.md",
            "Finance/Budget.md",
            "assets/card.png"
        ]
    );
}

#[test]
fn workspace_export_leaves_private_pages_out_unless_asked() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    let out = TempDir::new().expect("out");
    let names = |include: bool| {
        let dest = out.path().join(format!("{include}.zip"));
        block_on(crate::export_folder_zip(
            String::new(),
            dest.to_string_lossy().into_owned(),
            include,
            notes.state(),
        ))
        .expect("export");
        let archive =
            zip::ZipArchive::new(std::fs::File::open(dest).expect("zip")).expect("read zip");
        let mut names: Vec<String> = archive
            .file_names()
            .map(|n| n.expect("name").into_owned())
            .collect();
        names.sort();
        names
    };

    let without = names(false);
    let with = names(true);

    save_text_artifact(
        "workspace_export_leaves_private_pages_out_unless_asked",
        &format!("without: {without:?}\nwith: {with:?}"),
    );
    assert_eq!(without, ["Home.md", "assets/"]);
    assert_eq!(
        with,
        [
            "Finance.md",
            "Finance/",
            "Finance/Bank.md",
            "Home.md",
            "assets/",
            "assets/card.png"
        ]
    );
}

// Step 3: two-clone sync

struct Clones {
    _remote: TempDir,
    remote: std::path::PathBuf,
    a: TestNotes,
    b: TestNotes,
    key: String,
}

/// A marks Finance private, commits and pushes; B clones without the key.
fn clones() -> Clones {
    let remote_dir = TempDir::new().expect("remote");
    let remote = remote_dir.path().join("notes.git");
    git(
        remote_dir.path(),
        &["init", "-q", "--bare", "-b", "main", "notes.git"],
    );
    let a = repo();
    finance_notes(&a);
    let key = generate(&a);
    set_private(&a, &["Finance"], true).expect("mark");
    commit(&a);
    let url = remote.to_string_lossy().into_owned();
    git(a.root(), &["remote", "add", "origin", &url]);
    git(a.root(), &["push", "-q", "-u", "origin", "main"]);
    let b = TestNotes::new();
    git(b.root(), &["clone", "-q", &url, "."]);
    identify(b.root());
    Clones {
        _remote: remote_dir,
        remote,
        a,
        b,
        key,
    }
}

/// `git cat-file --batch-all-objects` of the bare remote: every object's content.
fn remote_objects(remote: &Path) -> String {
    let out = git_out(remote, &["cat-file", "--batch-all-objects", "--batch"]);
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn private_pages_sync_between_clones_only_with_the_key() {
    let c = clones();

    let locked = status(&c.b);
    let locked_tree = c.b.tree();
    let unlocked = enter(&c.b, &c.key).expect("enter key");
    c.a.write(
        "Finance/Bank.md",
        "# Bank\n\nedited on A\n\n![](../assets/card.png)\n",
    );
    commit(&c.a);
    assert!(push(&c.a).success);
    let pulled = pull(&c.b);

    artifact(
        "private_pages_sync_between_clones_only_with_the_key",
        &[("a", &c.a), ("b", &c.b)],
    );
    assert!(locked.has_vault && !locked.unlocked);
    assert_eq!(locked.locked_count, 3);
    assert!(locked.private_note_ids.is_empty());
    assert!(!locked_tree
        .iter()
        .any(|p| p.starts_with("Finance") || p == "assets/card.png"));
    assert_eq!(unlocked.private_roots, ["Finance"]);
    assert_eq!(unlocked.locked_count, 0);
    assert!(pulled.success, "{:?}", pulled.error);
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nsecret-balance-4242\n");
    assert_eq!(
        c.b.read("Finance/Bank.md"),
        "# Bank\n\nedited on A\n\n![](../assets/card.png)\n"
    );
    assert_eq!(
        std::fs::read(c.b.root().join("assets/card.png")).expect("card"),
        b"\x89PNG card-image-bytes"
    );
    assert_eq!(changed_count(&c.b), 0);
    assert_holds_none(
        &remote_objects(&c.remote),
        &[
            "Finance",
            "Bank",
            "card",
            "secret-balance-4242",
            "edited on A",
        ],
    );
}

#[test]
fn unmarking_on_one_clone_makes_the_page_public_on_the_other() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");

    set_private(&c.a, &["Finance"], false).expect("unmark");
    commit(&c.a);
    assert!(push(&c.a).success);
    let pulled = pull(&c.b);

    artifact(
        "unmarking_on_one_clone_makes_the_page_public_on_the_other",
        &[("a", &c.a), ("b", &c.b)],
    );
    assert!(pulled.success, "{:?}", pulled.error);
    assert!(status(&c.b).private_roots.is_empty());
    let tracked = git(c.b.root(), &["ls-files"]);
    assert!(tracked.contains("Finance.md") && tracked.contains("Finance/Bank.md"));
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nsecret-balance-4242\n");
    assert!(!c.b.read(".git/info/exclude").contains("Finance"));
    assert_eq!(changed_count(&c.b), 0);
    assert_eq!(git(c.b.root(), &["status", "--porcelain"]), "");
}

#[test]
fn pull_refuses_while_private_changes_are_uncommitted() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");

    c.b.write("Finance.md", "# Finance\n\nedited on B\n");
    let changed = changed_count(&c.b);
    let pulled = pull(&c.b);

    artifact(
        "pull_refuses_while_private_changes_are_uncommitted",
        &[("b", &c.b)],
    );
    assert_eq!(changed, 1);
    assert!(!pulled.success);
    assert_eq!(
        pulled.error.as_deref(),
        Some("Commit your changes before syncing")
    );
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nedited on B\n");
}

// Step 4: conflicts

/// Both clones edit Finance/Bank.md and Home.md on the same line. A pushes
/// first; B commits and pulls into a conflict.
fn conflicted() -> Clones {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write(
        "Finance/Bank.md",
        "# Bank\n\nline one\nline two from A\nline three\n\n![](../assets/card.png)\n",
    );
    c.a.write("Home.md", "# Home\n\nhello from A\n");
    commit(&c.a);
    assert!(push(&c.a).success);
    c.b.write(
        "Finance/Bank.md",
        "# Bank\n\nline one\nline two from B\nline three\n\n![](../assets/card.png)\n",
    );
    c.b.write("Home.md", "# Home\n\nhello from B\n");
    commit(&c.b);
    c
}

#[test]
fn conflicting_edits_list_both_files_and_resolve_into_a_merge_commit() {
    let c = conflicted();

    let pulled = pull(&c.b);
    let found = conflicts(&c.b);
    resolve(&c.b, "Home.md", ConflictResolution::Theirs);
    let early = block_on(crate::git_finish_merge(c.b.state())).expect("finish");
    let merged_bank =
        "# Bank\n\nline one\nline two from both\nline three\n\n![](../assets/card.png)\n";
    resolve(
        &c.b,
        "Finance/Bank.md",
        ConflictResolution::Text {
            content: merged_bank.to_string(),
        },
    );
    let finished = block_on(crate::git_finish_merge(c.b.state())).expect("finish");
    let pushed = push(&c.b);
    let a_pulled = pull(&c.a);

    artifact(
        "conflicting_edits_list_both_files_and_resolve_into_a_merge_commit",
        &[("a", &c.a), ("b", &c.b)],
    );
    assert!(!pulled.success);
    let summary: Vec<(&str, bool, bool)> = found
        .iter()
        .map(|f| (f.path.as_str(), f.is_private, f.pick_only))
        .collect();
    assert_eq!(
        summary,
        [("Finance/Bank.md", true, false), ("Home.md", false, false)]
    );
    let bank_chunks = serde_json::to_value(&found[0].chunks).expect("json");
    assert_eq!(
        bank_chunks,
        serde_json::json!([
            {"kind": "same", "text": "# Bank\n\nline one\n"},
            {"kind": "conflict", "ours": "line two from B\n", "theirs": "line two from A\n"},
            {"kind": "same", "text": "line three\n\n![](../assets/card.png)\n"},
        ])
    );
    assert!(!early.success);
    assert_eq!(early.error.as_deref(), Some("Resolve every conflict first"));
    assert!(finished.success, "{:?}", finished.error);
    assert!(pushed.success, "{:?}", pushed.error);
    assert!(a_pulled.success, "{:?}", a_pulled.error);
    assert_eq!(c.b.read("Finance/Bank.md"), merged_bank);
    assert_eq!(c.a.read("Finance/Bank.md"), merged_bank);
    assert_eq!(c.a.read("Home.md"), "# Home\n\nhello from A\n");
    assert!(conflicts(&c.b).is_empty());
    assert_eq!(changed_count(&c.b), 0);
    assert_eq!(
        git(c.b.root(), &["rev-list", "--count", "--merges", "HEAD"]),
        "1\n"
    );
    assert_holds_none(
        &remote_objects(&c.remote),
        &["line two from", "secret-balance-4242"],
    );
}

#[test]
fn abort_merge_restores_the_state_before_the_pull() {
    let c = conflicted();
    let head = git(c.b.root(), &["rev-parse", "HEAD"]);
    let bank = c.b.read("Finance/Bank.md");

    let pulled = pull(&c.b);
    let aborted = block_on(crate::git_abort_merge(c.b.state())).expect("abort");

    artifact(
        "abort_merge_restores_the_state_before_the_pull",
        &[("b", &c.b)],
    );
    assert!(!pulled.success);
    assert!(aborted.success, "{:?}", aborted.error);
    assert_eq!(git(c.b.root(), &["rev-parse", "HEAD"]), head);
    assert_eq!(c.b.read("Finance/Bank.md"), bank);
    assert_eq!(c.b.read("Home.md"), "# Home\n\nhello from B\n");
    assert!(conflicts(&c.b).is_empty());
    assert_eq!(changed_count(&c.b), 0);
    assert_eq!(git(c.b.root(), &["status", "--porcelain"]), "");
}

#[test]
fn the_same_new_private_page_on_both_clones_is_a_conflict() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write("Finance/New.md", "# New\n\nfrom A\n");
    commit(&c.a);
    assert!(push(&c.a).success);
    c.b.write("Finance/New.md", "# New\n\nfrom B\n");
    commit(&c.b);

    let pulled = pull(&c.b);
    let found = conflicts(&c.b);
    resolve(&c.b, "Finance/New.md", ConflictResolution::Ours);
    let finished = block_on(crate::git_finish_merge(c.b.state())).expect("finish");
    assert!(push(&c.b).success);
    let a_pulled = pull(&c.a);

    artifact(
        "the_same_new_private_page_on_both_clones_is_a_conflict",
        &[("a", &c.a), ("b", &c.b)],
    );
    assert!(!pulled.success);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].path, "Finance/New.md");
    assert!(found[0].is_private);
    assert!(finished.success, "{:?}", finished.error);
    assert!(a_pulled.success, "{:?}", a_pulled.error);
    assert_eq!(c.a.read("Finance/New.md"), "# New\n\nfrom B\n");
    let blobs = |n: &TestNotes| {
        n.tree()
            .iter()
            .filter(|p| p.starts_with(".aether/vault/files/"))
            .count()
    };
    assert_eq!(blobs(&c.a), 4);
    assert_eq!(changed_count(&c.a), 0);
}

// Step 5: key commands

#[test]
fn key_commands_generate_show_and_enter() {
    let notes = TestNotes::new();
    notes.write("Home.md", "# Home\n");
    let before = status(&notes);
    let no_key = block_on(crate::vault_set_private(
        vec!["Home".into()],
        true,
        notes.state(),
    ));

    let key = generate(&notes);
    let shown = block_on(crate::vault_show_key(notes.state())).expect("show");
    let again = block_on(crate::vault_generate_key(notes.state()));
    let after = status(&notes);

    artifact("key_commands_generate_show_and_enter", &[("notes", &notes)]);
    assert!(!before.has_vault && !before.unlocked);
    assert!(no_key.is_err());
    assert!(notes.root().join(".git").is_dir());
    assert!(key.starts_with("aether-key-"));
    assert_eq!(key.len(), "aether-key-".len() + 43);
    assert_eq!(shown, key);
    assert_eq!(again.unwrap_err(), "This folder already has a key");
    assert!(after.has_vault && after.unlocked);
    assert_eq!(notes.read(".aether/vault/.gitattributes"), "*.enc binary\n");
    let vault_json: serde_json::Value =
        serde_json::from_str(&notes.read(".aether/vault/vault.json")).expect("vault.json");
    assert_eq!(vault_json["version"], 1);
    assert!(vault_json["vaultId"].is_string() && vault_json["keyCheck"].is_string());
}

// Leaks outside the private files

fn pin(notes: &TestNotes, ids: &[&str]) {
    let settings = crate::Settings {
        pinned_note_ids: Some(ids.iter().map(|id| id.to_string()).collect()),
        ..crate::Settings::default()
    };
    crate::update_settings(settings, notes.state()).expect("update_settings");
}

#[test]
fn pins_of_private_pages_stay_out_of_the_committed_settings() {
    let notes = repo();
    finance_notes(&notes);
    notes.write("Plans.md", "# Plans\n");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    pin(&notes, &["Home", "Finance/Bank", "Plans"]);
    let after_pin = notes.read(".aether/settings.json");
    set_private(&notes, &["Plans"], true).expect("mark plans");
    let after_mark = notes.read(".aether/settings.json");
    commit(&notes);
    let tree = committed_tree(notes.root());
    let reloaded = crate::load_settings(&notes.root().to_string_lossy());
    set_private(&notes, &["Plans"], false).expect("unmark plans");
    let after_unmark = notes.read(".aether/settings.json");

    save_text_artifact(
        "pins_of_private_pages_stay_out_of_the_committed_settings",
        &format!(
            "after pin\n{after_pin}\nafter mark\n{after_mark}\nafter unmark\n{after_unmark}\ntree\n{tree}"
        ),
    );
    assert!(!after_pin.contains("Bank") && after_pin.contains("Plans"));
    assert!(!after_mark.contains("Plans") && after_mark.contains("Home"));
    assert_holds_none(&tree, &["Bank", "Plans"]);
    let mut pins = reloaded.pinned_note_ids.expect("pins");
    pins.sort();
    assert_eq!(pins, ["Finance/Bank", "Home", "Plans"]);
    assert!(after_unmark.contains("Plans") && !after_unmark.contains("Bank"));
}

#[test]
fn commit_refuses_while_a_public_page_links_to_a_private_page() {
    let notes = repo();
    finance_notes(&notes);
    notes.write("Home.md", "# Home\n\n[Bank](Finance/Bank.md)\n");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    let refused =
        block_on(crate::git_commit("Update".to_string(), notes.state())).expect("git_commit");
    let log = git_out(notes.root(), &["log", "--oneline"]);
    notes.write("Home.md", "# Home\n\nsee [[bank]]\n");
    let wikilink =
        block_on(crate::git_commit("Update".to_string(), notes.state())).expect("git_commit");
    notes.write("Home.md", "# Home\n\nhello\n");
    commit(&notes);
    let tree = committed_tree(notes.root());

    artifact(
        "commit_refuses_while_a_public_page_links_to_a_private_page",
        &[("notes", &notes)],
    );
    assert!(!refused.success);
    assert!(refused.error.expect("error").contains("Home"));
    assert!(log.stdout.is_empty(), "a commit was made");
    assert!(
        !wikilink.success,
        "a wikilink to a private page was committed"
    );
    assert_holds_none(&tree, &["Bank", "secret-balance-4242"]);
}

#[test]
fn saving_a_private_page_keeps_its_new_asset_out_of_git_at_once() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    notes.write_bytes("assets/new.png", b"new-image-bytes");
    block_on(crate::save_note(
        Some("Finance/Bank".to_string()),
        "# Bank\n\n![](../assets/new.png)\n".to_string(),
        notes.state(),
    ))
    .expect("save_note");
    // What a commit from the terminal would take.
    git(notes.root(), &["add", "-A"]);
    let staged = git(notes.root(), &["ls-files"]);

    artifact(
        "saving_a_private_page_keeps_its_new_asset_out_of_git_at_once",
        &[("notes", &notes)],
    );
    assert_holds_none(&staged, &["new.png"]);
}

#[test]
fn marking_untracks_a_page_at_once() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    commit(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    notes.write("Finance.md", "# Finance\n\nnew-secret-after-marking\n");
    // A commit from the terminal, which skips Aether's commit.
    git(notes.root(), &["add", "-A"]);
    git(notes.root(), &["commit", "-q", "-m", "terminal"]);
    let tree = committed_tree(notes.root());

    artifact("marking_untracks_a_page_at_once", &[("notes", &notes)]);
    assert_holds_none(&tree, &["new-secret-after-marking", "Finance.md"]);
}

#[test]
fn a_private_asset_stays_private_through_moves_and_lost_links() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    notes.write("Finance.md", "# Finance\n\n![](assets/card.png)\n");
    notes.write("Finance/Bank.md", "# Bank\n");
    commit(&notes);
    notes.write("Archive.md", "# Archive\n");
    block_on(crate::move_note(
        "Finance".to_string(),
        "Archive".to_string(),
        notes.state(),
    ))
    .expect("move_note");
    let exclude_after_move = notes.read(".git/info/exclude");
    commit(&notes);
    notes.write("Archive/Finance.md", "# Finance\n");
    commit(&notes);
    let tree = committed_tree(notes.root());

    artifact(
        "a_private_asset_stays_private_through_moves_and_lost_links",
        &[("notes", &notes)],
    );
    assert!(
        exclude_after_move.contains("/assets/card.png"),
        "{exclude_after_move}"
    );
    assert_holds_none(&tree, &["card", "secret-balance-4242"]);
}

#[test]
fn a_damaged_blob_leaves_no_plaintext_behind() {
    let c = clones();
    let blobs: Vec<String> =
        c.b.tree()
            .into_iter()
            .filter(|p| p.starts_with(".aether/vault/files/"))
            .collect();
    let last = blobs.last().expect("a blob");
    let mut bytes = std::fs::read(c.b.root().join(last)).expect("read blob");
    let end = bytes.len() - 1;
    bytes[end] ^= 1;
    c.b.write_bytes(last, &bytes);

    let entered = enter(&c.b, &c.key);

    artifact("a_damaged_blob_leaves_no_plaintext_behind", &[("b", &c.b)]);
    assert!(entered.is_err());
    assert!(!c
        .b
        .tree()
        .iter()
        .any(|p| p.starts_with("Finance") || p == "assets/card.png"));
}

#[test]
fn a_blob_whose_page_lost_its_mark_stays_private() {
    let c = clones();
    // As a merge can leave it: the root blob is gone, the file blobs remain.
    for p in c.a.tree() {
        if p.starts_with(".aether/vault/roots/") {
            std::fs::remove_file(c.a.root().join(&p)).expect("remove root blob");
        }
    }
    git(c.a.root(), &["add", "-A"]);
    git(c.a.root(), &["commit", "-q", "-m", "terminal"]);
    git(c.a.root(), &["push", "-q"]);
    git(c.b.root(), &["pull", "-q"]);

    enter(&c.b, &c.key).expect("enter key");
    let st = git(
        c.b.root(),
        &["status", "--porcelain", "--untracked-files=all"],
    );

    artifact(
        "a_blob_whose_page_lost_its_mark_stays_private",
        &[("b", &c.b)],
    );
    assert!(c.b.root().join("Finance.md").is_file());
    assert_holds_none(&st, &["Finance", "card"]);
}

#[test]
fn a_terminal_pull_over_a_local_edit_keeps_both_versions() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write("Finance.md", "# Finance\n\nedited on A\n");
    commit(&c.a);
    assert!(push(&c.a).success);
    c.b.write("Finance.md", "# Finance\n\nedited on B\n");
    git(c.b.root(), &["pull", "-q"]);

    let state = c.b.state();
    vault::decrypt(c.b.root(), &[], state.key_store.as_ref()).expect("decrypt");
    let merged = c.b.read("Finance.md");

    artifact(
        "a_terminal_pull_over_a_local_edit_keeps_both_versions",
        &[("b", &c.b)],
    );
    assert!(
        merged.contains("edited on A") && merged.contains("edited on B"),
        "{merged}"
    );
}

#[test]
fn a_merge_never_commits_a_page_this_clone_made_private() {
    let remote_dir = TempDir::new().expect("remote");
    let url = remote_dir
        .path()
        .join("notes.git")
        .to_string_lossy()
        .into_owned();
    git(
        remote_dir.path(),
        &["init", "-q", "--bare", "-b", "main", "notes.git"],
    );
    let a = repo();
    finance_notes(&a);
    let key = generate(&a);
    commit(&a);
    git(a.root(), &["remote", "add", "origin", &url]);
    git(a.root(), &["push", "-q", "-u", "origin", "main"]);
    let b = TestNotes::new();
    git(b.root(), &["clone", "-q", &url, "."]);
    identify(b.root());
    b.write("Finance.md", "# Finance\n\nedited on B\n");
    commit(&b);
    assert!(push(&b).success);
    set_private(&a, &["Finance"], true).expect("mark");
    commit(&a);

    let pulled = pull(&a);
    resolve(&a, "Finance.md", ConflictResolution::Theirs);
    let finished = block_on(crate::git_finish_merge(a.state())).expect("finish");
    let tracked = git(a.root(), &["ls-files"]);
    let tree = committed_tree(a.root());
    assert!(push(&a).success);
    assert!(pull(&b).success);
    enter(&b, &key).expect("enter key");

    artifact(
        "a_merge_never_commits_a_page_this_clone_made_private",
        &[("a", &a), ("b", &b)],
    );
    assert!(!pulled.success);
    assert!(finished.success, "{:?}", finished.error);
    assert!(!tracked.contains("Finance.md"), "{tracked}");
    assert!(!tree.contains("Finance.md"));
    assert_eq!(b.read("Finance.md"), "# Finance\n\nedited on B\n");
}

#[test]
fn a_pull_of_a_blob_rewritten_to_the_same_text_keeps_the_page() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write("Finance.md", "# Finance\n\nbriefly edited\n");
    commit(&c.a);
    c.a.write("Finance.md", "# Finance\n\nsecret-balance-4242\n");
    commit(&c.a);
    assert!(push(&c.a).success);

    let pulled = pull(&c.b);

    artifact(
        "a_pull_of_a_blob_rewritten_to_the_same_text_keeps_the_page",
        &[("b", &c.b)],
    );
    assert!(pulled.success, "{:?}", pulled.error);
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nsecret-balance-4242\n");
    assert_eq!(changed_count(&c.b), 0);
}

#[test]
fn a_private_asset_stays_private_after_its_last_page_is_deleted() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    for id in ["Finance/Bank", "Finance"] {
        block_on(crate::delete_note(id.to_string(), notes.state())).expect("delete_note");
    }
    git(notes.root(), &["add", "-A"]);
    let tracked = git(notes.root(), &["ls-files"]);

    artifact(
        "a_private_asset_stays_private_after_its_last_page_is_deleted",
        &[("notes", &notes)],
    );
    assert!(!tracked.contains("card"), "{tracked}");
}

#[test]
fn a_clean_merge_keeps_private_pages_and_marks_from_the_other_clone() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.b.write("Home/New.md", "# New\n\nwritten-on-b\n");
    commit(&c.b);
    set_private(&c.a, &["Home"], true).expect("mark");
    commit(&c.a);
    assert!(push(&c.a).success);

    let pulled = pull(&c.b);
    let tree = committed_tree(c.b.root());
    let blobs = git(c.b.root(), &["ls-tree", "-r", "--name-only", "HEAD"]);

    artifact(
        "a_clean_merge_keeps_private_pages_and_marks_from_the_other_clone",
        &[("b", &c.b)],
    );
    assert!(pulled.success, "{:?}", pulled.error);
    assert_holds_none(&tree, &["written-on-b", "Home/New.md"]);
    assert_eq!(blobs.matches(".aether/vault/files/").count(), 5, "{blobs}");
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nsecret-balance-4242\n");
    assert_eq!(changed_count(&c.b), 0);
}

#[test]
fn a_gitignore_negation_cannot_put_a_private_page_in_a_commit() {
    let notes = repo();
    finance_notes(&notes);
    notes.write(".gitignore", "!*.md\n!*.png\n");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    let tree = committed_tree(notes.root());

    artifact(
        "a_gitignore_negation_cannot_put_a_private_page_in_a_commit",
        &[("notes", &notes)],
    );
    assert_holds_none(&tree, &["Finance", "secret-balance-4242", "card"]);
}

#[test]
fn a_failed_write_leaves_the_written_plaintext_excluded() {
    let c = clones();
    std::fs::create_dir_all(c.b.root().join("Finance/Bank.md/blocked")).expect("block");

    let entered = enter(&c.b, &c.key);
    let exclude = c.b.read(".git/info/exclude");

    artifact(
        "a_failed_write_leaves_the_written_plaintext_excluded",
        &[("b", &c.b)],
    );
    assert!(entered.is_err());
    assert!(exclude.contains("/Finance.md"), "{exclude}");
    assert!(exclude.contains("/assets/card.png"), "{exclude}");
}

#[test]
fn a_failed_write_keeps_stashed_assets_excluded() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write("Finance.md", "# Finance\n\nedited on A\n");
    commit(&c.a);
    assert!(push(&c.a).success);
    git(c.b.root(), &["pull", "-q"]);
    // As a pull leaves it mid-way: the asset is stashed, and a note write fails.
    let stashed = c.b.root().join(".git/aether-stash/assets");
    std::fs::create_dir_all(&stashed).expect("stash dir");
    std::fs::rename(c.b.root().join("assets/card.png"), stashed.join("card.png"))
        .expect("stash card");
    std::fs::remove_file(c.b.root().join("Finance.md")).expect("remove");
    std::fs::create_dir_all(c.b.root().join("Finance.md/blocked")).expect("block");

    let state = c.b.state();
    let decrypted = vault::decrypt(c.b.root(), &[], state.key_store.as_ref());
    let exclude = c.b.read(".git/info/exclude");

    artifact(
        "a_failed_write_keeps_stashed_assets_excluded",
        &[("b", &c.b)],
    );
    assert!(decrypted.is_err());
    assert!(exclude.contains("/assets/card.png"), "{exclude}");
}

#[test]
fn a_merge_that_makes_an_asset_public_commits_its_public_copy() {
    let c = clones();
    c.a.write("Other.md", "# Other\n");
    commit(&c.a);
    c.b.write("Home.md", "# Home\n\n![](assets/card.png)\n");
    commit(&c.b);
    assert!(push(&c.b).success);

    let pulled = pull(&c.a);
    let tracked = git(c.a.root(), &["ls-tree", "-r", "--name-only", "HEAD"]);

    artifact(
        "a_merge_that_makes_an_asset_public_commits_its_public_copy",
        &[("a", &c.a)],
    );
    assert!(pulled.success, "{:?}", pulled.error);
    assert!(tracked.contains("assets/card.png"), "{tracked}");
    assert_eq!(
        std::fs::read(c.a.root().join("assets/card.png")).expect("card"),
        b"\x89PNG card-image-bytes"
    );
}

#[test]
fn a_resolution_that_makes_an_asset_public_commits_its_public_copy() {
    let c = conflicted();
    pull(&c.b);
    resolve(&c.b, "Finance/Bank.md", ConflictResolution::Ours);
    resolve(
        &c.b,
        "Home.md",
        ConflictResolution::Text {
            content: "# Home\n\n![](assets/card.png)\n".to_string(),
        },
    );

    let finished = block_on(crate::git_finish_merge(c.b.state())).expect("finish");
    let tracked = git(c.b.root(), &["ls-tree", "-r", "--name-only", "HEAD"]);

    artifact(
        "a_resolution_that_makes_an_asset_public_commits_its_public_copy",
        &[("b", &c.b)],
    );
    assert!(finished.success, "{:?}", finished.error);
    assert!(tracked.contains("assets/card.png"), "{tracked}");
}

#[test]
fn a_merge_retried_after_a_failed_stage_keeps_one_blob_per_file() {
    let c = conflicted();
    pull(&c.b);
    resolve(&c.b, "Finance/Bank.md", ConflictResolution::Ours);
    resolve(
        &c.b,
        "Home.md",
        ConflictResolution::Text {
            content: "# Home\n\n![](assets/card.png)\n".to_string(),
        },
    );
    c.b.write("Finance/New.md", "# New\n");
    let lock = c.b.root().join(".git/index.lock");
    std::fs::write(&lock, "").expect("lock index");
    let locked = block_on(crate::git_finish_merge(c.b.state()));
    std::fs::remove_file(&lock).expect("unlock index");

    let finished = block_on(crate::git_finish_merge(c.b.state())).expect("finish");
    let tracked = git(c.b.root(), &["ls-tree", "-r", "--name-only", "HEAD"]);

    artifact(
        "a_merge_retried_after_a_failed_stage_keeps_one_blob_per_file",
        &[("b", &c.b)],
    );
    assert!(!locked.is_ok_and(|r| r.success));
    assert!(finished.success, "{:?}", finished.error);
    assert!(tracked.contains("assets/card.png"), "{tracked}");
    assert_eq!(
        tracked.matches(".aether/vault/files/").count(),
        3,
        "{tracked}"
    );
}

// Commits from outside the app

/// Finance private and committed by the app, as a terminal commit finds it.
fn private_finance() -> TestNotes {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);
    notes
}

fn assert_refused(out: &std::process::Output, paths: &[&str]) {
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "commit went through: {stderr}");
    for path in paths {
        assert!(stderr.contains(path), "{path} not named: {stderr}");
    }
    assert!(stderr.contains("Aether app"), "{stderr}");
}

#[test]
fn a_terminal_commit_of_a_force_added_private_page_is_refused() {
    let notes = private_finance();
    git(
        notes.root(),
        &["add", "-f", "Finance.md", "Finance/Bank.md"],
    );

    let out = git_out(notes.root(), &["commit", "-m", "x"]);
    let tree = committed_tree(notes.root());

    artifact(
        "a_terminal_commit_of_a_force_added_private_page_is_refused",
        &[("notes", &notes)],
    );
    assert_refused(&out, &["Finance.md", "Finance/Bank.md"]);
    assert_holds_none(&tree, &["secret-balance-4242", "line two"]);
}

#[test]
fn a_terminal_commit_through_a_gitignore_negation_is_refused() {
    let notes = private_finance();
    notes.write(".gitignore", "!*.md\n!*.png\n");
    git(notes.root(), &["add", "-A"]);

    let out = git_out(notes.root(), &["commit", "-m", "x"]);
    let tree = committed_tree(notes.root());

    artifact(
        "a_terminal_commit_through_a_gitignore_negation_is_refused",
        &[("notes", &notes)],
    );
    assert_refused(&out, &["Finance.md", "assets/card.png"]);
    assert_holds_none(&tree, &["secret-balance-4242", "card-image"]);
}

#[test]
fn a_terminal_commit_of_public_changes_goes_through() {
    let notes = private_finance();
    notes.write("Home.md", "# Home\n\nedited in a terminal\n");
    git(notes.root(), &["add", "-A"]);

    let out = git_out(notes.root(), &["commit", "-m", "x"]);
    let tree = committed_tree(notes.root());

    artifact(
        "a_terminal_commit_of_public_changes_goes_through",
        &[("notes", &notes)],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(tree.contains("edited in a terminal"), "{tree}");
    assert_holds_none(&tree, &["secret-balance-4242"]);
}

#[test]
fn a_pre_commit_hook_of_the_user_is_kept() {
    let notes = repo();
    finance_notes(&notes);
    notes.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    generate(&notes);

    set_private(&notes, &["Finance"], true).expect("mark");
    commit(&notes);

    artifact(
        "a_pre_commit_hook_of_the_user_is_kept",
        &[("notes", &notes)],
    );
    assert_eq!(notes.read(".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
}

#[test]
fn a_terminal_merge_that_brings_a_private_sub_page_is_refused() {
    let remote_dir = TempDir::new().expect("remote");
    let url = remote_dir
        .path()
        .join("notes.git")
        .to_string_lossy()
        .into_owned();
    git(
        remote_dir.path(),
        &["init", "-q", "--bare", "-b", "main", "notes.git"],
    );
    let a = repo();
    finance_notes(&a);
    generate(&a);
    commit(&a);
    git(a.root(), &["remote", "add", "origin", &url]);
    git(a.root(), &["push", "-q", "-u", "origin", "main"]);
    let b = TestNotes::new();
    git(b.root(), &["clone", "-q", &url, "."]);
    identify(b.root());
    b.write("Finance/New.md", "# New\n\nnew-on-b\n");
    commit(&b);
    assert!(push(&b).success);
    set_private(&a, &["Finance"], true).expect("mark");
    commit(&a);

    git(a.root(), &["fetch", "-q"]);
    let out = git_out(a.root(), &["merge", "--no-edit", "origin/main"]);
    let tree = committed_tree(a.root());

    artifact(
        "a_terminal_merge_that_brings_a_private_sub_page_is_refused",
        &[("a", &a)],
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "merge went through");
    assert!(stderr.contains("Finance/New.md"), "{stderr}");
    assert_holds_none(&tree, &["new-on-b"]);
}

// Agent requests (agent_git)

fn agent(notes: &TestNotes, action: Action, message: Option<&str>) -> Reply {
    let request = Request {
        folder: notes.root().to_path_buf(),
        action,
        message: message.map(str::to_string),
    };
    let ignored = crate::notes::ignored_dirs(notes.root());
    agent_git::handle(
        &request,
        Some(notes.root()),
        &ignored,
        notes.state().key_store.as_ref(),
    )
}

fn assert_ok(reply: &Reply) {
    assert_eq!(reply.outcome, Outcome::Ok, "{reply:?}");
}

fn conflict_pages(reply: &Reply) -> Vec<&str> {
    reply
        .conflicts
        .iter()
        .map(|c| c.page.as_deref().unwrap_or(&c.path))
        .collect()
}

#[test]
fn an_agent_commit_encrypts_private_pages_and_passes_the_hook() {
    let notes = repo();
    finance_notes(&notes);
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");

    let committed = agent(&notes, Action::Commit, None);
    let stat = git(notes.root(), &["show", "--stat", "--format=%s", "HEAD"]);
    let tree = committed_tree(notes.root());

    artifact(
        "an_agent_commit_encrypts_private_pages_and_passes_the_hook",
        &[("notes", &notes)],
    );
    assert_ok(&committed);
    assert!(notes.root().join(".git/hooks/pre-commit").is_file());
    assert!(stat.starts_with("Quick commit from Aether\n"), "{stat}");
    assert!(stat.contains(".aether/vault/files/"), "{stat}");
    assert!(stat.contains("Home.md"), "{stat}");
    assert_holds_none(&stat, &["Finance", "Bank", "card.png"]);
    assert_holds_none(&tree, &["secret-balance-4242", "line two"]);

    notes.write("Home.md", "# Home\n\nagain\n");
    assert_ok(&agent(&notes, Action::Commit, Some("Agent message")));
    assert_eq!(
        git(notes.root(), &["log", "-1", "--format=%s"]),
        "Agent message\n"
    );
}

#[test]
fn an_agent_commit_of_a_link_to_a_private_page_is_refused_without_naming_it() {
    let notes = repo();
    finance_notes(&notes);
    notes.write("Home.md", "# Home\n\n[Bank](Finance/Bank.md)\n");
    generate(&notes);
    set_private(&notes, &["Finance"], true).expect("mark");

    let refused = agent(&notes, Action::Commit, None);

    artifact(
        "an_agent_commit_of_a_link_to_a_private_page_is_refused_without_naming_it",
        &[("notes", &notes)],
    );
    assert_eq!(refused.outcome, Outcome::Error, "{refused:?}");
    assert!(refused.message.contains("Home"), "{}", refused.message);
    assert_holds_none(&refused.message, &["Finance", "Bank"]);
    assert!(git_out(notes.root(), &["log"]).stdout.is_empty());
}

#[test]
fn an_agent_sync_carries_changes_between_clones_and_refuses_uncommitted_private_edits() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write(
        "Finance/Bank.md",
        "# Bank\n\nedited on A\n\n![](../assets/card.png)\n",
    );
    c.a.write("Home.md", "# Home\n\nhello from A\n");

    let a_committed = agent(&c.a, Action::Commit, None);
    let a_synced = agent(&c.a, Action::Sync, None);
    let b_synced = agent(&c.b, Action::Sync, None);
    c.b.write("Finance.md", "# Finance\n\nedited on B\n");
    let refused = agent(&c.b, Action::Sync, None);

    artifact(
        "an_agent_sync_carries_changes_between_clones_and_refuses_uncommitted_private_edits",
        &[("a", &c.a), ("b", &c.b)],
    );
    assert_ok(&a_committed);
    assert_ok(&a_synced);
    assert_ok(&b_synced);
    assert_eq!(c.b.read("Home.md"), "# Home\n\nhello from A\n");
    assert_eq!(
        c.b.read("Finance/Bank.md"),
        "# Bank\n\nedited on A\n\n![](../assets/card.png)\n"
    );
    assert_eq!(refused.outcome, Outcome::Error, "{refused:?}");
    assert!(refused.message.contains("Commit"), "{}", refused.message);
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nedited on B\n");
    assert_holds_none(
        &remote_objects(&c.remote),
        &["secret-balance-4242", "edited on A"],
    );
}

/// Both clones edit Home.md on the same line. A syncs first; B commits.
fn public_conflict() -> Clones {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write("Home.md", "# Home\n\nhello from A\n");
    assert_ok(&agent(&c.a, Action::Commit, None));
    assert_ok(&agent(&c.a, Action::Sync, None));
    c.b.write("Home.md", "# Home\n\nhello from B\n");
    assert_ok(&agent(&c.b, Action::Commit, None));
    c
}

#[test]
fn public_conflicts_are_listed_and_continue_waits_for_the_markers_to_go() {
    let c = public_conflict();

    let synced = agent(&c.b, Action::Sync, None);
    let marked = c.b.read("Home.md");
    let early = agent(&c.b, Action::SyncContinue, None);
    let mid_merge_commit = agent(&c.b, Action::Commit, None);
    let still_merging = git::merge_in_progress(c.b.root());
    c.b.write("Home.md", "# Home\n\n```\n<<<<<<< HEAD\nhello\n```\n");
    let fenced = agent(&c.b, Action::SyncContinue, None);
    c.b.write(
        "Home.md",
        "# Home\n\n<<<<<<<<<<<< HEAD\nhello\n>>>>>>>>>>>> theirs\n",
    );
    let wide = agent(&c.b, Action::SyncContinue, None);
    c.b.write("Home.md", "# Home\n\nhello from both\n");
    let finished = agent(&c.b, Action::SyncContinue, None);
    let a_synced = agent(&c.a, Action::Sync, None);

    artifact(
        "public_conflicts_are_listed_and_continue_waits_for_the_markers_to_go",
        &[("a", &c.a), ("b", &c.b)],
    );
    assert_eq!(synced.outcome, Outcome::Conflicts, "{synced:?}");
    assert_eq!(conflict_pages(&synced), ["Home"]);
    assert_eq!(synced.private_conflicts, 0);
    assert!(marked.contains("<<<<<<<"), "{marked}");
    assert_eq!(early.outcome, Outcome::Conflicts, "{early:?}");
    assert_eq!(conflict_pages(&early), ["Home"]);
    assert_eq!(
        mid_merge_commit.outcome,
        Outcome::Error,
        "{mid_merge_commit:?}"
    );
    assert!(
        mid_merge_commit.message.contains("sync --continue"),
        "{}",
        mid_merge_commit.message
    );
    assert!(still_merging);
    assert_eq!(fenced.outcome, Outcome::Conflicts, "{fenced:?}");
    assert_eq!(wide.outcome, Outcome::Conflicts, "{wide:?}");
    assert_ok(&finished);
    assert!(!git::merge_in_progress(c.b.root()));
    assert_eq!(
        git(c.b.root(), &["rev-parse", "HEAD"]),
        git(&c.remote, &["rev-parse", "main"])
    );
    assert_ok(&a_synced);
    assert_eq!(c.a.read("Home.md"), "# Home\n\nhello from both\n");
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nsecret-balance-4242\n");
}

#[test]
fn continue_commits_each_conflicted_file_as_the_agent_left_it() {
    let c = clones();
    enter(&c.b, &c.key).expect("enter key");
    c.a.write_bytes("data.bin", &[0xff, 0]);
    c.a.write("notes.txt", "base\n");
    assert_ok(&agent(&c.a, Action::Commit, None));
    assert_ok(&agent(&c.a, Action::Sync, None));
    assert_ok(&agent(&c.b, Action::Sync, None));
    c.a.write_bytes("data.bin", &[0xff, 1]);
    c.a.write("notes.txt", "from A\n");
    assert_ok(&agent(&c.a, Action::Commit, None));
    assert_ok(&agent(&c.a, Action::Sync, None));
    c.b.write_bytes("data.bin", &[0xff, 2]);
    c.b.write("notes.txt", "from B\n");
    assert_ok(&agent(&c.b, Action::Commit, None));

    let synced = agent(&c.b, Action::Sync, None);
    c.b.write_bytes("data.bin", &[0xff, 3]);
    std::fs::remove_file(c.b.root().join("notes.txt")).expect("remove");
    let finished = agent(&c.b, Action::SyncContinue, None);

    artifact(
        "continue_commits_each_conflicted_file_as_the_agent_left_it",
        &[("b", &c.b)],
    );
    assert_eq!(conflict_pages(&synced), ["data.bin", "notes.txt"]);
    assert_ok(&finished);
    let data = git_out(c.b.root(), &["show", "HEAD:data.bin"]).stdout;
    assert_eq!(data, [0xff, 3]);
    assert!(!git_out(c.b.root(), &["cat-file", "-e", "HEAD:notes.txt"])
        .status
        .success());
}

#[test]
fn continue_refuses_while_a_conflicted_page_is_away_from_its_path() {
    let c = public_conflict();
    assert_eq!(agent(&c.b, Action::Sync, None).outcome, Outcome::Conflicts);
    std::fs::remove_file(c.b.root().join("Home.md")).expect("remove");
    c.b.write("Hello.md", "# Hello\n\nhello from both\n");

    let renamed = agent(&c.b, Action::SyncContinue, None);
    let still_merging = git::merge_in_progress(c.b.root());
    std::fs::remove_file(c.b.root().join("Hello.md")).expect("remove");
    c.b.write("Home.md", "# Home\n\nhello from both\n");
    let finished = agent(&c.b, Action::SyncContinue, None);

    artifact(
        "continue_refuses_while_a_conflicted_page_is_away_from_its_path",
        &[("b", &c.b)],
    );
    assert_eq!(renamed.outcome, Outcome::Error, "{renamed:?}");
    assert!(renamed.message.contains("Home.md"), "{}", renamed.message);
    assert!(still_merging);
    assert_ok(&finished);
}

#[test]
fn continue_refuses_while_a_conflicted_page_is_renamed_only_in_case() {
    let c = public_conflict();
    assert_eq!(agent(&c.b, Action::Sync, None).outcome, Outcome::Conflicts);
    c.b.write("Home.md", "# Home\n\nhello from both\n");
    let (spelled, lower, temp) = (
        c.b.root().join("Home.md"),
        c.b.root().join("home.md"),
        c.b.root().join("temp.md"),
    );
    std::fs::rename(&spelled, &temp).expect("rename");
    std::fs::rename(&temp, &lower).expect("rename");

    let renamed = agent(&c.b, Action::SyncContinue, None);
    let still_merging = git::merge_in_progress(c.b.root());
    std::fs::rename(&lower, &temp).expect("rename");
    std::fs::rename(&temp, &spelled).expect("rename");
    let finished = agent(&c.b, Action::SyncContinue, None);

    artifact(
        "continue_refuses_while_a_conflicted_page_is_renamed_only_in_case",
        &[("b", &c.b)],
    );
    assert_eq!(renamed.outcome, Outcome::Error, "{renamed:?}");
    assert!(renamed.message.contains("Home.md"), "{}", renamed.message);
    assert!(still_merging);
    assert_ok(&finished);
    assert_eq!(git(c.b.root(), &["ls-files", "Home.md"]).trim(), "Home.md");
}

#[test]
fn a_reply_naming_a_private_page_the_way_git_quotes_it_is_withheld() {
    let names = std::collections::BTreeSet::from(["Finance/B\u{e4}nk/Link.md".to_string()]);
    let reply = Reply::error("refused:\n  \"Finance/B\\303\\244nk/Link.md\"");

    let redacted = agent_git::redact(reply, &[Ok(names)]);

    assert!(
        !redacted.message.contains("nk/Link.md"),
        "{}",
        redacted.message
    );
}

#[test]
fn an_agent_abort_restores_the_state_before_the_sync() {
    let c = public_conflict();
    let head = git(c.b.root(), &["rev-parse", "HEAD"]);

    let synced = agent(&c.b, Action::Sync, None);
    let aborted = agent(&c.b, Action::SyncAbort, None);

    artifact(
        "an_agent_abort_restores_the_state_before_the_sync",
        &[("b", &c.b)],
    );
    assert_eq!(synced.outcome, Outcome::Conflicts, "{synced:?}");
    assert_ok(&aborted);
    assert!(!git::merge_in_progress(c.b.root()));
    assert_eq!(git(c.b.root(), &["rev-parse", "HEAD"]), head);
    assert_eq!(c.b.read("Home.md"), "# Home\n\nhello from B\n");
    assert_eq!(c.b.read("Finance.md"), "# Finance\n\nsecret-balance-4242\n");
    assert_eq!(git(c.b.root(), &["status", "--porcelain"]), "");
}

#[test]
fn a_private_conflict_is_handed_off_and_never_named() {
    let c = conflicted();

    let synced = agent(&c.b, Action::Sync, None);
    c.b.write("Home.md", "# Home\n\nhello from both\n");
    let continued = agent(&c.b, Action::SyncContinue, None);
    let unmerged = git(c.b.root(), &["diff", "--name-only", "--diff-filter=U"]);

    artifact(
        "a_private_conflict_is_handed_off_and_never_named",
        &[("b", &c.b)],
    );
    assert_eq!(synced.outcome, Outcome::Conflicts, "{synced:?}");
    assert_eq!(conflict_pages(&synced), ["Home"]);
    assert_eq!(synced.private_conflicts, 1);
    assert_eq!(continued.outcome, Outcome::HandedOff, "{continued:?}");
    assert!(continued.conflicts.is_empty(), "{continued:?}");
    assert_eq!(continued.private_conflicts, 1);
    assert!(
        continued.message.contains("1 private page"),
        "{continued:?}"
    );
    assert!(!unmerged.contains("Home.md"), "{unmerged}");
    assert!(git::merge_in_progress(c.b.root()));
    for reply in [&synced, &continued] {
        let json = serde_json::to_string(reply).expect("json");
        assert_holds_none(&json, &["Finance", "Bank", "line two", ".enc"]);
    }
}

#[test]
fn an_agent_request_for_another_folder_is_refused() {
    let notes = repo();
    let other = TempDir::new().expect("other folder");
    let request = Request {
        folder: other.path().to_path_buf(),
        action: Action::Commit,
        message: None,
    };

    let replies = [
        agent_git::handle(
            &request,
            Some(notes.root()),
            &[],
            notes.state().key_store.as_ref(),
        ),
        agent_git::handle(&request, None, &[], notes.state().key_store.as_ref()),
    ];

    for reply in replies {
        assert_eq!(reply.outcome, Outcome::Error);
        assert_eq!(
            reply.message,
            "Aether has a different notes folder open: open this one in Aether first"
        );
    }
}

#[test]
fn app_git_work_and_agent_requests_wait_for_each_other() {
    let notes = repo();
    notes.write("Home.md", "# Home\n");
    let request = Request {
        folder: notes.root().to_path_buf(),
        action: Action::Commit,
        message: None,
    };
    let state = notes.state();

    let held = state.git_lock.lock().expect("git lock");
    let (waited, reply, committed) = std::thread::scope(|s| {
        let agent = s.spawn(|| crate::run_agent_request(&state, &request));
        let app = s.spawn(|| block_on(crate::git_commit("App".to_string(), state.clone())));
        std::thread::sleep(std::time::Duration::from_millis(500));
        let waited = !agent.is_finished() && !app.is_finished();
        drop(held);
        let reply = agent.join().expect("agent thread");
        let committed = app.join().expect("app thread").expect("git_commit");
        (waited, reply, committed)
    });

    assert!(waited, "git work ran while the lock was held");
    // One commits, the other finds nothing left.
    assert_ok(&reply);
    assert!(committed.success, "{:?}", committed.error);
    assert_eq!(git(notes.root(), &["rev-list", "--count", "HEAD"]), "1\n");
}

#[test]
fn an_agent_commit_with_nothing_to_commit_succeeds() {
    let notes = repo();
    notes.write("Home.md", "# Home\n");
    assert_ok(&agent(&notes, Action::Commit, None));

    let again = agent(&notes, Action::Commit, None);

    assert_ok(&again);
    assert_eq!(again.message, "Nothing to commit");
}
