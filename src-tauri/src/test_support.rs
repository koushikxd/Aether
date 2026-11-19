use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::test::MockRuntime;
use tauri::{App, Manager, State};
use tempfile::TempDir;
use walkdir::WalkDir;

/// A temporary notes folder wired into a mock Tauri app, so tests can call
/// `#[tauri::command]` functions directly with `notes.state()`.
pub struct TestNotes {
    dir: TempDir,
    app: App<MockRuntime>,
}

impl TestNotes {
    pub fn new() -> Self {
        let dir = TempDir::new().expect("create temp notes folder");
        let app = tauri::test::mock_app();
        let state = AppState::default();
        state
            .app_config
            .write()
            .expect("app_config write lock")
            .notes_folder = Some(dir.path().to_string_lossy().into_owned());
        app.manage(state);
        Self { dir, app }
    }

    pub fn state(&self) -> State<'_, AppState> {
        self.app.state::<AppState>()
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    pub fn write(&self, rel: &str, content: &str) {
        self.write_bytes(rel, content.as_bytes());
    }

    pub fn write_bytes(&self, rel: &str, bytes: &[u8]) {
        let path = self.root().join(rel);
        std::fs::create_dir_all(path.parent().expect("parent dir")).expect("create parent dirs");
        std::fs::write(path, bytes).expect("write file");
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root().join(rel)).expect("read file")
    }

    /// Sorted relative paths of every file, with `/` separators.
    pub fn tree(&self) -> Vec<String> {
        let mut files: Vec<String> = WalkDir::new(self.root())
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| {
                e.path()
                    .strip_prefix(self.root())
                    .expect("inside root")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        files.sort();
        files
    }

    /// Writes the file tree and every file's text to
    /// `target/test-artifacts/<name>.txt` for inspection after the run.
    pub fn save_artifact(&self, name: &str) -> PathBuf {
        let mut dump = String::new();
        for rel in self.tree() {
            let bytes = std::fs::read(self.root().join(&rel)).expect("read file");
            dump.push_str(&format!("=== {rel}\n{}\n", String::from_utf8_lossy(&bytes)));
        }
        save_text_artifact(name, &dump)
    }
}

/// Writes `text` to `target/test-artifacts/<name>.txt`.
pub fn save_text_artifact(name: &str, text: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-artifacts");
    std::fs::create_dir_all(&dir).expect("create artifact dir");
    let path = dir.join(format!("{name}.txt"));
    std::fs::write(&path, text).expect("write artifact");
    path
}
