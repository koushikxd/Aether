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
