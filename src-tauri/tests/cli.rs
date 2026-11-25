//! Runs the built `aether-cli` binary against temporary notes folders. Each
//! test leaves its transcript (args, stdin, stdout, stderr, exit code) in
//! `test-results/cli/<test>.txt` at the repo root.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tempfile::TempDir;

struct Output {
    stdout: String,
    stderr: String,
    code: i32,
}

/// One test's CLI session: a temporary home (so the user's app config is
/// never read), a working directory, and the transcript of every run.
struct Cli {
    name: String,
    home: TempDir,
    cwd: PathBuf,
    transcript: String,
}

impl Cli {
    fn new(name: &str) -> Self {
        let home = TempDir::new().expect("create temp home");
        let cwd = home.path().to_path_buf();
        Self {
            name: name.to_string(),
            home,
            cwd,
            transcript: String::new(),
        }
    }

    fn run(&mut self, args: &[&str]) -> Output {
        self.run_with(args, None)
    }

    fn run_with(&mut self, args: &[&str], stdin: Option<&str>) -> Output {
        self.run_program_with(Path::new(env!("CARGO_BIN_EXE_aether-cli")), args, stdin)
    }

    fn run_program(&mut self, program: &Path, args: &[&str]) -> Output {
        self.run_program_with(program, args, None)
    }

    fn run_program_with(&mut self, program: &Path, args: &[&str], stdin: Option<&str>) -> Output {
        let home = self.home.path();
        let mut child = Command::new(program)
            .args(args)
            .current_dir(&self.cwd)
            .env("HOME", home)
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("APPDATA", home.join("AppData/Roaming"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run aether-cli");
        {
            let mut pipe = child.stdin.take().expect("stdin pipe");
            if let Some(text) = stdin {
                pipe.write_all(text.as_bytes()).expect("write stdin");
            }
        }
        let out = child.wait_with_output().expect("wait for aether-cli");
        let output = Output {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code().unwrap_or(-1),
        };
        self.transcript.push_str(&format!(
            "$ aether {}\n--- cwd\n{}\n--- stdin\n{}\n--- stdout\n{}\n--- stderr\n{}\n--- exit {}\n\n",
            args.join(" "),
            self.cwd.display(),
            stdin.unwrap_or(""),
            output.stdout,
            output.stderr,
            output.code
        ));
        output
    }
}

impl Drop for Cli {
    /// Written on drop, so a failing test leaves its transcript too.
    fn drop(&mut self) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-results/cli");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(format!("{}.txt", self.name)), &self.transcript);
    }
}

#[test]
fn help_prints_usage() {
    let mut cli = Cli::new("help_prints_usage");
    let out = cli.run(&["--help"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.contains("Usage: aether") && !out.stdout.contains("aether-cli"),
        "{}",
        out.stdout
    );
}

/// A notes folder in a git repo, with `.aether/` as the app creates it.
fn notes_folder(files: &[(&str, &str)]) -> TempDir {
    let dir = TempDir::new().expect("create notes folder");
    let status = Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir.path())
        .status()
        .expect("run git init");
    assert!(status.success());
    std::fs::create_dir_all(dir.path().join(".aether")).expect("create .aether");
    for (rel, content) in files {
        write(dir.path(), rel, content);
    }
    dir
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent dirs");
    std::fs::write(path, content).expect("write file");
}

/// Marks `ids` private the way the app records it on this device. The CLI
/// reads only the marks, so no key is needed.
fn mark_private(root: &Path, ids: &[&str]) {
    let marks = serde_json::json!({ "marks": ids });
    write(root, ".git/aether-vault.json", &marks.to_string());
}

fn json(out: &Output) -> serde_json::Value {
    serde_json::from_str(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "stdout is not JSON ({e}): {}\nstderr: {}",
            out.stdout, out.stderr
        )
    })
}

fn ids(value: &serde_json::Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("no {key} array in {value}"))
        .iter()
        .map(|p| p["id"].as_str().expect("id").to_string())
        .collect()
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const PRIVATE_FIXTURE: &[(&str, &str)] = &[
    ("Public.md", "# Public\n\nzebra in the open\n"),
    ("Public/Sub.md", "# Sub\n\nzebra below\n"),
    ("Public/Hidden.md", "# Hidden\n\nzebra hidden\n"),
    ("Secret.md", "# Secret\n\nzebra secret\n"),
    ("Secret/Child.md", "# Child\n\nzebra child\n"),
];

