//! `aether`: the command line for reading and writing an Aether notes
//! folder with the app closed. Installed on PATH as `aether`.
//!
//! Private pages do not exist for the CLI: they never show in output, and
//! any command that touches one fails with "path unavailable", naming
//! nothing private.

use aether_lib::notes::{self, PrivateSet};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::ExitCode;

/// The app's bundle identifier, which names its data folder (`tauri.conf.json`).
const APP_IDENTIFIER: &str = "com.aether.app";

#[derive(Parser)]
#[command(
    name = "aether",
    bin_name = "aether",
    version,
    about = "Read and write Aether pages from the shell",
    after_help = "A page is named by its id: its path in the notes folder, with / separators \
and no .md (for example Components/Buttons).\n\n\
Exit codes: 0 ok, 1 error, 2 not found or unavailable, 3 conflict."
)]
struct Cli {
    /// Notes folder. Default: the nearest folder above the current directory
    /// holding .aether/, else the folder open in the app.
    #[arg(long, global = true, value_name = "PATH")]
    folder: Option<PathBuf>,

    /// Print one JSON object on stdout. Errors too, as {"error": {"code", "message"}}.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List pages with their ids and titles
    List {
        /// Only the sub-pages of this page, at every depth
        #[arg(long, value_name = "PAGE")]
        under: Option<String>,
    },
    /// Search page titles, then their content
    Search {
        #[arg(required = true)]
        query: Vec<String>,
        /// Most results to print
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Print a page's markdown, hash, title, and sub-pages
    Read { page: String },
}

enum Failure {
    NotFound,
    Unavailable,
    Invalid(String),
    Other(String),
}

impl Failure {
    fn code(&self) -> &'static str {
        match self {
            Failure::NotFound => "not_found",
            Failure::Unavailable => "unavailable",
            Failure::Invalid(_) => "invalid",
            Failure::Other(_) => "error",
        }
    }

    fn exit_code(&self) -> u8 {
        match self {
            Failure::NotFound | Failure::Unavailable => 2,
            Failure::Invalid(_) | Failure::Other(_) => 1,
        }
    }

    fn message(&self) -> String {
        match self {
            Failure::NotFound => "page not found".to_string(),
            Failure::Unavailable => "path unavailable".to_string(),
            Failure::Invalid(message) | Failure::Other(message) => message.clone(),
        }
    }
}

/// What a command prints: `json` with `--json`, else `text`.
struct Report {
    json: Value,
    text: String,
}

/// The notes folder and what every command needs to know about it.
struct Folder {
    root: PathBuf,
    ignored: Vec<String>,
    private: PrivateSet,
}

impl Folder {
    fn open(flag: Option<PathBuf>) -> Result<Self, Failure> {
        let root = notes_root(flag)?;
        let ignored = notes::ignored_dirs(&root);
        let private = notes::private_set(&root, &ignored).map_err(Failure::Other)?;
        Ok(Folder {
            root,
            ignored,
            private,
        })
    }

    fn is_private(&self, id: &str) -> bool {
        self.private.contains(&format!("{id}.md")) || self.private.contains_dir(id)
    }

    /// Checks page id `id` names a public page that can exist: valid, not
    /// private, and not in an app or ignored folder.
    fn check(&self, id: &str) -> Result<(), Failure> {
        notes::check_id(&self.root, id).map_err(Failure::Invalid)?;
        if self.is_private(id) {
            return Err(Failure::Unavailable);
        }
        if notes::in_hidden_folder(&self.ignored, id) {
            return Err(Failure::NotFound);
        }
        Ok(())
    }

    fn read(&self, id: &str) -> Result<aether_lib::Note, Failure> {
        self.check(id)?;
        notes::read(&self.root, &self.ignored, id).map_err(|e| {
            if e == "Note not found" {
                Failure::NotFound
            } else {
                Failure::Other(e)
            }
        })
    }

    /// Every public page, sorted by id.
    fn pages(&self) -> Vec<aether_lib::NoteMetadata> {
        let mut pages: Vec<_> = notes::list(&self.root, &self.ignored)
            .into_iter()
            .filter(|p| !self.is_private(&p.id))
            .collect();
        pages.sort_by(|a, b| a.id.cmp(&b.id));
        pages
    }
}

/// `--folder`, else the nearest ancestor of the current directory holding
/// `.aether/`, else the notes folder in the app's config.
fn notes_root(flag: Option<PathBuf>) -> Result<PathBuf, Failure> {
    if let Some(folder) = flag {
        return folder
            .canonicalize()
            .ok()
            .filter(|f| f.is_dir())
            .ok_or_else(|| {
                Failure::Other(format!("notes folder not found: {}", folder.display()))
            });
    }
    let cwd = std::env::current_dir().map_err(|e| Failure::Other(e.to_string()))?;
    if let Some(dir) = cwd.ancestors().find(|d| d.join(".aether").is_dir()) {
        return Ok(dir.to_path_buf());
    }
    app_notes_folder().ok_or_else(|| {
        Failure::Other(
            "no notes folder: pass --folder, run inside a notes folder, or open one in the app"
                .to_string(),
        )
    })
}

