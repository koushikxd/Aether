//! Runs the built `aether-cli` binary against temporary notes folders. Each
//! test leaves its transcript (args, stdin, stdout, stderr, exit code) in
//! `test-results/cli/<test>.txt` at the repo root.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
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
    /// Extra environment for every run.
    env: Vec<(&'static str, String)>,
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
            env: Vec::new(),
            transcript: String::new(),
        }
    }

    fn run(&mut self, args: &[&str]) -> Output {
        self.run_with(args, None)
    }

    fn run_with(&mut self, args: &[&str], stdin: Option<&str>) -> Output {
        self.run_program_with(Path::new(env!("CARGO_BIN_EXE_aether-cli")), args, stdin)
    }

    #[cfg(unix)]
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
            .envs(self.env.iter().map(|(k, v)| (k, v)))
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
        self.record(args, stdin.unwrap_or(""), out)
    }

    /// Runs with stdin left open and never written, as some agent shells
    /// leave it. Kills the CLI if it is still waiting after 30 seconds.
    fn run_with_idle_stdin(&mut self, args: &[&str]) -> Output {
        let home = self.home.path();
        let mut child = Command::new(env!("CARGO_BIN_EXE_aether-cli"))
            .args(args)
            .current_dir(&self.cwd)
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run aether-cli");
        let _idle = child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(30);
        while child.try_wait().expect("poll aether-cli").is_none() {
            if Instant::now() > deadline {
                child.kill().expect("kill aether-cli");
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let out = child.wait_with_output().expect("wait for aether-cli");
        self.record(args, "(open, nothing written)", out)
    }

    fn record(&mut self, args: &[&str], stdin: &str, out: std::process::Output) -> Output {
        let output = Output {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code().unwrap_or(-1),
        };
        self.transcript.push_str(&format!(
            "$ aether {}\n--- cwd\n{}\n--- stdin\n{}\n--- stdout\n{}\n--- stderr\n{}\n--- exit {}\n\n",
            args.join(" "),
            self.cwd.display(),
            stdin,
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
fn a_private_page_stays_unreadable_by_another_spelling_a_sub_folder_or_damaged_marks() {
    let mut cli = Cli::new(
        "a_private_page_stays_unreadable_by_another_spelling_a_sub_folder_or_damaged_marks",
    );
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");
    let private_text = ["zebra secret", "zebra child", "zebra hidden"];
    let shows_private = |out: &Output| private_text.iter().any(|t| out.stdout.contains(t));

    for id in [
        "secret",
        "SECRET/Child",
        "Public//Hidden",
        "Public/./Hidden",
        "./Secret",
    ] {
        let out = cli.run(&["--folder", folder, "--json", "read", id]);
        assert_ne!(out.code, 0, "{id}: {}", out.stdout);
        assert!(!shows_private(&out), "{id}: {}", out.stdout);
    }

    let public = notes.path().join("Public");
    let public = public.to_str().expect("utf-8 path");
    for args in [vec!["read", "Hidden"], vec!["list"]] {
        let out = cli.run(&[&["--folder", public, "--json"], &args[..]].concat());
        assert_ne!(out.code, 0, "{args:?}: {}", out.stdout);
        assert!(!out.stdout.contains("Hidden"), "{args:?}: {}", out.stdout);
        // Windows paths as people type them, not the \\?\ form canonicalize gives
        let error = json(&out);
        let message = error["error"]["message"].as_str().expect("error message");
        assert!(!message.contains(r"\\?\"), "{message}");
    }

    std::fs::write(notes.path().join(".git/aether-vault.json"), [0xff, 0xfe])
        .expect("damage the marks");
    for args in [vec!["read", "Secret"], vec!["list"]] {
        let out = cli.run(&[&["--folder", folder, "--json"], &args[..]].concat());
        assert_eq!(out.code, 1, "{args:?}: {}", out.stdout);
        assert!(!out.stdout.contains("Secret"), "{args:?}: {}", out.stdout);
    }
}

#[cfg(unix)]
#[test]
fn a_symlinked_page_or_a_nested_notes_folder_reaches_nothing_private() {
    use std::os::unix::fs::symlink;
    let mut cli = Cli::new("a_symlinked_page_or_a_nested_notes_folder_reaches_nothing_private");
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");
    symlink(
        notes.path().join("Secret.md"),
        notes.path().join("Alias.md"),
    )
    .expect("link page");
    symlink(notes.path().join("Secret"), notes.path().join("Linked")).expect("link folder");
    // Into another notes folder, whose marks this one cannot see
    let other = private_fixture();
    symlink(
        other.path().join("Secret.md"),
        notes.path().join("Elsewhere.md"),
    )
    .expect("link out");

    for args in [
        vec!["list"],
        vec!["search", "zebra"],
        vec!["read", "Alias"],
        vec!["read", "Linked/Child"],
        vec!["read", "Elsewhere"],
    ] {
        let out = cli.run(&[&["--folder", folder, "--json"], &args[..]].concat());
        assert!(
            !out.stdout.contains("zebra secret"),
            "{args:?}: {}",
            out.stdout
        );
        assert!(
            !out.stdout.contains("zebra child"),
            "{args:?}: {}",
            out.stdout
        );
        assert!(!out.stdout.contains("Alias"), "{args:?}: {}", out.stdout);
        assert!(!out.stdout.contains("Linked"), "{args:?}: {}", out.stdout);
        assert!(
            !out.stdout.contains("Elsewhere"),
            "{args:?}: {}",
            out.stdout
        );
    }

    // A notes folder the app once opened inside this one
    std::fs::create_dir_all(notes.path().join("Public/.aether")).expect("nested .aether");
    cli.cwd = notes.path().join("Public");
    let out = cli.run(&["--json", "read", "Hidden"]);
    assert_ne!(out.code, 0, "{}", out.stdout);
    assert!(!out.stdout.contains("zebra hidden"), "{}", out.stdout);
}

#[test]
fn names_that_differ_only_by_case_create_and_rename_as_usual() {
    let mut cli = Cli::new("names_that_differ_only_by_case_create_and_rename_as_usual");
    let notes = notes_folder(&[("Page.md", "# Page\n"), ("Other.md", "# Other\n")]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run_with(
        &["--folder", folder, "--json", "create", "page"],
        Some("Body"),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);

    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Other",
            "--if-match",
            &sha256_hex("# Other\n"),
        ],
        Some("# other\n"),
    );
    assert_eq!(out.code, 0, "{}", out.stdout);
    assert_eq!(json(&out)["id"], "other");
}

#[test]
fn creating_a_name_that_differs_from_a_private_page_only_by_case_is_unavailable() {
    let mut cli =
        Cli::new("creating_a_name_that_differs_from_a_private_page_only_by_case_is_unavailable");
    let notes = private_fixture();
    let folder = notes.path().to_str().expect("utf-8 path");

    for args in [
        vec!["create", "secret"],
        vec!["create", "HIDDEN", "--under", "Public"],
    ] {
        let out = cli.run_with(
            &[&["--folder", folder, "--json"], &args[..]].concat(),
            Some("x"),
        );
        assert_eq!(out.code, 2, "{args:?}: {}", out.stdout);
        assert_eq!(json(&out)["error"]["code"], "unavailable");
    }
}

#[test]
fn a_notes_folder_whose_git_is_a_pointer_file_still_works() {
    let mut cli = Cli::new("a_notes_folder_whose_git_is_a_pointer_file_still_works");
    let notes = TempDir::new().expect("create notes folder");
    write(
        notes.path(),
        ".git",
        "gitdir: /elsewhere/.git/worktrees/notes\n",
    );
    write(notes.path(), "Page.md", "# Page\n");
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "list"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(ids(&json(&out), "pages"), ["Page"]);
}

#[test]
fn an_edit_whose_heading_cannot_name_a_page_leaves_the_file_alone() {
    let mut cli = Cli::new("an_edit_whose_heading_cannot_name_a_page_leaves_the_file_alone");
    let notes = notes_folder(&[("Page.md", "# Page\n")]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run_with(
        &[
            "--folder",
            folder,
            "--json",
            "edit",
            "Page",
            "--if-match",
            &sha256_hex("# Page\n"),
        ],
        Some("# ..\n\nnew\n"),
    );
    assert_ne!(out.code, 0, "{}", out.stdout);
    assert_eq!(read(notes.path(), "Page.md"), "# Page\n");
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
#[cfg_attr(
    windows,
    ignore = "Windows finds the app config through the OS, which a test cannot point at a temp home"
)]
fn the_notes_folder_comes_from_the_flag_then_the_cwd_then_the_app_config() {
    let mut cli = Cli::new("the_notes_folder_comes_from_the_flag_then_the_cwd_then_the_app_config");
    let flag = notes_folder(&[("FromFlag.md", "# FromFlag\n")]);
    let cwd = notes_folder(&[("FromCwd.md", "# FromCwd\n"), ("Deep/Page.md", "# Page\n")]);
    let config = notes_folder(&[("FromConfig.md", "# FromConfig\n")]);

    let app_config = serde_json::json!({ "notes_folder": config.path() });
    write(&app_data(&cli), "config.json", &app_config.to_string());

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
#[cfg_attr(
    windows,
    ignore = "Windows finds the app config through the OS, which a test cannot point at a temp home"
)]
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
fn create_append_and_edit_fail_when_stdin_stays_open_with_nothing_on_it() {
    let mut cli = Cli::new("create_append_and_edit_fail_when_stdin_stays_open_with_nothing_on_it");
    let notes = notes_folder(&[("Page.md", "# Page\n")]);
    let folder = notes.path().to_str().expect("utf-8 path");
    let hash = sha256_hex("# Page\n");

    for args in [
        vec!["create", "Empty"],
        vec!["append", "Page"],
        vec!["edit", "Page", "--if-match", &hash],
    ] {
        let started = Instant::now();
        let out = cli.run_with_idle_stdin(&[&["--folder", folder, "--json"], &args[..]].concat());
        assert!(started.elapsed() < Duration::from_secs(20), "{args:?} hung");
        assert_eq!(out.code, 1, "{args:?}: {}", out.stderr);
        let error = &json(&out)["error"];
        assert_eq!(error["code"], "invalid");
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|m| m.contains("< /dev/null")),
            "{error}"
        );
    }
    assert!(!notes.path().join("Empty.md").exists());
    assert_eq!(read(notes.path(), "Page.md"), "# Page\n");
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
        // One line per argument, moved into place once written. With a
        // reply to give, it takes an agent request as the app does.
        let script = r#"#!/bin/sh
d=$(dirname "$0")
for a in "$@"; do echo "$a"; done > "$d/opened.tmp"
mv "$d/opened.tmp" "$d/opened.txt"
if [ "$1" = "--agent-request" ] && [ -f "$d/reply.json" ]; then
  m=$(cat "$d/mailbox.txt")
  mv "$m/requests/$2.json" "$d/request.json"
  mkdir -p "$m/responses"
  cp "$d/reply.json" "$m/responses/$2.tmp"
  mv "$m/responses/$2.tmp" "$m/responses/$2.json"
fi
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

    /// A copy of the CLI away from the app, as the Windows install puts
    /// it, with the file naming the app that the install writes beside it.
    fn copied_cli(&self) -> PathBuf {
        let copy = self.dir.path().join("copy");
        std::fs::create_dir_all(&copy).expect("create copy dir");
        std::fs::copy(env!("CARGO_BIN_EXE_aether-cli"), copy.join("aether")).expect("copy cli");
        let app = self.dir.path().join("bundle/Aether");
        std::fs::write(copy.join("aether-app.txt"), app.to_str().expect("utf-8"))
            .expect("write app path");
        copy.join("aether")
    }

    /// Makes the fake app answer agent requests with `reply`, through the
    /// mailbox of the CLI session `cli`.
    fn answer(&self, cli: &Cli, reply: serde_json::Value) {
        let bundle = self.dir.path().join("bundle");
        let mailbox = mailbox(cli);
        write(&bundle, "mailbox.txt", mailbox.to_str().expect("utf-8"));
        write(&bundle, "reply.json", &reply.to_string());
    }

    /// The last agent request the fake app took.
    fn request(&self) -> serde_json::Value {
        let file = self.dir.path().join("bundle/request.json");
        let text = std::fs::read_to_string(file).expect("the fake app took no request");
        serde_json::from_str(&text).expect("request json")
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

#[cfg(unix)]
#[test]
fn a_copied_cli_opens_the_app_its_install_named() {
    let mut cli = Cli::new("a_copied_cli_opens_the_app_its_install_named");
    let install = FakeInstall::new();
    let notes = notes_folder(&[]);
    let root = notes.path().canonicalize().expect("canonical notes folder");
    cli.cwd = root.clone();

    let out = cli.run_program(&install.copied_cli(), &["open", "."]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(install.opened(), [root.to_str().expect("utf-8")]);
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

/// Runs git in `dir` with a test identity, panicking when it fails.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A notes folder on branch `main` with `files` committed.
fn committed_notes(files: &[(&str, &str)]) -> TempDir {
    let notes = notes_folder(files);
    git(notes.path(), &["checkout", "-q", "-b", "main"]);
    git(notes.path(), &["add", "-A"]);
    git(notes.path(), &["commit", "-q", "-m", "start"]);
    notes
}

#[test]
fn status_lists_public_changes_by_id_and_private_ones_as_a_count() {
    let mut cli = Cli::new("status_lists_public_changes_by_id_and_private_ones_as_a_count");
    let notes = committed_notes(&[("Public.md", "# Public\n"), ("Public/Sub.md", "# Sub\n")]);
    write(notes.path(), "Public.md", "# Public\n\nedited\n");
    write(notes.path(), "New.md", "# New\n");
    write(notes.path(), "assets/x.png", "png");
    write(notes.path(), "Secret.md", "# Secret\n");
    write(notes.path(), "Secret/Child.md", "# Child\n");
    mark_private(notes.path(), &["Secret"]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "status"]);
    let text = cli.run(&["--folder", folder, "status"]);

    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        json(&out),
        serde_json::json!({
            "branch": "main",
            "ahead": null,
            "behind": null,
            "changedPages": ["New", "Public"],
            "otherChanges": 1,
            // Two files and the new mark, as the app counts them
            "privateChanges": 3,
            "mergeInProgress": false,
            "syncBlocked": true,
        })
    );
    assert_eq!(text.code, 0, "{}", text.stderr);
    assert!(text.stdout.contains("New, Public"), "{}", text.stdout);
    for out in [&out, &text] {
        for private in ["Secret", "Child"] {
            assert!(!out.stdout.contains(private), "{}", out.stdout);
        }
    }
}

#[test]
fn status_reports_ahead_behind_and_a_merge_in_progress() {
    let mut cli = Cli::new("status_reports_ahead_behind_and_a_merge_in_progress");
    let remote = TempDir::new().expect("remote");
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let notes = committed_notes(&[("Home.md", "# Home\n")]);
    let url = remote.path().to_str().expect("utf-8 path");
    git(notes.path(), &["remote", "add", "origin", url]);
    git(notes.path(), &["push", "-q", "-u", "origin", "main"]);
    git(notes.path(), &["checkout", "-q", "-b", "other"]);
    write(notes.path(), "Home.md", "# Home\n\nfrom other\n");
    git(notes.path(), &["commit", "-q", "-am", "other"]);
    git(notes.path(), &["checkout", "-q", "main"]);
    write(notes.path(), "Home.md", "# Home\n\nfrom main\n");
    git(notes.path(), &["commit", "-q", "-am", "main"]);
    let folder = notes.path().to_str().expect("utf-8 path");

    let ahead = cli.run(&["--folder", folder, "--json", "status"]);
    let merge = Command::new("git")
        .args(["merge", "-q", "other"])
        .current_dir(notes.path())
        .output()
        .expect("run git merge");
    assert!(!merge.status.success(), "the merge should conflict");
    let merging = cli.run(&["--folder", folder, "--json", "status"]);
    let text = cli.run(&["--folder", folder, "status"]);

    assert_eq!(ahead.code, 0, "{}", ahead.stderr);
    let ahead = json(&ahead);
    assert_eq!(
        (ahead["ahead"].clone(), ahead["behind"].clone()),
        (1.into(), 0.into())
    );
    assert_eq!(ahead["mergeInProgress"], false);
    assert_eq!(ahead["syncBlocked"], false);
    let merging = json(&merging);
    assert_eq!(merging["mergeInProgress"], true);
    assert_eq!(merging["changedPages"], serde_json::json!(["Home"]));
    assert!(
        text.stdout.contains("aether sync --continue"),
        "{}",
        text.stdout
    );
}

#[test]
fn status_outside_a_git_repository_is_an_error() {
    let mut cli = Cli::new("status_outside_a_git_repository_is_an_error");
    let notes = TempDir::new().expect("notes folder");
    write(notes.path(), "Page.md", "# Page\n");
    let folder = notes.path().to_str().expect("utf-8 path");

    let out = cli.run(&["--folder", folder, "--json", "status"]);

    assert_eq!(out.code, 1);
    assert_eq!(json(&out)["error"]["code"], "error");
}

/// The app's data folder in the CLI session's temporary home, where Tauri's
/// app_data_dir puts it.
fn app_data(cli: &Cli) -> PathBuf {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
    let identifier = conf["identifier"].as_str().expect("identifier");
    let data_dir = if cfg!(target_os = "macos") {
        cli.home.path().join("Library/Application Support")
    } else {
        cli.home.path().join(".local/share")
    };
    data_dir.join(identifier)
}

fn mailbox(cli: &Cli) -> PathBuf {
    app_data(cli).join("agent")
}

fn reply(outcome: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "outcome": outcome, "message": message })
}

#[cfg(unix)]
#[test]
fn commit_and_sync_ask_the_app_for_the_notes_folder() {
    let mut cli = Cli::new("commit_and_sync_ask_the_app_for_the_notes_folder");
    let install = FakeInstall::new();
    install.answer(&cli, reply("ok", "Changes committed"));
    let notes = committed_notes(&[("Page.md", "# Page\n")]);
    let root = notes.path().canonicalize().expect("canonical notes folder");
    cli.cwd = root.clone();

    let out = cli.run_program(&install.cli(), &["commit", "-m", "Agent notes"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "Changes committed\n");
    let opened = install.opened();
    assert_eq!(opened[0], "--agent-request");
    assert_eq!(opened.len(), 2, "{opened:?}");
    assert_eq!(
        install.request(),
        serde_json::json!({
            "folder": root.to_str().expect("utf-8"),
            "action": "commit",
            "message": "Agent notes",
        })
    );

    for (args, action) in [
        (vec!["commit"], "commit"),
        (vec!["sync"], "sync"),
        (vec!["sync", "--continue"], "sync-continue"),
        (vec!["sync", "--abort"], "sync-abort"),
    ] {
        let out = cli.run_program(&install.cli(), &args);
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
        let request = install.request();
        assert_eq!(request["action"], action, "{args:?}");
        assert!(request.get("message").is_none(), "{request}");
    }
    let out = cli.run_program(&install.cli(), &["sync", "--continue", "--abort"]);
    assert_eq!(out.code, 1, "{}", out.stdout);
    let left: Vec<_> = std::fs::read_dir(mailbox(&cli).join("requests"))
        .expect("requests dir")
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[cfg(unix)]
#[test]
fn each_reply_from_the_app_has_its_own_exit_code() {
    let mut cli = Cli::new("each_reply_from_the_app_has_its_own_exit_code");
    let install = FakeInstall::new();
    let notes = committed_notes(&[("Page.md", "# Page\n")]);
    cli.cwd = notes.path().to_path_buf();
    let wrong_folder = "Aether has a different notes folder open: open this one in Aether first";
    let conflicts = serde_json::json!({
        "outcome": "conflicts",
        "message": "Sync stopped on conflicts",
        "conflicts": [
            { "path": "Home.md", "page": "Home" },
            { "path": ".aether/settings.json", "page": null },
        ],
        "privateConflicts": 1,
    });
    let handed_off = serde_json::json!({
        "outcome": "handed_off",
        "message": "1 private page needs you in Aether",
        "privateConflicts": 1,
    });

    install.answer(&cli, reply("error", wrong_folder));
    let out = cli.run_program(&install.cli(), &["--json", "commit"]);
    assert_eq!(out.code, 1, "{}", out.stdout);
    assert_eq!(json(&out)["error"]["message"], wrong_folder);

    install.answer(&cli, conflicts);
    let out = cli.run_program(&install.cli(), &["--json", "sync"]);
    assert_eq!(out.code, 3, "{}", out.stdout);
    let error = &json(&out)["error"];
    assert_eq!(error["code"], "merge_conflicts");
    assert_eq!(error["conflicts"][0]["page"], "Home");
    assert_eq!(error["privateConflicts"], 1);
    let text = cli.run_program(&install.cli(), &["sync"]);
    assert_eq!(text.code, 3);
    assert!(text.stderr.contains("Home (Home.md)"), "{}", text.stderr);
    assert!(
        text.stderr.contains(".aether/settings.json"),
        "{}",
        text.stderr
    );

    install.answer(&cli, handed_off);
    let out = cli.run_program(&install.cli(), &["--json", "sync", "--continue"]);
    assert_eq!(out.code, 4, "{}", out.stdout);
    let error = &json(&out)["error"];
    assert_eq!(error["code"], "handed_off");
    assert_eq!(error["message"], "1 private page needs you in Aether");
}

#[cfg(unix)]
#[test]
fn no_reply_in_time_exits_1_and_takes_back_the_request() {
    let mut cli = Cli::new("no_reply_in_time_exits_1_and_takes_back_the_request");
    let install = FakeInstall::new();
    let notes = committed_notes(&[("Page.md", "# Page\n")]);
    cli.cwd = notes.path().to_path_buf();
    cli.env.push(("AETHER_REPLY_TIMEOUT_MS", "300".to_string()));

    let out = cli.run_program(&install.cli(), &["--json", "commit"]);

    assert_eq!(out.code, 1, "{}", out.stdout);
    assert_eq!(
        json(&out)["error"]["message"],
        "Aether did not answer: check the app"
    );
    let left: Vec<_> = std::fs::read_dir(mailbox(&cli).join("requests"))
        .expect("requests dir")
        .collect();
    assert!(left.is_empty(), "{left:?}");
}