fn private_fixture() -> TempDir {
    let notes = notes_folder(PRIVATE_FIXTURE);
    mark_private(notes.path(), &["Secret", "Public/Hidden"]);
    notes
}

#[test]
fn list_and_search_leave_out_private_pages_and_their_sub_pages() {
    let mut cli = Cli::new("list_and_search_leave_out_private_pages_and_their_sub_pages");
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "list"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(ids(&json(&out), "pages"), ["Public", "Public/Sub"]);

    let out = cli.run(&["--folder", folder, "list"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("Public/Sub"), "{}", out.stdout);

    let out = cli.run(&["--folder", folder, "--json", "search", "zebra"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let mut found = ids(&json(&out), "results");
    found.sort();
    assert_eq!(found, ["Public", "Public/Sub"]);

    let out = cli.run(&["--folder", folder, "search", "zebra"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    for hidden in ["Secret", "Child", "Hidden", "secret"] {
        assert!(
            !out.stdout.contains(hidden),
            "{hidden} leaked: {}",
            out.stdout
        );
    }
}

#[test]
fn reading_a_private_page_exits_2_without_naming_it() {
    let mut cli = Cli::new("reading_a_private_page_exits_2_without_naming_it");
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");

    for id in ["Secret", "Secret/Child", "Public/Hidden"] {
        let out = cli.run(&["--folder", folder, "read", id]);
        assert_eq!(out.code, 2, "{id}: {}", out.stderr);
        assert!(out.stdout.is_empty(), "{}", out.stdout);
        assert!(out.stderr.contains("path unavailable"), "{}", out.stderr);
        assert!(!out.stderr.contains(id), "{}", out.stderr);

        let out = cli.run(&["--folder", folder, "--json", "read", id]);
        assert_eq!(out.code, 2);
        assert_eq!(json(&out)["error"]["code"], "unavailable");
        assert!(!out.stdout.contains(id), "{}", out.stdout);
    }

    let out = cli.run(&["--folder", folder, "--json", "list", "--under", "Secret"]);
    assert_eq!(out.code, 2);
    assert!(!out.stdout.contains("Child"), "{}", out.stdout);
}

#[test]
fn read_returns_markdown_hash_title_and_public_sub_pages() {
    let mut cli = Cli::new("read_returns_markdown_hash_title_and_public_sub_pages");
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "read", "Public"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let page = json(&out);
    assert_eq!(page["id"], "Public");
    assert_eq!(page["title"], "Public");
    assert_eq!(page["markdown"], PRIVATE_FIXTURE[0].1);
    assert_eq!(page["hash"], sha256_hex(PRIVATE_FIXTURE[0].1));
    assert_eq!(page["subPages"], serde_json::json!(["Public/Sub"]));

    let out = cli.run(&["--folder", folder, "--json", "list", "--under", "Public"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(ids(&json(&out), "pages"), ["Public/Sub"]);

    let out = cli.run(&["--folder", folder, "--json", "read", "Missing"]);
    assert_eq!(out.code, 2);
    assert_eq!(json(&out)["error"]["code"], "not_found");

    let out = cli.run(&["--folder", folder, "--json", "read", "../outside"]);
    assert_eq!(out.code, 1);
    assert_eq!(json(&out)["error"]["code"], "invalid");
}

#[test]
fn search_ranks_title_matches_first_and_shows_the_matching_line() {
    let mut cli = Cli::new("search_ranks_title_matches_first_and_shows_the_matching_line");
    let notes = notes_folder(&[
        ("Body.md", "# Body\n\nIntro.\n\nThe Roadmap is here.\n"),
        ("Roadmap.md", "# Roadmap\n\nPlans.\n"),
        ("Other.md", "# Other\n\nroadmap again\n"),
    ]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "search", "roadmap"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let results = json(&out);
    assert_eq!(ids(&results, "results")[0], "Roadmap");
    let body = results["results"]
        .as_array()
        .expect("results")
        .iter()
        .find(|r| r["id"] == "Body")
        .expect("Body result");
    assert_eq!(body["snippet"], "The Roadmap is here.");

    let out = cli.run(&[
        "--folder", folder, "--json", "search", "roadmap", "--limit", "1",
    ]);
    assert_eq!(ids(&json(&out), "results"), ["Roadmap"]);
}

#[test]
fn the_notes_folder_comes_from_the_flag_then_the_cwd_then_the_app_config() {
    let mut cli = Cli::new("the_notes_folder_comes_from_the_flag_then_the_cwd_then_the_app_config");
    let flag = notes_folder(&[("FromFlag.md", "# FromFlag\n")]);
    let cwd = notes_folder(&[("FromCwd.md", "# FromCwd\n"), ("Deep/Page.md", "# Page\n")]);
    let config = notes_folder(&[("FromConfig.md", "# FromConfig\n")]);

    // The app's config.json, where Tauri's app_data_dir puts it for this identifier.
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
    let identifier = conf["identifier"].as_str().expect("identifier");
    let data_dir = if cfg!(target_os = "macos") {
        cli.home.path().join("Library/Application Support")
    } else if cfg!(windows) {
        cli.home.path().join("AppData/Roaming")
    } else {
        cli.home.path().join(".local/share")
    };
    let app_config = serde_json::json!({ "notes_folder": config.path() });
    write(
        &data_dir.join(identifier),
        "config.json",
        &app_config.to_string(),
    );

    let out = cli.run(&["--json", "list"]);
    assert_eq!(ids(&json(&out), "pages"), ["FromConfig"], "{}", out.stderr);

    cli.cwd = cwd.path().join("Deep");
    let out = cli.run(&["--json", "list"]);
    assert_eq!(
        ids(&json(&out), "pages"),
        ["Deep", "Deep/Page", "FromCwd"],
        "{}",
        out.stderr
    );

    let flag_path = flag.path().to_str().expect("utf-8 path");
    let out = cli.run(&["--folder", flag_path, "--json", "list"]);
    assert_eq!(ids(&json(&out), "pages"), ["FromFlag"], "{}", out.stderr);
}

#[test]
fn no_notes_folder_is_an_error() {
    let mut cli = Cli::new("no_notes_folder_is_an_error");
    let out = cli.run(&["--json", "list"]);
    assert_eq!(out.code, 1);
    assert_eq!(json(&out)["error"]["code"], "error");
}

#[test]
fn app_and_ignored_folders_never_hold_pages() {
    let mut cli = Cli::new("app_and_ignored_folders_never_hold_pages");
    let defaults = notes_folder(&[
        ("Page.md", "# Page\n\nneedle\n"),
        ("node_modules/Dep.md", "# Dep\n\nneedle\n"),
        ("assets/Asset.md", "# Asset\n\nneedle\n"),
        (".trash/Gone.md", "# Gone\n\nneedle\n"),
        (".aether/Inner.md", "# Inner\n\nneedle\n"),
    ]);
    let custom = notes_folder(&[
        ("Page.md", "# Page\n\nneedle\n"),
        ("drafts/Draft.md", "# Draft\n\nneedle\n"),
        ("node_modules/Dep.md", "# Dep\n\nneedle\n"),
        (
            ".aether/settings.json",
            r#"{"theme":{"mode":"system"},"ignoredPatterns":["drafts"]}"#,
        ),
    ]);

    for (notes, expected) in [
        (&defaults, vec!["Page"]),
        (&custom, vec!["Page", "node_modules", "node_modules/Dep"]),
    ] {
        let folder = notes.path().to_str().expect("utf-8 path");
        let out = cli.run(&["--folder", folder, "--json", "list"]);
        assert_eq!(ids(&json(&out), "pages"), expected, "{}", out.stderr);
        let out = cli.run(&["--folder", folder, "--json", "search", "needle"]);
        let mut found = ids(&json(&out), "results");
        found.sort();
        let expected: Vec<&str> = expected
            .into_iter()
            .filter(|id| *id != "node_modules")
            .collect();
        assert_eq!(found, expected);
    }
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).expect("read file")
}

/// Every file outside `.git`, sorted, with `/` separators.
fn tree(root: &Path) -> Vec<String> {
    let mut files: Vec<String> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".git")
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| {
            let rel = e.path().strip_prefix(root).expect("inside root");
            rel.to_string_lossy().replace('\\', "/")
        })
        .collect();
    files.sort();
    files
}

fn marks(root: &Path) -> serde_json::Value {
    let local: serde_json::Value =
        serde_json::from_str(&read(root, ".git/aether-vault.json")).expect("vault state");
    local["marks"].clone()
}

#[test]
fn create_writes_a_page_at_the_root_or_under_a_parent() {
    let mut cli = Cli::new("create_writes_a_page_at_the_root_or_under_a_parent");
    let notes = notes_folder(&[("Parent.md", "# Parent\n")]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run_with(
        &["--folder", folder, "--json", "create", "My Page"],
        Some("Hello"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let created = json(&out);
    assert_eq!(created["id"], "My Page");
    assert_eq!(read(notes.path(), "My Page.md"), "# My Page\n\nHello\n");
    assert_eq!(created["hash"], sha256_hex("# My Page\n\nHello\n"));

    let out = cli.run(&["--folder", folder, "--json", "create", "My Page"]);
    assert_eq!(json(&out)["id"], "My Page-1", "{}", out.stderr);
    assert_eq!(read(notes.path(), "My Page-1.md"), "# My Page\n");

    let out = cli.run_with(
        &[
            "--folder", folder, "--json", "create", "Child", "--under", "Parent",
        ],
        Some("Body\n"),
    );
    assert_eq!(json(&out)["id"], "Parent/Child", "{}", out.stderr);
    assert!(notes.path().join("Parent").is_dir());
    assert_eq!(read(notes.path(), "Parent/Child.md"), "# Child\n\nBody\n");

    let out = cli.run(&[
        "--folder", folder, "--json", "create", "Orphan", "--under", "Nope",
    ]);
    assert_eq!(out.code, 2);
    assert_eq!(json(&out)["error"]["code"], "not_found");
}

#[test]
fn create_under_or_named_like_a_private_page_is_unavailable() {
    let mut cli = Cli::new("create_under_or_named_like_a_private_page_is_unavailable");
    let notes = private_fixture();
    write(notes.path(), "Dup.md", "# Dup\n");
    write(notes.path(), "Dup-1.md", "# Dup\n");
    mark_private(notes.path(), &["Secret", "Public/Hidden", "Dup-1"]);
    let folder = notes.path().to_str().expect("utf-8 path");
    let before = tree(notes.path());

    for args in [
        vec!["create", "New", "--under", "Secret"],
        vec!["create", "New", "--under", "Secret/Child"],
        vec!["create", "Secret"],
        vec!["create", "Hidden", "--under", "Public"],
        // Dup is taken, and Dup-2 would give away that Dup-1 exists.
        vec!["create", "Dup"],
    ] {
        let mut full = vec!["--folder", folder, "--json"];
        full.extend(&args);
        let out = cli.run(&full);
        assert_eq!(out.code, 2, "{args:?}: {}", out.stdout);
        assert_eq!(json(&out)["error"]["message"], "path unavailable");
        for name in ["Secret", "Hidden", "Dup-1", "Child"] {
            assert!(!out.stderr.contains(name), "{}", out.stderr);
        }
    }
    assert_eq!(tree(notes.path()), before);
}

#[test]
fn edit_with_a_stale_hash_exits_3_and_leaves_the_file() {
    let mut cli = Cli::new("edit_with_a_stale_hash_exits_3_and_leaves_the_file");
    let notes = notes_folder(&[("Page.md", "# Page\n\nOne\n")]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "read", "Page"]);
    let hash = json(&out)["hash"].as_str().expect("hash").to_string();
    write(notes.path(), "Page.md", "# Page\n\nChanged elsewhere\n");

    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Page",
            "--if-match",
            &hash,
        ],
        Some("# Page\n\nMine\n"),
    );
    assert_eq!(out.code, 3, "{}", out.stderr);
    assert_eq!(json(&out)["error"]["code"], "conflict");
    assert_eq!(
        read(notes.path(), "Page.md"),
        "# Page\n\nChanged elsewhere\n"
    );

    let out = cli.run(&["--folder", folder, "--json", "read", "Page"]);
    let hash = json(&out)["hash"].as_str().expect("hash").to_string();
    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Page",
            "--if-match",
            &hash,
        ],
        Some("# Page\n\nMine\n"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(json(&out)["hash"], sha256_hex("# Page\n\nMine\n"));
    assert_eq!(read(notes.path(), "Page.md"), "# Page\n\nMine\n");

    let out = cli.run_with(&["--folder", folder, "edit", "Page"], Some("# Page\n"));
    assert_eq!(out.code, 1, "edit needs --if-match: {}", out.stderr);
}

#[test]
fn edit_that_changes_the_heading_renames_the_page_and_follows_links() {
    let mut cli = Cli::new("edit_that_changes_the_heading_renames_the_page_and_follows_links");
    let notes = notes_folder(&[
        ("Old.md", "# Old\n"),
        ("Old/Kid.md", "# Kid\n\n[up](../Old.md)\n"),
        ("Index.md", "# Index\n\n[o](Old.md) [k](Old/Kid.md)\n"),
        (
            ".aether/settings.json",
            r#"{"theme":{"mode":"system"},"pinnedNoteIds":["Old/Kid"]}"#,
        ),
    ]);
    let folder = notes.path().to_str().expect("utf-8 path");
    let hash = sha256_hex("# Old\n");

    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Old",
            "--if-match",
            &hash,
        ],
        Some("# New\n\nBody\n"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(json(&out)["id"], "New");
    assert_eq!(
        tree(notes.path()),
        [".aether/settings.json", "Index.md", "New.md", "New/Kid.md"]
    );
    assert_eq!(read(notes.path(), "New.md"), "# New\n\nBody\n");
    assert_eq!(
        read(notes.path(), "New/Kid.md"),
        "# Kid\n\n[up](../New.md)\n"
    );
    assert_eq!(
        read(notes.path(), "Index.md"),
        "# Index\n\n[o](New.md) [k](New/Kid.md)\n"
    );
    let settings: serde_json::Value =
        serde_json::from_str(&read(notes.path(), ".aether/settings.json")).expect("settings");
    assert_eq!(settings["pinnedNoteIds"], serde_json::json!(["New/Kid"]));
}

#[test]
fn edit_that_renames_onto_a_private_name_is_unavailable() {
    let mut cli = Cli::new("edit_that_renames_onto_a_private_name_is_unavailable");
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");
    let hash = sha256_hex(PRIVATE_FIXTURE[1].1);

    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Public/Sub",
            "--if-match",
            &hash,
        ],
        Some("# Hidden\n"),
    );
    assert_eq!(out.code, 2, "{}", out.stdout);
    assert_eq!(read(notes.path(), "Public/Sub.md"), PRIVATE_FIXTURE[1].1);

    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Secret",
            "--if-match",
            "x",
        ],
        Some("# Secret\n"),
    );
    assert_eq!(out.code, 2);
    let out = cli.run_with(
        &["--folder", folder, "--json", "append", "Secret"],
        Some("x"),
    );
    assert_eq!(out.code, 2);
    assert_eq!(read(notes.path(), "Secret.md"), PRIVATE_FIXTURE[3].1);
}

#[test]
fn append_adds_text_after_a_blank_line_and_writes_a_bare_page() {
    let mut cli = Cli::new("append_adds_text_after_a_blank_line_and_writes_a_bare_page");
    let notes = notes_folder(&[("Page.md", "# Page\n\nOne\n"), ("Work/Task.md", "# Task\n")]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run_with(
        &["--folder", folder, "--json", "append", "Page"],
        Some("Two"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(notes.path(), "Page.md"), "# Page\n\nOne\n\nTwo\n");
    assert_eq!(json(&out)["hash"], sha256_hex("# Page\n\nOne\n\nTwo\n"));

    let out = cli.run_with(
        &["--folder", folder, "--json", "append", "Work"],
        Some("More\n"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(notes.path(), "Work.md"), "# Work\n\nMore\n");
}

#[test]
fn move_follows_links_private_marks_and_pins() {
    let mut cli = Cli::new("move_follows_links_private_marks_and_pins");
    let notes = notes_folder(&[
        ("Page.md", "# Page\n\n[Child](Page/Child.md)\n"),
        ("Page/Child.md", "# Child\n\n[Up](../Page.md)\n"),
        ("Page/Hidden.md", "# Hidden\n"),
        (
            "Index.md",
            "# Index\n\n[Page](Page.md) [Child](Page/Child.md)\n",
        ),
        ("Archive.md", "# Archive\n"),
        (
            ".aether/settings.json",
            r#"{"theme":{"mode":"system"},"pinnedNoteIds":["Page/Child"]}"#,
        ),
    ]);
    mark_private(notes.path(), &["Page/Hidden"]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&[
        "--folder", folder, "--json", "move", "Page", "--to", "Archive",
    ]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(json(&out)["id"], "Archive/Page");
    assert!(!out.stdout.contains("Hidden"), "{}", out.stdout);
    assert_eq!(
        read(notes.path(), "Index.md"),
        "# Index\n\n[Page](Archive/Page.md) [Child](Archive/Page/Child.md)\n"
    );
    assert_eq!(
        read(notes.path(), "Archive/Page/Child.md"),
        "# Child\n\n[Up](../Page.md)\n"
    );
    assert_eq!(
        marks(notes.path()),
        serde_json::json!(["Archive/Page/Hidden"])
    );
    let settings: serde_json::Value =
        serde_json::from_str(&read(notes.path(), ".aether/settings.json")).expect("settings");
    assert_eq!(
        settings["pinnedNoteIds"],
        serde_json::json!(["Archive/Page/Child"])
    );

    let out = cli.run(&[
        "--folder",
        folder,
        "--json",
        "move",
        "Archive/Page",
        "--to",
        "/",
    ]);
    assert_eq!(json(&out)["id"], "Page", "{}", out.stderr);

    let out = cli.run(&[
        "--folder",
        folder,
        "--json",
        "move",
        "Page",
        "--to",
        "Page/Child",
    ]);
    assert_eq!(out.code, 1, "{}", out.stdout);
    assert!(notes.path().join("Page.md").is_file());
}

#[test]
fn move_of_into_or_onto_a_private_page_is_unavailable() {
    let mut cli = Cli::new("move_of_into_or_onto_a_private_page_is_unavailable");
    let notes = private_fixture();
    write(notes.path(), "Other/Hidden.md", "# Hidden\n");
    write(notes.path(), "Other.md", "# Other\n");
    let folder = notes.path().to_str().expect("utf-8 path");
    let before = tree(notes.path());

    for args in [
        ["move", "Secret", "--to", "/"],
        ["move", "Public/Sub", "--to", "Secret"],
        // Public/Hidden is private, so Other/Hidden cannot land next to it.
        ["move", "Other/Hidden", "--to", "Public"],
    ] {
        let mut full = vec!["--folder", folder, "--json"];
        full.extend(args);
        let out = cli.run(&full);
        assert_eq!(out.code, 2, "{args:?}: {}", out.stdout);
        assert_eq!(json(&out)["error"]["message"], "path unavailable");
    }
    assert_eq!(tree(notes.path()), before);
}

#[test]
fn check_reports_each_problem_once_and_nothing_private() {
    let mut cli = Cli::new("check_reports_each_problem_once_and_nothing_private");
    let notes = notes_folder(&[
        ("Fine.md", "# Fine\n\n[ok](Broken.md) ![x](assets/x.png)\n\nSetext\n=======\n\n```\n<<<<<<< HEAD\n```\n"),
        ("assets/x.png", "png"),
        ("Broken.md", "# Broken\n\n[gone](Missing.md) ![img](assets/nothing.png)\n"),
        ("Conflict.md", "# Conflict\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n"),
        ("Leaky.md", "# Leaky\n\n[s](Secret/Child.md)\n"),
        ("Wiki.md", "# Wiki\n\n[[Secret]]\n"),
        ("Renamed.md", "# Something Else\n"),
        ("Secret.md", "# Secret\n\n[gone](Nowhere.md)\n\n<<<<<<< HEAD\n"),
        ("Secret/Child.md", "# Not Child\n"),
    ]);
    mark_private(notes.path(), &["Secret"]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "check"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let problems: Vec<(String, String)> = json(&out)["problems"]
        .as_array()
        .expect("problems")
        .iter()
        .map(|p| {
            (
                p["id"].as_str().expect("id").to_string(),
                p["kind"].as_str().expect("kind").to_string(),
            )
        })
        .collect();
    let expected = [
        ("Broken", "broken_link"),
        ("Broken", "broken_link"),
        ("Conflict", "conflict_markers"),
        ("Leaky", "links_to_unavailable_page"),
        ("Renamed", "title_mismatch"),
        ("Wiki", "links_to_unavailable_page"),
    ];
    let expected: Vec<(String, String)> = expected
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    assert_eq!(problems, expected);
    assert!(out.stdout.contains("Missing.md") && out.stdout.contains("assets/nothing.png"));
    assert!(
        out.stdout.contains("links to an unavailable page"),
        "{}",
        out.stdout
    );

    let text = cli.run(&["--folder", folder, "check"]);
    for out in [&out, &text] {
        for private in ["Secret", "Child", "Nowhere"] {
            assert!(
                !out.stdout.contains(private),
                "{private} leaked: {}",
                out.stdout
            );
        }
    }
}

/// A copy of the CLI next to a fake `Aether` app that writes the arguments
/// it was started with to `opened.txt`, reached through a symlink on a
/// fake PATH as the install makes it.
#[cfg(unix)]
struct FakeInstall {
    dir: TempDir,
}

#[cfg(unix)]
impl FakeInstall {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().expect("create install dir");
        let bundle = dir.path().join("bundle");
        std::fs::create_dir_all(&bundle).expect("create bundle dir");
        std::fs::copy(env!("CARGO_BIN_EXE_aether-cli"), bundle.join("aether-cli"))
            .expect("copy cli");
        let app = bundle.join("Aether");
        // One line per argument, moved into place once written.
        let script = r#"#!/bin/sh
d=$(dirname "$0")
for a in "$@"; do echo "$a"; done > "$d/opened.tmp"
mv "$d/opened.tmp" "$d/opened.txt"
"#;
        std::fs::write(&app, script).expect("write fake app");
        std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::fs::create_dir_all(dir.path().join("bin")).expect("create bin dir");
        std::os::unix::fs::symlink(bundle.join("aether-cli"), dir.path().join("bin/aether"))
            .expect("symlink cli");
        Self { dir }
    }

    fn cli(&self) -> PathBuf {
        self.dir.path().join("bin/aether")
    }

    /// The arguments the fake app got, once it has run.
    fn opened(&self) -> Vec<String> {
        let file = self.dir.path().join("bundle/opened.txt");
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&file) {
                std::fs::remove_file(&file).expect("remove opened.txt");
                return text.lines().map(str::to_string).collect();
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the fake app never ran");
    }
}

#[cfg(unix)]
#[test]
fn open_and_a_bare_path_start_the_app_with_the_path() {
    let mut cli = Cli::new("open_and_a_bare_path_start_the_app_with_the_path");
    let install = FakeInstall::new();
    let notes = notes_folder(&[("Page.md", "# Page\n")]);
    let root = notes.path().canonicalize().expect("canonical notes folder");
    cli.cwd = root.clone();
    let page = root.join("Page.md");

    let out = cli.run_program(&install.cli(), &["open", "."]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(install.opened(), [root.to_str().expect("utf-8")]);

    let out = cli.run_program(&install.cli(), &["."]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(install.opened(), [root.to_str().expect("utf-8")]);

    let out = cli.run_program(&install.cli(), &["Page.md"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(install.opened(), [page.to_str().expect("utf-8")]);

    let out = cli.run_program(&install.cli(), &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(install.opened().is_empty());

    let out = cli.run_program(&install.cli(), &["--json", "nonsense"]);
    assert_eq!(out.code, 1);
    assert_eq!(json(&out)["error"]["code"], "invalid");
}

#[test]
fn a_command_name_wins_over_a_folder_with_that_name() {
    let mut cli = Cli::new("a_command_name_wins_over_a_folder_with_that_name");
    let notes = notes_folder(&[("Page.md", "# Page\n"), ("list/Inner.md", "# Inner\n")]);
    cli.cwd = notes.path().to_path_buf();

    let out = cli.run(&["--json", "list"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(ids(&json(&out), "pages"), ["Page", "list", "list/Inner"]);
}