/// The notes folder open in the app, from `{APP_DATA}/config.json`.
fn app_notes_folder() -> Option<PathBuf> {
    let config = dirs::data_dir()?.join(APP_IDENTIFIER).join("config.json");
    let config: Value = serde_json::from_str(&std::fs::read_to_string(config).ok()?).ok()?;
    let folder = PathBuf::from(config["notes_folder"].as_str()?);
    folder.is_dir().then_some(folder)
}

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn depth(id: &str) -> usize {
    id.matches('/').count()
}

fn parent_of(id: &str) -> &str {
    id.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn list(folder: &Folder, under: Option<&str>) -> Result<Report, Failure> {
    let mut pages = folder.pages();
    let base = match under {
        Some(id) => {
            folder.read(id)?;
            pages.retain(|p| p.id.starts_with(&format!("{id}/")));
            depth(id) + 1
        }
        None => 0,
    };
    let text = pages
        .iter()
        .map(|p| {
            let indent = "  ".repeat(depth(&p.id) - base);
            format!("{indent}{}  ({})\n", p.title, p.id)
        })
        .collect();
    let json = json!({
        "pages": pages
            .iter()
            .map(|p| json!({ "id": p.id, "title": p.title }))
            .collect::<Vec<_>>(),
    });
    Ok(Report { json, text })
}

/// The part of `line` around the first match of `query`, at most 200 characters.
fn snippet(line: &str, query: &str) -> String {
    const MAX: usize = 200;
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX {
        return line.to_string();
    }
    let lower = line.to_lowercase();
    let at = lower
        .find(&query.to_lowercase())
        .map_or(0, |byte| lower[..byte].chars().count());
    let start = at.saturating_sub(MAX / 4).min(chars.len() - MAX);
    let mut out: String = chars[start..start + MAX].iter().collect();
    if start > 0 {
        out.insert_str(0, "...");
    }
    if start + MAX < chars.len() {
        out.push_str("...");
    }
    out
}

fn search(folder: &Folder, query: &str, limit: usize) -> Report {
    let mut results = notes::search(&folder.root, &folder.ignored, query, usize::MAX);
    results.retain(|r| !folder.is_private(&r.id));
    results.truncate(limit);
    let results: Vec<_> = results
        .into_iter()
        .map(|r| (r.id, r.title, snippet(&r.preview, query)))
        .collect();
    let text = results
        .iter()
        .map(|(id, title, snippet)| format!("{title}  ({id})\n    {snippet}\n"))
        .collect();
    let json = json!({
        "results": results
            .iter()
            .map(|(id, title, snippet)| json!({ "id": id, "title": title, "snippet": snippet }))
            .collect::<Vec<_>>(),
    });
    Report { json, text }
}

fn read(folder: &Folder, id: &str) -> Result<Report, Failure> {
    let note = folder.read(id)?;
    let hash = hash(&note.content);
    let sub_pages: Vec<String> = folder
        .pages()
        .into_iter()
        .filter(|p| parent_of(&p.id) == id)
        .map(|p| p.id)
        .collect();
    let text = format!(
        "id: {}\ntitle: {}\nhash: {hash}\nsub-pages: {}\n\n{}",
        note.id,
        note.title,
        sub_pages.join(", "),
        note.content
    );
    let json = json!({
        "id": note.id,
        "title": note.title,
        "hash": hash,
        "markdown": note.content,
        "subPages": sub_pages,
    });
    Ok(Report { json, text })
}

fn run(cli: Cli) -> Result<Report, Failure> {
    let folder = Folder::open(cli.folder)?;
    match cli.command {
        Command::List { under } => list(&folder, under.as_deref()),
        Command::Search { query, limit } => Ok(search(&folder, &query.join(" "), limit)),
        Command::Read { page } => read(&folder, &page),
    }
}

fn fail(failure: &Failure, as_json: bool) -> ExitCode {
    eprintln!("aether: {}", failure.message());
    if as_json {
        let error = json!({ "error": { "code": failure.code(), "message": failure.message() } });
        println!("{error}");
    }
    ExitCode::from(failure.exit_code())
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) if !e.use_stderr() => {
            // --help and --version
            let _ = e.print();
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            // clap exits 2 on usage errors, which means "not found" here.
            let as_json = std::env::args().any(|a| a == "--json");
            if !as_json {
                let _ = e.print();
                return ExitCode::from(1);
            }
            let rendered = e.render().to_string();
            let first = rendered.lines().next().unwrap_or_default();
            let message = first.strip_prefix("error: ").unwrap_or(first).to_string();
            return fail(&Failure::Invalid(message), true);
        }
    };
    let as_json = cli.json;
    match run(cli) {
        Ok(report) if as_json => {
            println!("{}", report.json);
            ExitCode::SUCCESS
        }
        Ok(report) => {
            print!("{}", report.text);
            ExitCode::SUCCESS
        }
        Err(failure) => fail(&failure, as_json),
    }
}
