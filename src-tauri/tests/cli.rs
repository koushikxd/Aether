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
        let home = self.home.path();
        let mut child = Command::new(env!("CARGO_BIN_EXE_aether-cli"))
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
