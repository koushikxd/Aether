use anyhow::Result;
use base64::Engine;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tantivy::collector::TopDocs;
use tantivy::query::PhrasePrefixQuery;
use tantivy::schema::*;
use tantivy::snippet::SnippetGenerator;
use tantivy::tokenizer::TokenStream;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Score};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl};
use tauri::webview::WebviewWindowBuilder;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub mod agent_git;
mod export;
mod git;
mod merge;
pub mod install;
pub mod notes;
mod notion_import;
mod relink;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod vault;
#[cfg(test)]
mod vault_tests;

// Note metadata for list display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliStatus {
    pub installed: bool,
    pub path: Option<String>,
}

// Full note content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub path: String,
    pub modified: i64,
}

// Theme color customization
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub bg: Option<String>,
    pub bg_secondary: Option<String>,
    pub bg_muted: Option<String>,
    pub bg_emphasis: Option<String>,
    pub text: Option<String>,
    pub text_muted: Option<String>,
    pub text_inverse: Option<String>,
    pub border: Option<String>,
    pub accent: Option<String>,
}

// Theme settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    pub mode: String, // "light" | "dark" | "system"
    pub custom_light_colors: Option<ThemeColors>,
    pub custom_dark_colors: Option<ThemeColors>,
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            mode: "system".to_string(),
            custom_light_colors: None,
            custom_dark_colors: None,
        }
    }
}

// Editor font settings (simplified)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorFontSettings {
    pub base_font_family: Option<String>, // "system-sans" | "serif" | "monospace"
    pub base_font_size: Option<f32>,      // in px, default 16
    pub bold_weight: Option<i32>,         // 600, 700, 800 for headings and bold
    pub line_height: Option<f32>,         // default 1.6
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextDirection {
    Auto,
    Ltr,
    Rtl,
}

// App config (stored in app data directory - just the notes folder path)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub notes_folder: Option<String>,
}

// Per-folder settings (stored in .aether/settings.json within notes folder)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    pub theme: ThemeSettings,
    #[serde(rename = "editorFont")]
    pub editor_font: Option<EditorFontSettings>,
    #[serde(rename = "gitEnabled")]
    pub git_enabled: Option<bool>,
    #[serde(rename = "pinnedNoteIds")]
    pub pinned_note_ids: Option<Vec<String>>,
    #[serde(rename = "textDirection")]
    pub text_direction: Option<TextDirection>,
    #[serde(rename = "editorWidth")]
    pub editor_width: Option<String>,
    #[serde(rename = "defaultNoteName")]
    pub default_note_name: Option<String>,
    #[serde(rename = "interfaceZoom")]
    pub interface_zoom: Option<f32>,
    #[serde(rename = "customEditorWidthPx")]
    pub custom_editor_width_px: Option<u32>,
    /// Custom sidebar width in px; `None` means the default width is used.
    #[serde(rename = "sidebarWidthPx")]
    pub sidebar_width_px: Option<u32>,
    #[serde(rename = "ollamaModel")]
    pub ollama_model: Option<String>,
    #[serde(rename = "ignoredPatterns")]
    pub ignored_patterns: Option<Vec<String>>,
    #[serde(rename = "customColorsLight")]
    pub custom_colors_light: Option<std::collections::HashMap<String, String>>,
    #[serde(rename = "customColorsDark")]
    pub custom_colors_dark: Option<std::collections::HashMap<String, String>>,
}

// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub modified: i64,
    pub score: f32,
}

// AI execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

// File watcher state
pub struct FileWatcherState {
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
}

// Tantivy search index state
pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    #[allow(dead_code)]
    schema: Schema,
    id_field: Field,
    title_field: Field,
    content_field: Field,
    modified_field: Field,
}

impl SearchIndex {
    fn new(index_path: &PathBuf) -> Result<Self> {
        // Build schema
        let mut schema_builder = Schema::builder();
        let id_field = schema_builder.add_text_field("id", STRING | STORED);
        let title_field = schema_builder.add_text_field("title", TEXT | STORED);
        let content_field = schema_builder.add_text_field("content", TEXT | STORED);
        let modified_field = schema_builder.add_i64_field("modified", INDEXED | STORED);
        let schema = schema_builder.build();

        // Create or open index
        std::fs::create_dir_all(index_path)?;
        let index = Index::create_in_dir(index_path, schema.clone())
            .or_else(|_| Index::open_in_dir(index_path))?;

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let writer = index.writer(50_000_000)?; // 50MB buffer

        Ok(Self {
            index,
            reader,
            writer: Mutex::new(writer),
            schema,
            id_field,
            title_field,
            content_field,
            modified_field,
        })
    }

    fn index_note(&self, id: &str, title: &str, content: &str, modified: i64) -> Result<()> {
        let mut writer = self.writer.lock().expect("search writer mutex");

        // Delete existing document with this ID
        let id_term = tantivy::Term::from_field_text(self.id_field, id);
        writer.delete_term(id_term);

        // Add new document
        writer.add_document(doc!(
            self.id_field => id,
            self.title_field => title,
            self.content_field => content,
            self.modified_field => modified,
        ))?;

        writer.commit()?;
        Ok(())
    }

    fn delete_note(&self, id: &str) -> Result<()> {
        let mut writer = self.writer.lock().expect("search writer mutex");
        let id_term = tantivy::Term::from_field_text(self.id_field, id);
        writer.delete_term(id_term);
        writer.commit()?;
        Ok(())
    }

    /// Moves the entries of notes that moved to their new ids, in one commit.
    fn reindex(&self, notes_root: &Path, notes: &[relink::Moved]) -> Result<()> {
        let mut writer = self.writer.lock().expect("search writer mutex");
        for note in notes {
            let old_id = note.old_path.strip_suffix(".md").unwrap_or(&note.old_path);
            let id = note.new_path.strip_suffix(".md").unwrap_or(&note.new_path);
            writer.delete_term(tantivy::Term::from_field_text(self.id_field, old_id));
            let modified = std::fs::metadata(dir_from_id(notes_root, &note.new_path))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            writer.add_document(doc!(
                self.id_field => id,
                self.title_field => extract_title(&note.markdown),
                self.content_field => note.markdown.as_str(),
                self.modified_field => modified,
            ))?;
        }
        writer.commit()?;
        Ok(())
    }

    /// Splits text into index terms. Title and content are both TEXT fields,
    /// so they share this tokenizer.
    fn tokens(&self, text: &str) -> Result<Vec<String>> {
        let mut tokenizer = self.index.tokenizer_for_field(self.content_field)?;
        let mut stream = tokenizer.token_stream(text);
        let mut tokens = Vec::new();
        while let Some(token) = stream.next() {
            tokens.push(token.text.clone());
        }
        Ok(tokens)
    }

    fn search(&self, query_str: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let searcher = self.reader.searcher();
        let words = self.tokens(query_str)?;
        let Some(partial) = words.last() else {
            return Ok(Vec::new());
        };
        // The words must appear in order and the last one may be partial.
        // A single word becomes a pure prefix match.
        let phrase_prefix = |field| {
            let mut query =
                PhrasePrefixQuery::new(words.iter().map(|w| Term::from_field_text(field, w)).collect());
            // The default tries only the first 50 completions per segment, which
            // drops real matches for a short last word. Tantivy preallocates this many.
            query.set_max_expansions(1_000);
            query
        };
        let top = TopDocs::with_limit(limit).order_by_score();

        // Title hits first, then body hits not already listed.
        let mut top_docs = searcher.search(&phrase_prefix(self.title_field), &top)?;
        for hit in searcher.search(&phrase_prefix(self.content_field), &top)? {
            if top_docs.len() < limit && !top_docs.iter().any(|(_, address)| *address == hit.1) {
                top_docs.push(hit);
            }
        }

        let mut results = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address)?;

            let id = doc
                .get_first(self.id_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let title = doc
                .get_first(self.title_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let content = doc
                .get_first(self.content_field)
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let modified = doc
                .get_first(self.modified_field)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            // Snippets score fragments by term count, so a line repeating one
            // word can beat the match. Use the first line holding the phrase.
            let full_words = &words[..words.len() - 1];
            let line = content
                .lines()
                .find(|line| {
                    self.tokens(line).is_ok_and(|tokens| {
                        tokens.windows(words.len()).any(|window| {
                            window[..full_words.len()] == *full_words
                                && window[full_words.len()].starts_with(partial.as_str())
                        })
                    })
                })
                .unwrap_or(content);
            // The snippet only highlights whole terms, and the query reports
            // only its full words, so add this line's completions of the
            // partial last word.
            let terms: BTreeMap<String, Score> = self
                .tokens(line)?
                .into_iter()
                .filter(|token| words.contains(token) || token.starts_with(partial.as_str()))
                .map(|token| (token, 1.0))
                .collect();
            let tokenizer = self.index.tokenizer_for_field(self.content_field)?;
            let snippet =
                SnippetGenerator::new(terms, tokenizer, self.content_field, 150).snippet(line);
            // Empty when only the title matched and the content lacks it, e.g. "Untitled".
            let preview = if snippet.is_empty() {
                generate_preview(content)
            } else {
                snippet.fragment().to_string()
            };

            results.push(SearchResult {
                id,
                title,
                preview,
                modified,
                score,
            });
        }

        Ok(results)
    }

    fn rebuild_index(&self, notes_folder: &PathBuf, ignored_dirs: &[String]) -> Result<()> {
        let mut writer = self.writer.lock().expect("search writer mutex");
        writer.delete_all_documents()?;

        if notes_folder.exists() {
            use walkdir::WalkDir;
            for entry in WalkDir::new(notes_folder)
                .max_depth(10)
                .into_iter()
                .filter_entry(|e| is_visible_notes_entry(e, ignored_dirs))
                .flatten()
            {
                let file_path = entry.path();
                if !file_path.is_file() {
                    continue;
                }
                if let Some(id) = id_from_abs_path(notes_folder, file_path, ignored_dirs) {
                    if let Ok(content) = std::fs::read_to_string(file_path) {
                        let modified = entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);

                        let title = extract_title(&content);

                        writer.add_document(doc!(
                            self.id_field => id.as_str(),
                            self.title_field => title,
                            self.content_field => content.as_str(),
                            self.modified_field => modified,
                        ))?;
                    }
                }
            }
        }

        writer.commit()?;
        Ok(())
    }
}

// App state with improved structure
pub struct AppState {
    pub app_config: RwLock<AppConfig>,  // notes_folder path (stored in app data)
    pub settings: RwLock<Settings>,      // per-folder settings (stored in .aether/)
    pub notes_cache: RwLock<HashMap<String, NoteMetadata>>,
    pub file_watcher: Mutex<Option<FileWatcherState>>,
    pub search_index: Mutex<Option<SearchIndex>>,
    pub debounce_map: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    pub key_store: Arc<dyn vault::KeyStore>,
    /// Held by all git work, so the app's and the agent CLI's never interleave.
    pub git_lock: Arc<Mutex<()>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            app_config: RwLock::new(AppConfig::default()),
            settings: RwLock::new(Settings::default()),
            notes_cache: RwLock::new(HashMap::new()),
            file_watcher: Mutex::new(None),
            search_index: Mutex::new(None),
            debounce_map: Arc::new(Mutex::new(HashMap::new())),
            key_store: vault::default_store(),
            git_lock: Arc::default(),
        }
    }
}

// Utility: Sanitize filename from title
fn sanitize_filename(title: &str) -> String {
    let sanitized: String = title
        .chars()
        .filter(|c| *c != '\u{00A0}' && *c != '\u{FEFF}')
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();

    let trimmed = sanitized.trim();
    if trimmed.is_empty() || is_effectively_empty(trimmed) {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn ordinal_suffix(day: u32) -> &'static str {
    match (day % 100, day % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    }
}

/// Expands template tags in a note name template using local timezone
fn expand_note_name_template(template: &str) -> String {
    use chrono::{Datelike, Local};

    let mut result = template.to_string();

    // Get current time in local timezone
    let now = Local::now();

    // Timestamp tag (Unix timestamp)
    result = result.replace("{timestamp}", &now.timestamp().to_string());

    // Date tags
    result = result.replace("{date}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{year}", &now.format("%Y").to_string());
    result = result.replace("{month}", &now.format("%m").to_string());
    result = result.replace("{day}", &now.format("%d").to_string());

    // Text-based date tags (English, locale-independent)
    result = result.replace("{monthName}", &now.format("%B").to_string());
    result = result.replace("{monthShort}", &now.format("%b").to_string());
    result = result.replace("{weekday}", &now.format("%A").to_string());
    result = result.replace("{weekdayShort}", &now.format("%a").to_string());
    let day_num = now.day();
    result = result.replace(
        "{dayOrdinal}",
        &format!("{}{}", day_num, ordinal_suffix(day_num)),
    );

    // Time tags (use dash instead of colon for filename safety)
    result = result.replace("{time}", &now.format("%H-%M-%S").to_string());

    // Note: {counter} is handled in create_note function

    result
}

/// Extracts a display title from a note ID (filename)
fn extract_title_from_id(id: &str) -> String {
    // Get last path component (filename)
    let filename = id.rsplit('/').next().unwrap_or(id);

    // Convert to display title (replace dashes/underscores with spaces)
    let title = filename.replace(['-', '_'], " ");

    // Title case
    title
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().to_string() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// Utility: Check if a string is effectively empty
fn is_effectively_empty(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_whitespace() || c == '\u{00A0}' || c == '\u{FEFF}')
}

/// Strip YAML frontmatter (leading `---` ... `---` block) from content.
fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        // Find the closing --- (skip the opening line)
        if let Some(rest) = trimmed.strip_prefix("---") {
            if let Some(end) = rest.find("\n---") {
                // Skip past closing --- and the newline after it (handle CRLF)
                let after_close = &rest[end + 4..];
                return after_close
                    .strip_prefix("\r\n")
                    .or_else(|| after_close.strip_prefix('\n'))
                    .unwrap_or(after_close);
            }
        }
    }
    content
}

// Utility: Extract title from markdown content
fn extract_title(content: &str) -> String {
    let body = strip_frontmatter(content);
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            let title = title.trim();
            if !is_effectively_empty(title) {
                return title.to_string();
            }
        }
        if !is_effectively_empty(trimmed) {
            return trimmed.chars().take(50).collect();
        }
    }
    "Untitled".to_string()
}

// Utility: Generate preview from content (strip markdown formatting)
fn generate_preview(content: &str) -> String {
    let body = strip_frontmatter(content);
    // Skip the first line (title), find first non-empty line
    for line in body.lines().skip(1) {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            let stripped = strip_markdown(trimmed);
            if !stripped.is_empty() {
                return stripped.chars().take(100).collect();
            }
        }
    }
    String::new()
}

static IMAGE_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"!\[([^\]]*)\]\([^)]+\)").unwrap());
static LINK_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());
static LIST_MARKER_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^(\s*[-+*]|\s*\d+\.)\s+").unwrap());

// Strip common markdown formatting from text
fn strip_markdown(text: &str) -> String {
    let mut result = text.to_string();

    // Remove heading markers (##, ###, etc.)
    let trimmed = result.trim_start();
    if trimmed.starts_with('#') {
        result = trimmed.trim_start_matches('#').trim_start().to_string();
    }

    // Remove strikethrough (~~text~~) - before other markers
    while let Some(start) = result.find("~~") {
        if let Some(end) = result[start + 2..].find("~~") {
            let inner = &result[start + 2..start + 2 + end];
            result = format!("{}{}{}", &result[..start], inner, &result[start + 4 + end..]);
        } else {
            break;
        }
    }

    // Remove bold (**text** or __text__) - before italic
    while let Some(start) = result.find("**") {
        if let Some(end) = result[start + 2..].find("**") {
            let inner = &result[start + 2..start + 2 + end];
            result = format!("{}{}{}", &result[..start], inner, &result[start + 4 + end..]);
        } else {
            break;
        }
    }
    while let Some(start) = result.find("__") {
        if let Some(end) = result[start + 2..].find("__") {
            let inner = &result[start + 2..start + 2 + end];
            result = format!("{}{}{}", &result[..start], inner, &result[start + 4 + end..]);
        } else {
            break;
        }
    }

    // Remove inline code (`code`)
    while let Some(start) = result.find('`') {
        if let Some(end) = result[start + 1..].find('`') {
            let inner = &result[start + 1..start + 1 + end];
            result = format!("{}{}{}", &result[..start], inner, &result[start + 2 + end..]);
        } else {
            break;
        }
    }

    // Remove images ![alt](url) - must come before links
    result = IMAGE_RE.replace_all(&result, "$1").to_string();

    // Remove links [text](url)
    result = LINK_RE.replace_all(&result, "$1").to_string();

    // Remove italic (*text* or _text_) - simple approach after bold is removed
    // Match *text* where text doesn't contain *
    while let Some(start) = result.find('*') {
        if let Some(end) = result[start + 1..].find('*') {
            if end > 0 {
                let inner = &result[start + 1..start + 1 + end];
                result = format!("{}{}{}", &result[..start], inner, &result[start + 2 + end..]);
            } else {
                break;
            }
        } else {
            break;
        }
    }
    // Match _text_ where text doesn't contain _
    while let Some(start) = result.find('_') {
        if let Some(end) = result[start + 1..].find('_') {
            if end > 0 {
                let inner = &result[start + 1..start + 1 + end];
                result = format!("{}{}{}", &result[..start], inner, &result[start + 2 + end..]);
            } else {
                break;
            }
        } else {
            break;
        }
    }

    // Remove task list markers
    result = result
        .replace("- [ ] ", "")
        .replace("- [x] ", "")
        .replace("- [X] ", "");

    // Remove list markers at start (-, *, +, 1.)
    result = LIST_MARKER_RE.replace(&result, "").to_string();

    result.trim().to_string()
}

/// Directories to exclude from note discovery and ID resolution (app-internal, always excluded).
const EXCLUDED_DIRS: &[&str] = &[".git", ".aether", ".obsidian", ".trash", "assets"];

/// Default user-configurable directories to ignore (common build/dependency folders).
const DEFAULT_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    "coverage",
    ".svn",
    ".hg",
    "bower_components",
    ".turbo",
    ".parcel-cache",
];

/// Get the effective ignored directories from settings (or defaults if not customized).
fn get_effective_ignored_dirs(settings: &Settings) -> Vec<String> {
    settings.ignored_patterns.clone().unwrap_or_else(|| {
        DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect()
    })
}

/// An app folder. Compared without case, because on a case-insensitive file
/// system `Assets/` is the `assets/` folder.
fn is_reserved_dir(name: &str) -> bool {
    EXCLUDED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// A folder that holds no notes: an app folder or a user-ignored one.
fn is_hidden_dir(name: &str, ignored_dirs: &[String]) -> bool {
    is_reserved_dir(name) || ignored_dirs.iter().any(|d| d == name)
}

/// Filter for WalkDir: skips excluded and user-ignored directories.
fn is_visible_notes_entry(entry: &walkdir::DirEntry, ignored_dirs: &[String]) -> bool {
    if entry.file_type().is_dir() {
        return !is_hidden_dir(entry.file_name().to_str().unwrap_or(""), ignored_dirs);
    }
    true
}

/// Convert an absolute file path to a note ID (relative path from notes root, no .md extension, POSIX separators).
/// Returns None if the path is outside the root, not a .md file, or in an excluded/ignored directory.
fn id_from_abs_path(notes_root: &Path, file_path: &Path, ignored_dirs: &[String]) -> Option<String> {
    let rel = file_path.strip_prefix(notes_root).ok()?;

    // Skip files inside excluded or ignored directories.
    // Only block specific known dirs so that dot-prefixed *files* like ".foo.md" are still visible.
    for component in rel.parent().unwrap_or(Path::new("")).components() {
        if let std::path::Component::Normal(name) = component {
            let name_str = name.to_str()?;
            if is_hidden_dir(name_str, ignored_dirs) {
                return None;
            }
        }
    }

    // Must be a .md file
    if file_path.extension()?.to_str()? != "md" {
        return None;
    }

    // Build ID: relative path without .md suffix, using POSIX separators.
    // Strip .md by converting to string and trimming (avoids with_extension
    // which breaks on stems containing dots like "meeting.2024-01-15.md").
    let rel_str = rel.to_str()?;
    let id = rel_str.strip_suffix(".md")?.replace(std::path::MAIN_SEPARATOR, "/");

    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Convert a note ID to an absolute file path. Validates against path traversal.
fn abs_path_from_id(notes_root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.contains('\\') {
        return Err("Invalid note ID: backslashes not allowed".to_string());
    }

    let rel = Path::new(id);

    for component in rel.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Invalid note ID: parent directory references not allowed".to_string());
            }
            std::path::Component::CurDir => {
                return Err("Invalid note ID: current directory references not allowed".to_string());
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err("Invalid note ID: absolute paths not allowed".to_string());
            }
            _ => {}
        }
    }

    // Append ".md" via OsString to avoid with_extension replacing dots in stems
    // (e.g. "meeting.2024-01-15" would become "meeting.md" with with_extension)
    let joined = notes_root.join(rel);
    let mut file_path_os = joined.into_os_string();
    file_path_os.push(".md");
    let file_path = PathBuf::from(file_path_os);

    if !file_path.starts_with(notes_root) {
        return Err("Invalid note ID: path escapes notes folder".to_string());
    }

    Ok(file_path)
}

// Get app config file path (in app data directory)
fn get_app_config_path(app: &AppHandle) -> Result<PathBuf> {
    let app_data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data)?;
    Ok(app_data.join("config.json"))
}

// Get per-folder settings file path (in .aether/ within notes folder)
fn get_settings_path(notes_folder: &str) -> PathBuf {
    let aether_dir = PathBuf::from(notes_folder).join(".aether");
    std::fs::create_dir_all(&aether_dir).ok();
    aether_dir.join("settings.json")
}

// Get search index path
fn get_search_index_path(app: &AppHandle) -> Result<PathBuf> {
    let app_data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data)?;
    Ok(app_data.join("search_index"))
}

// Load app config from disk (notes folder path)
fn load_app_config(app: &AppHandle) -> AppConfig {
    let path = match get_app_config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };

    if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

// Save app config to disk
fn save_app_config(app: &AppHandle, config: &AppConfig) -> Result<()> {
    let path = get_app_config_path(app)?;
    let content = serde_json::to_string_pretty(config)?;
    std::fs::write(path, content)?;
    Ok(())
}

// Load per-folder settings from disk
fn load_settings(notes_folder: &str) -> Settings {
    let path = get_settings_path(notes_folder);

    let mut settings: Settings = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    } else {
        Settings::default()
    };
    if let Some(pins) = settings.pinned_note_ids.as_mut() {
        for id in vault::private_pins(Path::new(notes_folder)) {
            if !pins.contains(&id) {
                pins.push(id);
            }
        }
    }
    settings
}

/// Takes in a settings file another program (the CLI) wrote, and returns
/// whether the settings in memory changed. A file that does not parse, as one
/// caught mid-write, is skipped.
fn reload_settings(settings: &RwLock<Settings>, notes_folder: &str) -> bool {
    let parses = std::fs::read_to_string(get_settings_path(notes_folder))
        .is_ok_and(|text| serde_json::from_str::<Settings>(&text).is_ok());
    if !parses {
        return false;
    }
    let fresh = load_settings(notes_folder);
    let mut settings = settings.write().expect("settings write lock");
    if serde_json::to_value(&*settings).ok() == serde_json::to_value(&fresh).ok() {
        return false;
    }
    *settings = fresh;
    true
}

// Save per-folder settings to disk, without the pins of private pages
fn save_settings(notes_folder: &str, settings: &Settings) -> Result<()> {
    let path = get_settings_path(notes_folder);
    let mut settings = settings.clone();
    if let Some(pins) = &settings.pinned_note_ids {
        let public =
            vault::keep_private_pins(Path::new(notes_folder), pins).map_err(anyhow::Error::msg)?;
        settings.pinned_note_ids = Some(public);
    }
    let content = serde_json::to_string_pretty(&settings)?;
    std::fs::write(path, content)?;
    Ok(())
}

/// Re-indexes the notes that moved. The file watcher re-indexes the other
/// notes whose links changed.
fn reindex_moved(state: &AppState, notes_root: &Path, moved: &[relink::Moved]) {
    if let Some(index) = state.search_index.lock().expect("search index mutex").as_ref() {
        if let Err(e) = index.reindex(notes_root, moved) {
            eprintln!("Failed to update the search index after a move: {e}");
        }
    }
}

/// The folder at note id or folder path `rel`.
fn dir_from_id(notes_root: &Path, rel: &str) -> PathBuf {
    notes_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// The sub-page folder of note `id` (`Page/` next to `Page.md`), when it has
/// one. App and ignored folders never are one, and the name must match
/// exactly, as in the sidebar: on a case-insensitive file system `page/` is a
/// plain folder next to `Page.md`.
fn sub_page_dir(notes_root: &Path, id: &str, ignored_dirs: &[String]) -> Option<PathBuf> {
    let dir = dir_from_id(notes_root, id);
    let name = dir.file_name()?;
    if !dir.is_dir() || is_hidden_dir(&name.to_string_lossy(), ignored_dirs) {
        return None;
    }
    has_exact_name(&dir).then_some(dir)
}

/// Whether `path` exists under exactly its name: on a case-insensitive file
/// system `page.md` also finds `Page.md`.
fn has_exact_name(path: &Path) -> bool {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    std::fs::read_dir(parent).is_ok_and(|mut siblings| {
        siblings.any(|entry| entry.is_ok_and(|e| e.file_name() == name))
    })
}

/// The folder of note `id` when it is a bare page: a folder with no
/// `id.md`, as Finder, a git clone, or another app can leave. A bare page
/// reads as a page holding only its title, and gets its file on first save.
fn bare_page_dir(notes_root: &Path, id: &str, ignored_dirs: &[String]) -> Option<PathBuf> {
    if abs_path_from_id(notes_root, id).ok()?.exists() {
        return None;
    }
    sub_page_dir(notes_root, id, ignored_dirs)
}

fn bare_page_markdown(id: &str) -> String {
    format!("# {}\n", id.rsplit('/').next().unwrap_or(id))
}

/// Writes the file of note `id` when it is a bare page, for actions that
/// need one.
fn create_bare_page_file(
    notes_root: &Path,
    id: &str,
    ignored_dirs: &[String],
) -> Result<(), String> {
    if bare_page_dir(notes_root, id, ignored_dirs).is_some() {
        std::fs::write(abs_path_from_id(notes_root, id)?, bare_page_markdown(id))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn modified_secs(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Whether note `id` would take the name of an existing note, or of a folder
/// it would then pass off as its sub-pages. `own` holds the renamed note's
/// file and sub-page folder, which a case-only rename finds under the new
/// name on a case-insensitive file system.
fn note_name_taken(notes_root: &Path, id: &str, own: &[&Path]) -> bool {
    let Ok(file) = abs_path_from_id(notes_root, id) else {
        return false;
    };
    [file, dir_from_id(notes_root, id)].iter().any(|path| {
        path.exists() && !own.iter().any(|o| same_file::is_same_file(path, o).unwrap_or(false))
    })
}

/// Renames page file `from` to `to` and its sub-page folder, the folder
/// first. When the file cannot follow, the folder goes back, so a failure
/// leaves both where they were.
fn rename_page(from: &Path, to: &Path, sub_pages: Option<(&Path, &Path)>) -> std::io::Result<()> {
    if let Some((dir_from, dir_to)) = sub_pages {
        rename_path(dir_from, dir_to)?;
    }
    rename_path(from, to).inspect_err(|_| {
        if let Some((dir_from, dir_to)) = sub_pages {
            let _ = rename_path(dir_to, dir_from);
        }
    })
}

/// `std::fs::rename`, through a temporary name when only the case changes,
/// which some case-insensitive file systems need.
fn rename_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let case_only = from != to
        && from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
    if !case_only {
        return std::fs::rename(from, to);
    }
    let mut temp = to.as_os_str().to_owned();
    temp.push(".aether-rename");
    std::fs::rename(from, &temp)?;
    std::fs::rename(&temp, to).inspect_err(|_| {
        let _ = std::fs::rename(&temp, from);
    })
}

/// Removes `folder` when it is an empty sub-page folder, so its page becomes
/// a plain note again. Plain folders stay, even when empty.
fn remove_empty_sub_page_dir(notes_root: &Path, folder: &str) {
    let is_page = !folder.is_empty()
        && abs_path_from_id(notes_root, folder).is_ok_and(|page| page.is_file());
    if is_page {
        // Fails, and keeps the folder, while anything is left in it.
        let _ = std::fs::remove_dir(dir_from_id(notes_root, folder));
    }
}

fn parent_folder(id: &str) -> &str {
    id.rsplit_once('/').map_or("", |(parent, _)| parent)
}

/// Where note `id` is after `moves`.
fn moved_id(id: &str, moves: &[relink::Move]) -> String {
    let path = relink::after_moves(&format!("{id}.md"), moves);
    path.strip_suffix(".md").unwrap_or(&path).to_string()
}

/// Points pinned ids and cached notes at their new ids after `moves`.
fn follow_moved_ids(state: &AppState, notes_folder: &str, moves: &[relink::Move]) {
    {
        let mut settings = state.settings.write().expect("settings write lock");
        if let Some(ref mut pinned) = settings.pinned_note_ids {
            let followed: Vec<String> = pinned.iter().map(|id| moved_id(id, moves)).collect();
            if followed != *pinned {
                *pinned = followed;
                let _ = save_settings(notes_folder, &settings);
            }
        }
    }
    let mut cache = state.notes_cache.write().expect("cache write lock");
    *cache = cache
        .drain()
        .map(|(id, mut meta)| {
            meta.id = moved_id(&id, moves);
            (meta.id.clone(), meta)
        })
        .collect();
}

/// Drops every note under `folder/` from the search index and cache.
fn forget_notes_under(state: &AppState, folder: &str) {
    let prefix = format!("{}/", folder);
    {
        let index = state.search_index.lock().expect("search index mutex");
        if let Some(ref search_index) = *index {
            let cache = state.notes_cache.read().expect("cache read lock");
            for note_id in cache.keys() {
                if note_id.starts_with(&prefix) {
                    let _ = search_index.delete_note(note_id);
                }
            }
        }
    }
    let mut cache = state.notes_cache.write().expect("cache write lock");
    cache.retain(|id, _| !id.starts_with(&prefix));
}

// Clean up old entries from debounce map (entries older than 5 seconds)
fn cleanup_debounce_map(map: &Mutex<HashMap<PathBuf, Instant>>) {
    let mut map = map.lock().expect("debounce map mutex");
    let now = Instant::now();
    map.retain(|_, last| now.duration_since(*last) < Duration::from_secs(5));
}

// Normalize notes folder path from plain paths and legacy file:// URIs.
fn normalize_notes_folder_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Notes folder path is empty".to_string());
    }

    if trimmed.starts_with("file://") {
        let parsed = url::Url::parse(trimmed)
            .map_err(|e| format!("Invalid file URL for notes folder: {}", e))?;
        return parsed
            .to_file_path()
            .map_err(|_| "Invalid file URL for notes folder".to_string());
    }

    Ok(PathBuf::from(trimmed))
}

/// Shared initialization logic for setting a notes folder.
/// Creates required directories, verifies write access, updates config/settings,
/// adds asset protocol scope, and rebuilds the search index.
fn initialize_notes_folder(app: &AppHandle, path_buf: &PathBuf, state: &AppState) -> Result<String, String> {
    let normalized_path = path_buf.to_string_lossy().into_owned();

    // Verify it's a valid directory
    if !path_buf.exists() {
        std::fs::create_dir_all(path_buf).map_err(|e| e.to_string())?;
    }

    // Create assets folder
    let assets = path_buf.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;

    // Create .aether config folder
    let aether_dir = path_buf.join(".aether");
    std::fs::create_dir_all(&aether_dir).map_err(|e| e.to_string())?;

    // Verify write access early to avoid later silent failures
    let write_test_path = aether_dir.join(".write-test");
    std::fs::write(&write_test_path, b"ok")
        .map_err(|e| format!("Notes folder is not writable: {}", e))?;
    let _ = std::fs::remove_file(&write_test_path);

    // Load per-folder settings (starts fresh with defaults if none exist)
    let settings = load_settings(&normalized_path);

    // Update app config
    {
        let mut app_config = state.app_config.write().expect("app_config write lock");
        app_config.notes_folder = Some(normalized_path.clone());
    }

    // Update settings in memory
    {
        let mut current_settings = state.settings.write().expect("settings write lock");
        *current_settings = settings;
    }

    if let Err(e) = vault::decrypt(path_buf, &ignored_dirs(state), state.key_store.as_ref()) {
        eprintln!("Failed to decrypt private pages: {e}");
    }

    // Save app config to disk
    {
        let app_config = state.app_config.read().expect("app_config read lock");
        save_app_config(app, &app_config).map_err(|e| e.to_string())?;
    }

    // Add notes folder to asset protocol scope so images can be served
    let _ = app.asset_protocol_scope().allow_directory(path_buf, true);

    // Initialize search index
    if let Ok(index_path) = get_search_index_path(app) {
        if let Ok(search_index) = SearchIndex::new(&index_path) {
            let ignored_dirs = {
                let settings = state.settings.read().expect("settings read lock");
                get_effective_ignored_dirs(&settings)
            };
            let _ = search_index.rebuild_index(path_buf, &ignored_dirs);
            let mut index = state.search_index.lock().expect("search index mutex");
            *index = Some(search_index);
        }
    }

    Ok(normalized_path)
}

// TAURI COMMANDS

#[tauri::command]
fn get_notes_folder(state: State<AppState>) -> Option<String> {
    state
        .app_config
        .read()
        .expect("app_config read lock")
        .notes_folder
        .clone()
}

#[tauri::command]
fn set_notes_folder(app: AppHandle, path: String, state: State<AppState>) -> Result<(), String> {
    let path_buf = normalize_notes_folder_path(&path)?;
    initialize_notes_folder(&app, &path_buf, &state)?;
    Ok(())
}

#[tauri::command]
async fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteMetadata>, String> {
    let folder = notes_folder(&state)?;
    let path = PathBuf::from(&folder);
    if !path.exists() {
        return Ok(vec![]);
    }
    let ignored = ignored_dirs(&state);
    let mut notes = tokio::task::spawn_blocking(move || notes::list(&path, &ignored))
        .await
        .map_err(|e| e.to_string())?;

    // Load pinned note IDs from settings
    let pinned_ids: HashSet<String> = {
        let settings = state.settings.read().expect("settings read lock");
        settings
            .pinned_note_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default()
    };

    // Sort: pinned notes first (by date), then unpinned notes (by date)
    notes.sort_by(|a, b| {
        let a_pinned = pinned_ids.contains(&a.id);
        let b_pinned = pinned_ids.contains(&b.id);

        match (a_pinned, b_pinned) {
            (true, false) => std::cmp::Ordering::Less,    // a pinned, b not -> a first
            (false, true) => std::cmp::Ordering::Greater, // b pinned, a not -> b first
            _ => b.modified.cmp(&a.modified),             // both same status -> sort by date (newest first)
        }
    });

    // Update cache efficiently
    {
        let mut cache = state.notes_cache.write().expect("cache write lock");
        cache.clear();
        for note in &notes {
            cache.insert(note.id.clone(), note.clone());
        }
    }

    Ok(notes)
}

#[tauri::command]
async fn read_note(id: String, state: State<'_, AppState>) -> Result<Note, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    let ignored = ignored_dirs(&state);
    tauri::async_runtime::spawn_blocking(move || notes::read(&root, &ignored, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteInfo {
    /// File birth time in Unix seconds, `None` when the platform does not record it.
    pub created: Option<i64>,
}

#[tauri::command]
async fn get_note_info(id: String, state: State<'_, AppState>) -> Result<NoteInfo, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };

    let root = PathBuf::from(&folder);
    let file_path = abs_path_from_id(&root, &id)?;
    let path = bare_page_dir(&root, &id, &ignored_dirs(&state)).unwrap_or(file_path);
    let metadata = fs::metadata(&path)
        .await
        .map_err(|_| "Note not found".to_string())?;

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    Ok(NoteInfo { created })
}

#[tauri::command]
async fn save_note(
    id: Option<String>,
    content: String,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    let ignored = ignored_dirs(&state);
    let folder = root.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        notes::save(&folder, &ignored, id.as_deref(), &content)
    })
    .await
    .map_err(|e| e.to_string())??;

    if saved.moves.is_empty() {
        let note = &saved.note;
        let index = state.search_index.lock().expect("search index mutex");
        if let Some(ref search_index) = *index {
            let _ = search_index.index_note(&note.id, &note.title, &note.content, note.modified);
        }
    } else {
        // A rename re-indexes the note with the notes that moved along
        follow_moved_ids(&state, &root.to_string_lossy(), &saved.moves);
        reindex_moved(&state, &root, &saved.moved);
    }
    Ok(saved.note)
}

#[tauri::command]
async fn delete_note(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };

    let folder_path = PathBuf::from(&folder);
    let file_path = abs_path_from_id(&folder_path, &id)?;
    if has_exact_name(&file_path) {
        fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }
    // A page takes its sub-pages with it, and a bare page is its folder.
    if let Some(sub_pages) = sub_page_dir(&folder_path, &id, &ignored_dirs(&state)) {
        forget_notes_under(&state, &id);
        fs::remove_dir_all(&sub_pages)
            .await
            .map_err(|e| e.to_string())?;
    }
    remove_empty_sub_page_dir(&folder_path, parent_folder(&id));
    vault::prune_marks(&folder_path, &ignored_dirs(&state))?;

    // Update search index
    {
        let index = state.search_index.lock().expect("search index mutex");
        if let Some(ref search_index) = *index {
            let _ = search_index.delete_note(&id);
        }
    }

    // Remove from cache
    {
        let mut cache = state.notes_cache.write().expect("cache write lock");
        cache.remove(&id);
    }

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubPageCounts {
    sub_pages: usize,
    other_files: usize,
}

/// What deleting note `id` takes along: the notes and the other files in its
/// sub-page folder.
#[tauri::command]
async fn sub_page_counts(id: String, state: State<'_, AppState>) -> Result<SubPageCounts, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    abs_path_from_id(&root, &id)?;
    let ignored = ignored_dirs(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut counts = SubPageCounts { sub_pages: 0, other_files: 0 };
        let Some(dir) = sub_page_dir(&root, &id, &ignored) else {
            return counts;
        };
        for entry in walkdir::WalkDir::new(dir).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            if id_from_abs_path(&root, entry.path(), &ignored).is_some() {
                counts.sub_pages += 1;
            } else {
                counts.other_files += 1;
            }
        }
        counts
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_note(target_folder: Option<String>, state: State<'_, AppState>) -> Result<Note, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };
    let folder_path = PathBuf::from(&folder);

    // A sub-page of a page named like a skipped folder would not show
    let ignored = ignored_dirs(&state);
    if let Some(hidden) = target_folder
        .iter()
        .flat_map(|f| f.split('/'))
        .find(|dir| is_hidden_dir(dir, &ignored))
    {
        return Err(format!(
            "The sidebar hides notes in a folder named \"{hidden}\". Rename the page first."
        ));
    }

    // Get template from settings (default "Untitled")
    let template = {
        let settings = state.settings.read().expect("settings read lock");
        settings
            .default_note_name
            .clone()
            .unwrap_or_else(|| "Untitled".to_string())
    };

    // Expand template tags
    let expanded = expand_note_name_template(&template);

    // Sanitize filename
    let sanitized = sanitize_filename(&expanded);

    // Prepend folder prefix if specified
    let sanitized = if let Some(ref folder_prefix) = target_folder {
        if folder_prefix.is_empty() {
            sanitized
        } else {
            format!("{}/{}", folder_prefix.trim_end_matches('/'), sanitized)
        }
    } else {
        sanitized
    };

    // Handle {counter} tag
    let has_counter = template.contains("{counter}");
    let base_id = if has_counter {
        sanitized.replace("{counter}", "1")
    } else {
        sanitized.clone()
    };

    let mut final_id = base_id.clone();
    let mut counter = if has_counter { 2 } else { 1 };

    // Ensure filename uniqueness
    while note_name_taken(&folder_path, &final_id, &[]) {
        if has_counter {
            final_id = sanitized.replace("{counter}", &counter.to_string());
        } else {
            final_id = format!("{}-{}", base_id, counter);
        }
        counter += 1;
    }

    // Extract display title from filename
    let display_title = extract_title_from_id(&final_id);

    // "Untitled" is a placeholder, not a title: the editor shows it over an empty title
    let content = if template == "Untitled" {
        String::new()
    } else {
        format!("# {}\n\n", display_title)
    };
    let file_path = abs_path_from_id(&folder_path, &final_id)?;

    // Create parent directories (for templates like {year}/{month}/{day})
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    fs::write(&file_path, &content)
        .await
        .map_err(|e| e.to_string())?;

    let modified = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Update search index
    {
        let index = state.search_index.lock().expect("search index mutex");
        if let Some(ref search_index) = *index {
            let _ = search_index.index_note(&final_id, &display_title, &content, modified);
        }
    }

    Ok(Note {
        id: final_id,
        title: display_title,
        content,
        path: file_path.to_string_lossy().into_owned(),
        modified,
    })
}

/// Validate a relative folder path against traversal attacks
fn validate_folder_path(path: &str) -> Result<(), String> {
    if path.contains('\\') {
        return Err("Invalid path: backslashes not allowed".to_string());
    }
    if path.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    let rel = Path::new(path);
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Path traversal not allowed".to_string());
            }
            std::path::Component::CurDir => {
                return Err("Invalid path: current directory references not allowed".to_string());
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err("Invalid path: absolute paths not allowed".to_string());
            }
            std::path::Component::Normal(name) => {
                if let Some(name_str) = name.to_str() {
                    if is_reserved_dir(name_str) {
                        return Err(format!("'{}' is a reserved folder name", name_str));
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn move_note(
    id: String,
    target_folder: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    let ignored = ignored_dirs(&state);
    let folder = root.clone();
    let (new_id, moves, moved) = tauri::async_runtime::spawn_blocking(move || {
        notes::move_page(&folder, &ignored, &id, &target_folder)
    })
    .await
    .map_err(|e| e.to_string())??;
    if !moves.is_empty() {
        follow_moved_ids(&state, &root.to_string_lossy(), &moves);
        reindex_moved(&state, &root, &moved);
    }
    Ok(new_id)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.read().expect("settings read lock").clone()
}

#[tauri::command]
fn update_settings(
    new_settings: Settings,
    state: State<AppState>,
) -> Result<(), String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone().ok_or("Notes folder not set")?
    };

    {
        let mut settings = state.settings.write().expect("settings write lock");
        *settings = new_settings;
    }

    let settings = state.settings.read().expect("settings read lock");
    save_settings(&folder, &settings).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_git_enabled(
    enabled: Option<bool>,
    expected_folder: String,
    state: State<AppState>,
) -> Result<(), String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        let folder = app_config.notes_folder.clone().ok_or("Notes folder not set")?;

        if folder != expected_folder {
            return Err("Notes folder changed".to_string());
        }

        folder
    };

    {
        let mut settings = state.settings.write().expect("settings write lock");
        settings.git_enabled = enabled;
    }

    let settings = state.settings.read().expect("settings read lock");
    save_settings(&folder, &settings).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    fs::write(&path, contents)
        .await
        .map_err(|_| "Failed to write file".to_string())
}

#[tauri::command]
fn preview_note_name(template: String) -> Result<String, String> {
    let expanded = expand_note_name_template(&template);
    let sanitized = sanitize_filename(&expanded);

    // Show first note name (with counter as 1 if present)
    let preview = if template.contains("{counter}") {
        sanitized.replace("{counter}", "1")
    } else {
        sanitized
    };

    Ok(preview)
}

// Preview mode: file content returned by read_file_direct / save_file_direct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub title: String,
    pub modified: i64,
}

/// Validate a file path for preview mode direct file operations.
/// Ensures the path is a markdown file and resolves symlinks.
fn validate_preview_path(path: &str) -> Result<PathBuf, String> {
    let file_path = PathBuf::from(path);

    // Must have a markdown extension
    match file_path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") => {}
        _ => return Err("Only .md and .markdown files are allowed".to_string()),
    }

    // Resolve symlinks to get the real path
    let canonical = file_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve file path: {}", e))?;

    Ok(canonical)
}

#[tauri::command]
async fn read_file_direct(path: String) -> Result<FileContent, String> {
    let canonical = validate_preview_path(&path)?;

    if !canonical.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let content = fs::read_to_string(&canonical)
        .await
        .map_err(|_| "Failed to read file".to_string())?;
    let metadata = fs::metadata(&canonical)
        .await
        .map_err(|_| "Failed to read metadata".to_string())?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let title = extract_title(&content);

    Ok(FileContent {
        path,
        content,
        title,
        modified,
    })
}

#[tauri::command]
async fn save_file_direct(path: String, content: String) -> Result<FileContent, String> {
    // For save, the file must already exist (we validate extension + path security)
    let canonical = validate_preview_path(&path)?;

    if !canonical.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    fs::write(&canonical, &content)
        .await
        .map_err(|_| "Failed to write file".to_string())?;

    let metadata = fs::metadata(&canonical)
        .await
        .map_err(|_| "Failed to read metadata".to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let title = extract_title(&content);

    Ok(FileContent {
        path,
        content,
        title,
        modified,
    })
}

#[tauri::command]
async fn import_file_to_folder(
    app: AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<NoteMetadata, String> {
    let source = validate_preview_path(&path)?;
    if !source.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };
    let folder_path = PathBuf::from(&folder);

    // Read the source file content
    let content = fs::read_to_string(&source)
        .await
        .map_err(|_| "Failed to read source file".to_string())?;

    // Derive the note ID from the title (H1 heading), falling back to filename
    let extracted_title = extract_title(&content);
    let base_name = if extracted_title.trim().is_empty() {
        source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    } else {
        extracted_title.trim().to_string()
    };
    let base_id = sanitize_filename(&base_name);

    // Atomically create the file and write content via the handle
    let mut final_id = base_id.clone();
    let mut counter = 1;
    loop {
        let candidate = abs_path_from_id(&folder_path, &final_id)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(mut file) => {
                if file.write_all(content.as_bytes()).await.is_err() {
                    // Clean up the empty file on write failure
                    let _ = fs::remove_file(&candidate).await;
                    return Err("Failed to write file".to_string());
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                final_id = format!("{}-{}", base_id, counter);
                counter += 1;
            }
            Err(_) => return Err("Failed to create file".to_string()),
        }
    };

    let modified = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Update search index
    {
        let index = state.search_index.lock().expect("search index mutex");
        if let Some(ref search_index) = *index {
            let _ = search_index.index_note(&final_id, &extracted_title, &content, modified);
        }
    }

    let preview = content
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");

    let metadata = NoteMetadata {
        id: final_id,
        title: extracted_title,
        preview,
        modified,
    };

    // Update notes cache so fallback search sees the imported note immediately
    {
        let mut cache = state.notes_cache.write().expect("cache write lock");
        cache.insert(metadata.id.clone(), metadata.clone());
    }

    // Tell the main window to select the imported note and focus it
    let _ = app.emit_to("main", "select-note", &metadata.id);
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_focus();
    }

    Ok(metadata)
}

#[tauri::command]
async fn search_notes(query: String, state: State<'_, AppState>) -> Result<Vec<SearchResult>, String> {
    let trimmed_query = query.trim().to_string();
    if trimmed_query.is_empty() {
        return Ok(vec![]);
    }

    // Check if search index is available and use it (scoped to drop lock before await)
    let indexed_result = {
        let index = state.search_index.lock().expect("search index mutex");
        (*index).as_ref().map(|search_index| {
            search_index.search(&trimmed_query, 20).map_err(|e| e.to_string())
        })
    };

    match indexed_result {
        Some(Ok(results)) if !results.is_empty() => Ok(results),
        Some(Ok(_)) => {
            // Tantivy can miss partial/fuzzy matches; fall back to substring search.
            fallback_search(&trimmed_query, &state).await
        }
        Some(Err(e)) => {
            eprintln!("Tantivy search error, falling back to substring search: {}", e);
            fallback_search(&trimmed_query, &state).await
        }
        None => {
            // Fallback to simple search if index not available
            fallback_search(&trimmed_query, &state).await
        }
    }
}

// Fallback search when Tantivy index isn't available - searches title and full content
async fn fallback_search(query: &str, state: &State<'_, AppState>) -> Result<Vec<SearchResult>, String> {
    let Ok(folder) = notes_folder(state) else {
        return Ok(vec![]);
    };
    let ignored = ignored_dirs(state);
    let query = query.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        notes::search(Path::new(&folder), &ignored, &query, 20)
    })
    .await
    .map_err(|e| e.to_string())
}

// File watcher event payload
#[derive(Clone, Serialize)]
struct FileChangeEvent {
    kind: String,
    path: String,
    changed_ids: Vec<String>,
}

fn setup_file_watcher(
    app: AppHandle,
    notes_folder: &str,
    debounce_map: Arc<Mutex<HashMap<PathBuf, Instant>>>,
) -> Result<FileWatcherState, String> {
    let folder_path = PathBuf::from(notes_folder);
    let notes_root = folder_path.clone();
    let settings_path = get_settings_path(notes_folder);
    let settings_folder = notes_folder.to_string();
    let app_handle = app.clone();

    let watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                for path in event.paths.iter() {
                    if *path == settings_path {
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            if reload_settings(&state.settings, &settings_folder) {
                                let _ = app_handle.emit("settings-changed", ());
                            }
                        }
                        continue;
                    }
                    // Read current ignored patterns from settings
                    let ignored_dirs = if let Some(state) = app_handle.try_state::<AppState>() {
                        let settings = state.settings.read().expect("settings read lock");
                        get_effective_ignored_dirs(&settings)
                    } else {
                        DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect()
                    };

                    let note_id = match id_from_abs_path(&notes_root, path, &ignored_dirs) {
                        Some(id) => id,
                        None => continue,
                    };

                    // Debounce with cleanup
                    {
                        let mut map = debounce_map.lock().expect("debounce map mutex");
                        let now = Instant::now();

                        if map.len() > 100 {
                            map.retain(|_, last| now.duration_since(*last) < Duration::from_secs(5));
                        }

                        if let Some(last) = map.get(path) {
                            if now.duration_since(*last) < Duration::from_millis(500) {
                                continue;
                            }
                        }
                        map.insert(path.clone(), now);
                    }

                    let kind = match event.kind {
                        notify::EventKind::Create(_) => "created",
                        notify::EventKind::Modify(_) => "modified",
                        notify::EventKind::Remove(_) => "deleted",
                        // Some backends emit Any for renames or unclassified changes
                        notify::EventKind::Any => "modified",
                        _ => continue,
                    };

                    // Update search index for external file changes
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        let index = state.search_index.lock().expect("search index mutex");
                        if let Some(ref search_index) = *index {
                            match kind {
                                "created" | "modified" => {
                                    match std::fs::read_to_string(path) {
                                        Ok(content) => {
                                            let title = extract_title(&content);
                                            let modified = std::fs::metadata(path)
                                                .ok()
                                                .and_then(|m| m.modified().ok())
                                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                                .map(|d| d.as_secs() as i64)
                                                .unwrap_or(0);
                                            let _ = search_index.index_note(&note_id, &title, &content, modified);
                                        }
                                        Err(_) => {
                                            // File gone between event and read — treat as deletion
                                            if !path.exists() {
                                                let _ = search_index.delete_note(&note_id);
                                            }
                                        }
                                    }
                                }
                                "deleted" => {
                                    let _ = search_index.delete_note(&note_id);
                                }
                                _ => {}
                            }
                        }
                    }

                    // Determine the actual kind for the frontend event
                    // (a "modified" event on a non-existent file is really a delete)
                    let effective_kind = if kind == "modified" && !path.exists() {
                        "deleted"
                    } else {
                        kind
                    };

                    let _ = app_handle.emit(
                        "file-change",
                        FileChangeEvent {
                            kind: effective_kind.to_string(),
                            path: path.to_string_lossy().into_owned(),
                            changed_ids: vec![note_id.clone()],
                        },
                    );
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let mut watcher = watcher;

    // Watch the notes folder recursively for .md files in subfolders
    watcher
        .watch(&folder_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(FileWatcherState { watcher })
}

#[tauri::command]
fn start_file_watcher(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };

    // Clean up debounce map before starting
    cleanup_debounce_map(&state.debounce_map);

    let watcher_state = setup_file_watcher(
        app,
        &folder,
        Arc::clone(&state.debounce_map),
    )?;

    let mut file_watcher = state.file_watcher.lock().expect("file watcher mutex");
    *file_watcher = Some(watcher_state);

    Ok(())
}

#[tauri::command]
fn copy_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// File extension for image bytes, judged by their leading signature.
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        [b'B', b'M', ..] => Some("bmp"),
        [b'I', b'I', b'*', 0, ..] | [b'M', b'M', 0, b'*', ..] => Some("tiff"),
        _ => None,
    }
}

#[tauri::command]
async fn save_clipboard_image(
    base64_data: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Guard against empty clipboard payload
    if base64_data.trim().is_empty() {
        return Err("Clipboard data is empty".to_string());
    }

    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };

    // Decode base64
    let image_data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|_| "Failed to decode base64 image data".to_string())?;

    // Guard against zero-byte files
    if image_data.is_empty() {
        return Err("Decoded image data is empty".to_string());
    }
    let extension = image_extension(&image_data).ok_or("Unsupported image type")?;

    // Create assets folder path
    let assets_dir = PathBuf::from(&folder).join("assets");
    fs::create_dir_all(&assets_dir)
        .await
        .map_err(|e| e.to_string())?;

    // Generate unique filename with timestamp
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut target_name = format!("screenshot-{}.{}", timestamp, extension);
    let mut counter = 1;
    let mut target_path = assets_dir.join(&target_name);

    while target_path.exists() {
        target_name = format!("screenshot-{}-{}.{}", timestamp, counter, extension);
        target_path = assets_dir.join(&target_name);
        counter += 1;
    }

    // Write the file
    fs::write(&target_path, &image_data)
        .await
        .map_err(|_| "Failed to write image".to_string())?;

    // Return relative path
    Ok(format!("assets/{}", target_name))
}

fn notes_folder(state: &AppState) -> Result<String, String> {
    let app_config = state.app_config.read().expect("app_config read lock");
    app_config
        .notes_folder
        .clone()
        .ok_or_else(|| "Notes folder not set".to_string())
}

/// The sanitized file name of `source` for `assets_dir`, with `-N` added
/// while the name is taken.
fn unique_asset_name(assets_dir: &Path, source: &Path) -> String {
    let stem = sanitize_filename(source.file_stem().and_then(|n| n.to_str()).unwrap_or("file"));
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let mut target_name = format!("{stem}{extension}");
    let mut counter = 1;
    while assets_dir.join(&target_name).exists() {
        target_name = format!("{stem}-{counter}{extension}");
        counter += 1;
    }
    target_name
}

/// Copies `source` into `<notes>/assets/` under its sanitized name, adding
/// `-N` while the name is taken. Returns `assets/<name>`.
async fn copy_into_assets(state: &AppState, source: &Path) -> Result<String, String> {
    let assets_dir = PathBuf::from(notes_folder(state)?).join("assets");

    fs::create_dir_all(&assets_dir)
        .await
        .map_err(|e| e.to_string())?;

    let target_name = unique_asset_name(&assets_dir, source);
    fs::copy(source, assets_dir.join(&target_name))
        .await
        .map_err(|_| "Failed to copy file".to_string())?;
    Ok(format!("assets/{target_name}"))
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "avif",
];

#[tauri::command]
async fn copy_image_to_assets(
    source_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err("Source image file does not exist".to_string());
    }

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .ok_or("Invalid file extension")?;

    if !IMAGE_EXTENSIONS.contains(&extension.to_lowercase().as_str()) {
        return Err("Only image files can be copied to assets".to_string());
    }

    copy_into_assets(&state, &source).await
}

/// Copies any file into the assets folder, for file attachments.
#[tauri::command]
async fn copy_file_to_assets(
    source_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("Only files can be attached".to_string());
    }
    copy_into_assets(&state, &source).await
}

/// The real path of `path` when it resolves, through any symlinks, to a file
/// in `<notes_root>/assets/`.
fn asset_file(notes_root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = Path::new(path).canonicalize();
    let assets = notes_root.join("assets").canonicalize();
    match (resolved, assets) {
        (Ok(path), Ok(assets)) if path.starts_with(&assets) && path.is_file() => Ok(path),
        _ => Err("Not a file in the assets folder".to_string()),
    }
}

/// Size in bytes of a file in `<notes>/assets/`, given its absolute path.
#[tauri::command]
async fn get_asset_size(path: String, state: State<'_, AppState>) -> Result<u64, String> {
    let path = asset_file(Path::new(&notes_folder(&state)?), &path)?;
    let meta = fs::metadata(&path).await.map_err(|e| e.to_string())?;
    Ok(meta.len())
}

/// Extensions of files that the OS runs, or that point it at something to run,
/// rather than opening them in an app.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "hta", "lnk", "url", "reg",
    "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "psm1", "jar", "app", "command", "tool",
    "terminal", "workflow", "action", "pkg", "mpkg", "sh", "bash", "zsh", "csh", "ksh", "fish",
    "py", "pyw", "pl", "rb", "desktop", "appimage", "run",
];

/// Absolute `path` when it is a file in `<notes_root>/assets/` that the OS
/// opens in an app rather than runs.
fn openable_asset(notes_root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = asset_file(notes_root, path)?;
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if EXECUTABLE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Aether won't open executable files. Reveal it in the folder instead.".to_string());
    }
    Ok(path)
}

/// Opens a file in `<notes>/assets/`, given its absolute path, in the OS's
/// default app for it.
#[tauri::command]
async fn open_asset(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = openable_asset(Path::new(&notes_folder(&state)?), &path)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| format!("Could not open the file: {e}"))
}

fn ignored_dirs(state: &AppState) -> Vec<String> {
    get_effective_ignored_dirs(&state.settings.read().expect("settings read lock"))
}

/// Zips a folder of notes (`""` for the whole notes folder) to `dest`,
/// without private pages unless `include_private`.
#[tauri::command]
async fn export_folder_zip(
    folder: String,
    dest: String,
    include_private: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !folder.is_empty() {
        validate_folder_path(&folder)?;
    }
    let root = PathBuf::from(notes_folder(&state)?);
    if !root.join(&folder).is_dir() {
        return Err("Folder not found".to_string());
    }
    let ignored = ignored_dirs(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let private = if include_private {
            vault::PrivateSet::default()
        } else {
            vault::current_private_set(&root, &ignored)?
        };
        export::export_folder(&root, &folder, &ignored, &private, Path::new(&dest))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Failed to export zip: {e}"))
}

/// Zips the note `id`, whose current content is `markdown`, with its
/// sub-pages and their assets, without private pages unless `include_private`.
#[tauri::command]
async fn export_note_zip(
    id: String,
    markdown: String,
    dest: String,
    include_private: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = PathBuf::from(notes_folder(&state)?);
    abs_path_from_id(&root, &id)?;
    let ignored = ignored_dirs(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let private = if include_private {
            vault::PrivateSet::default()
        } else {
            vault::current_private_set(&root, &ignored)?
        };
        export::export_note(&root, &id, &markdown, &ignored, &private, Path::new(&dest))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Failed to export zip: {e}"))
}

/// Unpacks an exported zip into the notes folder; returns the number of files written.
#[tauri::command]
async fn import_zip(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    tauri::async_runtime::spawn_blocking(move || export::import(&root, Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct NotionImportProgress {
    current: usize,
    total: usize,
}

/// Imports Notion HTML export zips (the parts of one export) into the notes
/// folder, top-level pages at its root. Emits `notion-import-progress` after
/// each note it writes.
#[tauri::command]
async fn import_notion(
    app: AppHandle,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<notion_import::Summary, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    let notes_root = root.clone();
    let ignored = ignored_dirs(&state);
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let zips: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        notion_import::import(&notes_root, &zips, &ignored, |current, total| {
            let _ = app.emit("notion-import-progress", NotionImportProgress { current, total });
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(index) = state.search_index.lock().expect("search index mutex").as_ref() {
        let _ = index.rebuild_index(&root, &ignored_dirs(&state));
    }
    Ok(summary)
}

/// An image in the notes folder, given its path relative to it, as base64.
#[tauri::command]
async fn read_asset_base64(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = PathBuf::from(notes_folder(&state)?);
    let rel = Path::new(&path);
    if !rel
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Not a file in the notes folder".to_string());
    }
    let extension = rel
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Only images can be embedded".to_string());
    }
    let bytes = fs::read(root.join(rel))
        .await
        .map_err(|_| format!("Could not read {path}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn rebuild_search_index(state: State<AppState>) -> Result<(), String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config
            .notes_folder
            .clone()
            .ok_or("Notes folder not set")?
    };

    let ignored_dirs = {
        let settings = state.settings.read().expect("settings read lock");
        get_effective_ignored_dirs(&settings)
    };

    let index = state.search_index.lock().expect("search index mutex");
    match index.as_ref() {
        Some(search_index) => search_index
            .rebuild_index(&PathBuf::from(&folder), &ignored_dirs)
            .map_err(|e| e.to_string()),
        None => Err("Search index not initialized".to_string()),
    }
}

#[tauri::command]
fn get_default_ignored_patterns() -> Vec<String> {
    DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect()
}

// UI helper commands - wrap Tauri plugins for consistent invoke-based API

#[tauri::command]
async fn open_folder_dialog(
    app: AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Run blocking dialog on a separate thread to avoid blocking the async runtime
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_can_create_directories(true);

        if let Some(path) = default_path {
            builder = builder.set_directory(path);
        }

        builder.blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("Dialog task failed: {}", e))?;

    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
async fn open_in_file_manager(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() || !path_buf.is_dir() {
        return Err("Path does not exist or is not a directory".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        let windows_path = path.replace("/", "\\");
        std::process::Command::new("explorer")
            .arg(&windows_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Err("Unsupported platform".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn open_url_safe(url: String) -> Result<(), String> {
    // Validate URL scheme - only allow http, https, mailto
    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        scheme => {
            return Err(format!(
                "URL scheme '{}' is not allowed. Only http, https, and mailto are permitted.",
                scheme
            ))
        }
    }

    // Use system opener
    open::that(&url).map_err(|e| format!("Failed to open URL: {}", e))
}

/// Runs an agent CLI request on the open notes folder.
fn run_agent_request(state: &AppState, request: &agent_git::Request) -> agent_git::Reply {
    // After the lock, so a request that waited sees the folder open now.
    let _git = lock_git(&state.git_lock);
    let git_enabled = state.settings.read().expect("settings read lock").git_enabled;
    if git_enabled == Some(false) {
        return agent_git::Reply::error(
            "Git is turned off for this notes folder in Aether's settings",
        );
    }
    let root = notes_folder(state).ok().map(PathBuf::from);
    let ignored = ignored_dirs(state);
    agent_git::handle(request, root.as_deref(), &ignored, state.key_store.as_ref())
}

/// The git lock. A panic during git work leaves nothing for the next to wait on.
fn lock_git(lock: &Mutex<()>) -> std::sync::MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Runs `f` off the async runtime, holding the git lock.
async fn with_git<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let lock = state.git_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _git = lock_git(&lock);
        f()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Takes request `id` from the mailbox, runs it, and writes the reply. The
/// frontend then refreshes its git state, and a hand-off brings the window
/// forward with the merge editor.
fn answer_agent_request<R: tauri::Runtime>(app: &AppHandle<R>, mailbox: &Path, id: &str) {
    // A request forwarded while the app starts arrives before setup manages the state.
    let state = loop {
        match app.try_state::<AppState>() {
            Some(state) => break state,
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    };
    let reply = match agent_git::take_request(mailbox, id) {
        Ok(request) => run_agent_request(&state, &request),
        Err(e) => agent_git::Reply::error(e),
    };
    if let Err(e) = agent_git::write_json(&agent_git::reply_file(mailbox, id), &reply) {
        eprintln!("Agent request {id}: could not reply: {e}");
    }
    let _ = app.emit("git-state-changed", ());
    if reply.outcome == agent_git::Outcome::HandedOff {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }
}

/// Runs `f` with the notes folder, ignored folders and key store, off the async runtime.
async fn with_vault<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&Path, &[String], &dyn vault::KeyStore) -> T + Send + 'static,
) -> Result<T, String> {
    let root = PathBuf::from(notes_folder(state)?);
    let ignored = ignored_dirs(state);
    let store = state.key_store.clone();
    with_git(state, move || f(&root, &ignored, store.as_ref())).await
}

#[tauri::command]
async fn vault_status(state: State<'_, AppState>) -> Result<vault::VaultStatus, String> {
    with_vault(&state, vault::status).await?
}

#[tauri::command]
async fn vault_generate_key(state: State<'_, AppState>) -> Result<String, String> {
    with_vault(&state, |root, _, store| vault::generate_key(root, store)).await?
}

#[tauri::command]
async fn vault_enter_key(
    key: String,
    state: State<'_, AppState>,
) -> Result<vault::VaultStatus, String> {
    with_vault(&state, move |root, ignored, store| {
        vault::enter_key(root, ignored, store, &key)?;
        vault::status(root, ignored, store)
    })
    .await?
}

#[tauri::command]
async fn vault_show_key(state: State<'_, AppState>) -> Result<String, String> {
    with_vault(&state, |root, _, store| vault::show_key(root, store)).await?
}

#[tauri::command]
async fn vault_set_private(
    ids: Vec<String>,
    is_private: bool,
    state: State<'_, AppState>,
) -> Result<vault::VaultStatus, String> {
    with_vault(&state, move |root, ignored, store| {
        // Before the marks, so the exclude block lists the new files
        if is_private {
            for id in &ids {
                create_bare_page_file(root, id, ignored)?;
            }
        }
        vault::set_private(root, ignored, store, &ids, is_private)?;
        vault::status(root, ignored, store)
    })
    .await?
}

#[tauri::command]
async fn git_conflicts(state: State<'_, AppState>) -> Result<Vec<merge::ConflictFile>, String> {
    with_vault(&state, |root, _, store| merge::conflicts(root, store)).await?
}

#[tauri::command]
async fn git_resolve_conflict(
    path: String,
    resolution: merge::ConflictResolution,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_vault(&state, move |root, _, store| {
        merge::resolve(root, store, &path, resolution)
    })
    .await?
}

#[tauri::command]
async fn git_finish_merge(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    with_vault(&state, merge::finish).await?
}

#[tauri::command]
async fn git_abort_merge(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    with_vault(&state, merge::abort).await?
}

// Git commands - run blocking git operations off the main thread

#[tauri::command]
async fn git_is_available() -> bool {
    tauri::async_runtime::spawn_blocking(git::is_available)
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn git_get_status(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    let ignored = ignored_dirs(&state);
    match folder {
        Some(path) => with_git(&state, move || {
            let root = PathBuf::from(path);
            let mut status = git::get_status(&root);
            if status.is_repo {
                status.changed_count += vault::pending_count(&root, &ignored);
            }
            status
        })
        .await,
        None => Ok(git::GitStatus::default()),
    }
}

#[tauri::command]
async fn git_init_repo(state: State<'_, AppState>) -> Result<(), String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone().ok_or("Notes folder not set")?
    };

    with_git(&state, move || {
        git::git_init(&PathBuf::from(folder))
    })
    .await?
}

#[tauri::command]
async fn git_commit(message: String, state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    let ignored = ignored_dirs(&state);
    let store = state.key_store.clone();
    match folder {
        Some(path) => with_git(&state, move || {
            vault::commit(&PathBuf::from(path), &ignored, store.as_ref(), &message)
        })
        .await,
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_push(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    match folder {
        Some(path) => {
            with_git(&state, move || {
                git::push(&PathBuf::from(path))
            })
            .await
        }
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_fetch(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    match folder {
        Some(path) => {
            with_git(&state, move || {
                git::fetch(&PathBuf::from(path))
            })
            .await
        }
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_pull(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    let ignored = ignored_dirs(&state);
    let store = state.key_store.clone();
    match folder {
        Some(path) => with_git(&state, move || {
            vault::pull(&PathBuf::from(path), &ignored, store.as_ref())
        })
        .await,
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_add_remote(url: String, state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    match folder {
        Some(path) => {
            with_git(&state, move || {
                git::add_remote(&PathBuf::from(path), &url)
            })
            .await
        }
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_set_remote_url(url: String, state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    match folder {
        Some(path) => {
            with_git(&state, move || {
                git::set_remote_url(&PathBuf::from(path), &url)
            })
            .await
        }
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_remove_remote(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    match folder {
        Some(path) => {
            with_git(&state, move || {
                git::remove_remote(&PathBuf::from(path))
            })
            .await
        }
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

#[tauri::command]
async fn git_push_with_upstream(state: State<'_, AppState>) -> Result<git::GitResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone()
    };

    match folder {
        Some(path) => {
            with_git(&state, move || {
                // Get current branch first
                let status = git::get_status(&PathBuf::from(&path));
                match status.current_branch {
                    Some(branch) => {
                        if !branch
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
                        {
                            return git::GitResult {
                                success: false,
                                message: None,
                                error: Some("Invalid branch name".to_string()),
                            };
                        }
                        git::push_with_upstream(&PathBuf::from(&path), &branch)
                    }
                    None => git::GitResult {
                        success: false,
                        message: None,
                        error: Some("No current branch found".to_string()),
                    },
                }
            })
            .await
        }
        None => Ok(git::GitResult {
            success: false,
            message: None,
            error: Some("Notes folder not set".to_string()),
        }),
    }
}

// Check if Claude CLI is installed
fn get_expanded_path() -> String {
    let system_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| String::new());

    if home.is_empty() {
        return system_path;
    }

    // Common locations for node-installed CLIs (nvm, volta, fnm, mise, homebrew, global npm)
    let candidate_dirs = vec![
        format!("{home}/.nvm/versions/node"),
        format!("{home}/.fnm/node-versions"),
        format!("{home}/.local/share/mise/installs/node"),
    ];
    let static_dirs = vec![
        format!("{home}/.bun/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.local/bin"),
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
    ];

    let mut expanded = Vec::new();

    // Prefer well-known static locations (e.g. ~/.local/bin for native CLI installs)
    for dir in static_dirs {
        expanded.push(dir);
    }

    // Then scan nvm/fnm node version dirs containing a bin/ folder
    for base in &candidate_dirs {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.exists() {
                    expanded.push(bin_path.to_string_lossy().to_string());
                }
            }
        }
    }

    expanded.push(system_path);
    expanded.join(":")
}

/// Create a `Command` that hides the console window on Windows.
fn no_window_cmd(program: &str) -> std::process::Command {
    let cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        cmd
    }
}

fn check_cli_exists(command_name: &str, path: &str) -> Result<bool, String> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let check_output = no_window_cmd(which_cmd)
        .arg(command_name)
        .env("PATH", path)
        .output()
        .map_err(|e| format!("Failed to check for {} CLI: {}", command_name, e))?;

    Ok(check_output.status.success())
}

#[tauri::command]
fn get_cli_status() -> Result<CliStatus, String> {
    let target = install::cli_target()?;
    let installed = install::bundled_cli().is_ok_and(|cli| install::cli_installed(&target, &cli));
    Ok(CliStatus {
        installed,
        path: installed.then(|| target.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
fn install_cli() -> Result<String, String> {
    let target = install::cli_target()?;
    install::install_cli(&target, &install::bundled_cli()?)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn uninstall_cli() -> Result<(), String> {
    install::uninstall_cli(&install::cli_target()?)
}

#[tauri::command]
fn get_skill_status() -> Result<install::SkillStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot find the home folder")?;
    Ok(install::skill_status(&home))
}

#[tauri::command]
fn install_skill() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot find the home folder")?;
    install::install_skill(&home)
}

#[tauri::command]
async fn ai_check_claude_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = get_expanded_path();
        check_cli_exists("claude", &path)
    })
    .await
    .map_err(|e| format!("Failed to check Claude CLI: {}", e))?
}

#[tauri::command]
async fn ai_check_codex_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = get_expanded_path();
        check_cli_exists("codex", &path)
    })
    .await
    .map_err(|e| format!("Failed to check Codex CLI: {}", e))?
}

#[tauri::command]
async fn ai_check_opencode_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = get_expanded_path();
        check_cli_exists("opencode", &path)
    })
    .await
    .map_err(|e| format!("Failed to check OpenCode CLI: {}", e))?
}

/// Shared AI CLI execution: spawns `command` with `args`, writes `stdin_input` to stdin,
/// and returns the result with a 5-minute timeout.
async fn execute_ai_cli(
    cli_name: &str,
    command: String,
    args: Vec<String>,
    stdin_input: String,
    not_found_msg: String,
    current_dir: Option<String>,
    extra_env: Option<Vec<(String, String)>>,
) -> Result<AiExecutionResult, String> {
    use std::io::Write;
    use std::process::{Child, Stdio};

    let cli_name = cli_name.to_string();
    let timeout_duration = std::time::Duration::from_secs(300);
    let shared_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_task = Arc::clone(&shared_child);
    let cli_name_task = cli_name.clone();

    let mut task = tauri::async_runtime::spawn_blocking(move || {
        // Blocking I/O: expand PATH and check CLI exists
        let path = get_expanded_path();
        match check_cli_exists(&command, &path) {
            Ok(false) => {
                return AiExecutionResult {
                    success: false,
                    output: String::new(),
                    error: Some(not_found_msg),
                };
            }
            Err(e) => {
                return AiExecutionResult {
                    success: false,
                    output: String::new(),
                    error: Some(e),
                };
            }
            Ok(true) => {}
        }

        let mut cmd = no_window_cmd(&command);
        cmd.env("PATH", &path);
        if let Some(dir) = &current_dir {
            cmd.current_dir(dir);
        }
        if let Some(env_pairs) = &extra_env {
            for (key, value) in env_pairs {
                cmd.env(key, value);
            }
        }
        for arg in &args {
            cmd.arg(arg);
        }
        let process = match cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(p) => p,
            Err(e) => {
                return AiExecutionResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!("Failed to execute {}: {}", cli_name_task, e)),
                };
            }
        };

        // Store process in shared state so the timeout handler can kill it.
        // We only take individual I/O handles below — the Child stays in the
        // mutex so it remains reachable for kill().
        if let Ok(mut guard) = child_for_task.lock() {
            *guard = Some(process);
        } else {
            return AiExecutionResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to lock {} process handle", cli_name_task)),
            };
        }

        // Take stdin handle (briefly locks then releases)
        let stdin_handle = child_for_task
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|p| p.stdin.take()));

        if let Some(mut stdin) = stdin_handle {
            if let Err(e) = stdin.write_all(stdin_input.as_bytes()) {
                if let Ok(mut g) = child_for_task.lock() {
                    if let Some(ref mut p) = *g {
                        let _ = p.kill();
                        let _ = p.wait();
                    }
                }
                return AiExecutionResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!("Failed to write to {} stdin: {}", cli_name_task, e)),
                };
            }
            // stdin dropped here — closes the pipe
        } else {
            if let Ok(mut g) = child_for_task.lock() {
                if let Some(ref mut p) = *g {
                    let _ = p.kill();
                    let _ = p.wait();
                }
            }
            return AiExecutionResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to open stdin for {}", cli_name_task)),
            };
        }

        // Take stdout/stderr handles so we can read without holding the lock.
        // This allows the timeout handler to lock the mutex and kill the process.
        let stdout_handle = child_for_task
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|p| p.stdout.take()));
        let stderr_handle = child_for_task
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|p| p.stderr.take()));

        use std::io::Read;

        let mut stdout_str = String::new();
        if let Some(mut out) = stdout_handle {
            let _ = out.read_to_string(&mut stdout_str);
        }

        let mut stderr_str = String::new();
        if let Some(mut err) = stderr_handle {
            let _ = err.read_to_string(&mut stderr_str);
        }

        // Collect exit status — process has exited after stdout/stderr close
        let success = child_for_task
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|p| p.wait().ok()))
            .map(|s| s.success())
            .unwrap_or(false);

        // Strip ANSI escape sequences from output (e.g. Ollama progress spinners)
        let ansi_re = regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?\x07").unwrap();
        let stdout_clean = ansi_re.replace_all(&stdout_str, "").to_string();
        let stderr_clean = ansi_re.replace_all(&stderr_str, "").trim().to_string();

        if success {
            AiExecutionResult {
                success: true,
                output: stdout_clean,
                error: None,
            }
        } else {
            AiExecutionResult {
                success: false,
                output: stdout_clean,
                error: Some(stderr_clean),
            }
        }
    });

    let result = match tokio::time::timeout(timeout_duration, &mut task).await {
        Ok(join_result) => {
            join_result.map_err(|e| format!("Failed to join {} blocking task: {}", cli_name, e))?
        }
        Err(_) => {
            // Kill through the shared handle — the Child is still in the mutex
            // because the blocking task only takes I/O handles, not the Child.
            // This sends SIGKILL, which closes the pipes and unblocks the reads.
            if let Ok(mut guard) = shared_child.lock() {
                if let Some(ref mut process) = *guard {
                    let _ = process.kill();
                }
            }

            match tokio::time::timeout(std::time::Duration::from_secs(5), task).await {
                Ok(join_result) => {
                    if let Err(e) = join_result {
                        return Err(format!(
                            "Failed to join {} blocking task after timeout: {}",
                            cli_name, e
                        ));
                    }
                }
                Err(_) => {
                    return Err(format!(
                        "{} CLI timed out and failed to exit after kill signal",
                        cli_name
                    ));
                }
            }

            AiExecutionResult {
                success: false,
                output: String::new(),
                error: Some(format!("{} CLI timed out after 5 minutes", cli_name)),
            }
        }
    };

    Ok(result)
}

#[tauri::command]
async fn ai_execute_claude(
    file_path: String,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<AiExecutionResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone().ok_or("Notes folder not set")?
    };
    let path = PathBuf::from(&file_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("markdown") {
        return Err("AI editing is only supported for markdown files".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Invalid file path".to_string())?;
    let notes_root = PathBuf::from(&folder)
        .canonicalize()
        .map_err(|_| "Invalid notes folder".to_string())?;
    if !canonical.starts_with(&notes_root) {
        return Err("File must be within notes folder".to_string());
    }

    execute_ai_cli(
        "Claude",
        "claude".to_string(),
        vec![
            canonical.to_string_lossy().to_string(),
            "--dangerously-skip-permissions".to_string(),
            "--print".to_string(),
        ],
        prompt,
        "Claude CLI not found. Please install it from https://claude.ai/code".to_string(),
        None,
        None,
    )
    .await
}

#[tauri::command]
async fn ai_execute_codex(file_path: String, prompt: String) -> Result<AiExecutionResult, String> {
    let stdin_input = format!(
        "Edit only this markdown file: {file_path}\n\
         Apply the user's instructions below directly to that file.\n\
         Do not create, delete, rename, or modify any other files.\n\
         User instructions:\n\
         {prompt}"
    );

    execute_ai_cli(
        "Codex",
        "codex".to_string(),
        vec![
            "exec".to_string(),
            "--skip-git-repo-check".to_string(),
            "--dangerously-bypass-approvals-and-sandbox".to_string(),
            "-".to_string(),
        ],
        stdin_input,
        "Codex CLI not found. Please install it from https://github.com/openai/codex".to_string(),
        None,
        None,
    )
    .await
}

#[tauri::command]
async fn ai_execute_opencode(
    file_path: String,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<AiExecutionResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone().ok_or("Notes folder not set")?
    };
    let path = PathBuf::from(&file_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("markdown") {
        return Err("AI editing is only supported for markdown files".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Invalid file path".to_string())?;
    let notes_root = PathBuf::from(&folder)
        .canonicalize()
        .map_err(|_| "Invalid notes folder".to_string())?;
    if !canonical.starts_with(&notes_root) {
        return Err("File must be within notes folder".to_string());
    }

    let run_prompt = format!(
        "Edit the attached markdown file in place.\n\
         Do not create, delete, rename, or modify any other files.\n\
         User instructions:\n\
         {}",
        prompt
    );

    execute_ai_cli(
        "OpenCode",
        "opencode".to_string(),
        vec![
            "run".to_string(),
            "--file".to_string(),
            canonical.to_string_lossy().to_string(),
            "--".to_string(),
            run_prompt,
        ],
        String::new(),
        "OpenCode CLI not found. Please install it from https://opencode.ai".to_string(),
        Some(notes_root.to_string_lossy().to_string()),
        Some(vec![
            (
                "OPENCODE_PERMISSION".to_string(),
                r#"{"*":"allow","bash":"deny","task":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","skill":"deny","external_directory":"deny","doom_loop":"deny"}"#.to_string(),
            ),
        ]),
    )
    .await
}

#[tauri::command]
async fn ai_check_ollama_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = get_expanded_path();
        check_cli_exists("ollama", &path)
    })
    .await
    .map_err(|e| format!("Failed to check Ollama CLI: {}", e))?
}

#[tauri::command]
async fn ai_execute_ollama(
    file_path: String,
    prompt: String,
    model: String,
    state: State<'_, AppState>,
) -> Result<AiExecutionResult, String> {
    let folder = {
        let app_config = state.app_config.read().expect("app_config read lock");
        app_config.notes_folder.clone().ok_or("Notes folder not set")?
    };
    let path = PathBuf::from(&file_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("markdown") {
        return Err("AI editing is only supported for markdown files".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Invalid file path".to_string())?;
    let notes_root = PathBuf::from(&folder)
        .canonicalize()
        .map_err(|_| "Invalid notes folder".to_string())?;
    if !canonical.starts_with(&notes_root) {
        return Err("File must be within notes folder".to_string());
    }

    // Read the current file content
    let file_content = tokio::fs::read_to_string(&canonical)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let stdin_input = format!(
        "You are a markdown editor. Edit the markdown content below according to the user's instructions.\n\
         Return ONLY the complete edited markdown content.\n\
         Do NOT include any explanation, commentary, or code fences around the output.\n\
         Do NOT add ```markdown or ``` wrappers.\n\n\
         Current markdown content:\n{file_content}\n\n\
         User instructions:\n{prompt}"
    );

    // Use the model provided (frontend reads from settings, defaults to "qwen3:8b")
    let trimmed = model.trim();
    let model_name = if trimmed.is_empty() {
        "qwen3:8b".to_string()
    } else {
        trimmed.to_string()
    };

    // Check if the model is available locally before running (skip for cloud models)
    if !model_name.contains("cloud") {
        let mn = model_name.clone();
        let available = tauri::async_runtime::spawn_blocking(move || {
            let path = get_expanded_path();
            let mut cmd = no_window_cmd("ollama");
            cmd.env("PATH", &path);
            cmd.args(["show", &mn]);
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            match cmd.status() {
                Ok(status) => status.success(),
                Err(_) => false,
            }
        })
        .await
        .unwrap_or(false);

        if !available {
            return Ok(AiExecutionResult {
                success: false,
                output: String::new(),
                error: Some(format!(
                    "Model '{}' is not installed. Run: ollama pull {}",
                    model_name, model_name
                )),
            });
        }
    }

    let result = execute_ai_cli(
        "Ollama",
        "ollama".to_string(),
        vec!["run".to_string(), model_name.clone()],
        stdin_input,
        "Ollama CLI not found. Please install it from https://ollama.com".to_string(),
        None,
        None,
    )
    .await?;

    // Improve error messages for common Ollama failures
    if !result.success {
        if let Some(ref err) = result.error {
            let err_lower = err.to_lowercase();
            if err_lower.contains("file does not exist")
                || err_lower.contains("pull model manifest")
                || err_lower.contains("model not found")
                || err_lower.contains("model does not exist")
            {
                return Ok(AiExecutionResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!(
                        "Model '{}' not found. Run `ollama pull {}` in your terminal to download it.",
                        model_name, model_name
                    )),
                });
            }
            if err.contains("401") || err.contains("Unauthorized") {
                return Ok(AiExecutionResult {
                    success: false,
                    output: String::new(),
                    error: Some("Authentication required. Run `ollama login` in your terminal to sign in.".to_string()),
                });
            }
        }
    }

    // If successful, write the output back to the file
    if result.success {
        let edited_content = result.output.trim().to_string();
        if edited_content.is_empty() {
            return Ok(AiExecutionResult {
                success: false,
                output: String::new(),
                error: Some("Ollama returned empty output. Please try again.".to_string()),
            });
        }
        tokio::fs::write(&canonical, edited_content.as_bytes())
            .await
            .map_err(|e| format!("Failed to write edited file: {}", e))?;

        Ok(AiExecutionResult {
            success: true,
            output: "Note edited successfully with Ollama.".to_string(),
            error: None,
        })
    } else {
        Ok(result)
    }
}

/// Check if a markdown file is inside the configured notes folder.
/// If so, emit a "select-note" event to the main window and focus it, returning true.
/// Returns false on any failure so callers can fall back to create_preview_window.
fn try_select_in_notes_folder(app: &AppHandle, path: &Path) -> bool {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return false,
    };

    let notes_folder = state
        .app_config
        .read()
        .expect("app_config read lock")
        .notes_folder
        .clone();

    let folder = match notes_folder {
        Some(f) => f,
        None => return false,
    };

    let folder_path = PathBuf::from(&folder);
    let (canonical_file, canonical_folder) = match (path.canonicalize(), folder_path.canonicalize())
    {
        (Ok(f), Ok(d)) => (f, d),
        _ => return false,
    };

    if !canonical_file.starts_with(&canonical_folder) {
        return false;
    }

    let ignored_dirs = {
        let settings = state.settings.read().expect("settings read lock");
        get_effective_ignored_dirs(&settings)
    };

    let note_id = match id_from_abs_path(&canonical_folder, &canonical_file, &ignored_dirs) {
        Some(id) => id,
        None => return false,
    };

    let _ = app.emit_to("main", "select-note", note_id);
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    true
}

/// Check if a file extension is a supported markdown extension.
fn is_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| {
            let lower = s.to_ascii_lowercase();
            lower == "md" || lower == "markdown"
        })
        .unwrap_or(false)
}

// Preview mode: create a lightweight window for editing a single file
fn create_preview_window(app: &AppHandle, file_path: &str) -> Result<(), String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    let label = format!("preview-{:x}", hasher.finish());

    // If window already exists for this file, focus it
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Extract filename for the window title
    let filename = PathBuf::from(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Preview".to_string());

    let encoded_path = urlencoding::encode(file_path);
    let url = format!("index.html?mode=preview&file={}", encoded_path);

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(format!("{} — Aether", filename))
        .inner_size(800.0, 600.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .decorations(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = builder
        .build()
        .map_err(|e| format!("Failed to create preview window: {}", e))?;

    // Focus the preview window so it appears on top of the main window.
    // Use a short delay because during cold start the main window may steal
    // focus after its WebView finishes loading.
    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = win.set_focus();
    });

    Ok(())
}

#[tauri::command]
fn open_file_preview(app: AppHandle, path: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !try_select_in_notes_folder(&app, &file_path) {
        create_preview_window(&app, &path)?;
    }
    Ok(())
}

// Handle CLI arguments: open .md files in preview mode.
// Returns true if a standalone preview window was created (file outside notes folder).
fn handle_cli_args(app: &AppHandle, args: &[String], cwd: &str) -> bool {
    if let Some(id) = agent_git::request_id(args) {
        let mailbox = match agent_git::mailbox() {
            Ok(mailbox) => mailbox,
            Err(e) => {
                eprintln!("Agent request {id}: {e}");
                return false;
            }
        };
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn_blocking(move || answer_agent_request(&app, &mailbox, &id));
        return false;
    }
    let mut opened_file = false;
    let mut opened_preview = false;

    for arg in args.iter().skip(1) {
        // Skip flags
        if arg.starts_with('-') {
            continue;
        }

        let path = if PathBuf::from(arg).is_absolute() {
            PathBuf::from(arg)
        } else {
            PathBuf::from(cwd).join(arg)
        };

        if is_markdown_extension(&path) && path.is_file() {
            opened_file = true;
            if !try_select_in_notes_folder(app, &path)
                && create_preview_window(app, &path.to_string_lossy()).is_ok()
            {
                opened_preview = true;
            }
        } else if path.is_dir() {
            let canonical = dunce::canonicalize(&path).unwrap_or(path.clone());
            let state = app.state::<AppState>();
            // Full initialization: directory creation, write-access check,
            // asset-scope update, config/settings persist, and search-index rebuild
            match initialize_notes_folder(app, &canonical, &state) {
                Ok(normalized_path) => {
                    // Emit event for when app is already running (single-instance)
                    let _ = app.emit("set-notes-folder", normalized_path);
                    opened_file = true;
                }
                Err(e) => {
                    eprintln!("Failed to initialize notes folder {:?}: {}", canonical, e);
                }
            }
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
        }
    }

    // If no files were opened, show and focus the main window
    if !opened_file {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }

    opened_preview
}

// On macOS, WKWebView reads per-app preferences from NSUserDefaults to decide
// whether to show the spelling underline and apply auto-correct in contenteditable
// regions. These keys default to off for new bundle IDs, which is why a fresh
// Tauri app gets neither the red underline nor auto-replace even when the HTML
// `spellcheck`/`autocorrect` attributes are set. Seed missing WebKit preferences
// before the webview is constructed; existing user-toggled values still win.
#[cfg(target_os = "macos")]
fn enable_webview_spellcheck_defaults() {
    use objc2_foundation::{NSString, NSUserDefaults};

    let keys = [
        "WebContinuousSpellCheckingEnabled",
        "WebGrammarCheckingEnabled",
        "WebAutomaticSpellingCorrectionEnabled",
    ];

    let defaults = NSUserDefaults::standardUserDefaults();
    for key in keys {
        let key = NSString::from_str(key);
        if defaults.objectForKey(&key).is_none() {
            defaults.setBool_forKey(true, &key);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    enable_webview_spellcheck_defaults();

    let app = tauri::Builder::default()
        // Single-instance: forward CLI args from subsequent launches to the running instance
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            handle_cli_args(app, &args, &cwd);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Requests and replies no CLI is waiting for anymore
            if let Ok(mailbox) = agent_git::mailbox() {
                std::thread::spawn(move || {
                    agent_git::prune(&mailbox, std::time::Duration::from_secs(3600))
                });
            }

            #[cfg(windows)]
            std::thread::spawn(|| {
                if let Err(e) = install::refresh_cli() {
                    eprintln!("Failed to update the installed CLI: {e}");
                }
            });

            // Load app config on startup (contains notes folder path)
            let mut app_config = load_app_config(app.handle());

            // Normalize legacy/invalid saved paths (e.g. file:// URI from older builds)
            if let Some(saved_path) = app_config.notes_folder.clone() {
                match normalize_notes_folder_path(&saved_path) {
                    Ok(normalized) if normalized.is_dir() => {
                        let normalized_str = normalized.to_string_lossy().into_owned();
                        if normalized_str != saved_path {
                            app_config.notes_folder = Some(normalized_str);
                            let _ = save_app_config(app.handle(), &app_config);
                        }
                    }
                    Ok(normalized) => {
                        // Path is structurally valid but not currently a directory
                        // (e.g., unmounted drive). Preserve the user's preference.
                        eprintln!("Notes folder not found (may be temporarily unavailable): {:?}", normalized);
                    }
                    Err(_) => {
                        app_config.notes_folder = None;
                        let _ = save_app_config(app.handle(), &app_config);
                    }
                }
            }

            // Load per-folder settings if notes folder is set
            let settings = if let Some(ref folder) = app_config.notes_folder {
                load_settings(folder)
            } else {
                Settings::default()
            };

            let ignored_dirs = get_effective_ignored_dirs(&settings);
            let key_store: Arc<dyn vault::KeyStore> = Arc::new(vault::OsKeyStore);
            if let Some(ref folder) = app_config.notes_folder {
                if let Err(e) = vault::decrypt(Path::new(folder), &ignored_dirs, key_store.as_ref())
                {
                    eprintln!("Failed to decrypt private pages: {e}");
                }
            }

            // Initialize search index if notes folder is set
            let search_index = if let Some(ref folder) = app_config.notes_folder {
                if let Ok(index_path) = get_search_index_path(app.handle()) {
                    SearchIndex::new(&index_path).ok().inspect(|idx| {
                        let _ = idx.rebuild_index(&PathBuf::from(folder), &ignored_dirs);
                    })
                } else {
                    None
                }
            } else {
                None
            };

            let state = AppState {
                app_config: RwLock::new(app_config),
                settings: RwLock::new(settings),
                notes_cache: RwLock::new(HashMap::new()),
                file_watcher: Mutex::new(None),
                search_index: Mutex::new(search_index),
                debounce_map: Arc::new(Mutex::new(HashMap::new())),
                key_store,
                git_lock: Arc::default(),
            };
            app.manage(state);

            // Add notes folder to asset protocol scope so images can be served
            if let Some(ref folder) = app.state::<AppState>().app_config.read().expect("app_config read lock").notes_folder.clone() {
                let _ = app.asset_protocol_scope().allow_directory(folder, true);
            }

            // Handle CLI args on first launch; determine whether to show the main window.
            // When a standalone preview is opened (file outside the notes folder) and the
            // notes folder is already configured, the main window is closed so users only
            // see the preview. When no notes folder is configured yet, the main window is
            // always shown so new users can complete onboarding via the FolderPicker.
            let args: Vec<String> = std::env::args().collect();
            let opened_preview = if args.len() > 1 {
                let cwd = std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                handle_cli_args(app.handle(), &args, &cwd)
            } else {
                false
            };

            if let Some(main_window) = app.get_webview_window("main") {
                let has_notes_folder = app
                    .state::<AppState>()
                    .app_config
                    .read()
                    .expect("app_config read lock")
                    .notes_folder
                    .is_some();

                if opened_preview && has_notes_folder {
                    // Existing user: notes folder is configured and a standalone preview
                    // was opened. Close the hidden main window so only the preview is visible.
                    let _ = main_window.hide();
                } else {
                    // Show the main window when:
                    // - No standalone preview was opened (normal launch), OR
                    // - No notes folder is configured yet (new user needs FolderPicker
                    //   for onboarding, even if a preview is also showing).
                    let _ = main_window.show();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Handle drag-and-drop of .md files onto any window
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle();
                for path in paths {
                    if is_markdown_extension(path)
                        && path.is_file()
                        && !try_select_in_notes_folder(app, path)
                    {
                        let _ = create_preview_window(app, &path.to_string_lossy());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_notes_folder,
            set_notes_folder,
            list_notes,
            read_note,
            get_note_info,
            save_note,
            delete_note,
            sub_page_counts,
            create_note,
            move_note,
            get_settings,
            update_settings,
            update_git_enabled,
            preview_note_name,
            write_file,
            search_notes,
            start_file_watcher,
            rebuild_search_index,
            get_default_ignored_patterns,
            copy_to_clipboard,
            copy_image_to_assets,
            copy_file_to_assets,
            get_asset_size,
            open_asset,
            read_asset_base64,
            export_folder_zip,
            export_note_zip,
            import_zip,
            import_notion,
            save_clipboard_image,
            open_folder_dialog,
            open_in_file_manager,
            open_url_safe,
            git_is_available,
            git_get_status,
            git_init_repo,
            git_commit,
            git_push,
            git_fetch,
            git_pull,
            git_add_remote,
            git_set_remote_url,
            git_remove_remote,
            git_push_with_upstream,
            git_conflicts,
            git_resolve_conflict,
            git_finish_merge,
            git_abort_merge,
            vault_status,
            vault_generate_key,
            vault_enter_key,
            vault_show_key,
            vault_set_private,
            ai_check_claude_cli,
            ai_check_codex_cli,
            ai_check_opencode_cli,
            ai_check_ollama_cli,
            ai_execute_claude,
            ai_execute_codex,
            ai_execute_opencode,
            ai_execute_ollama,
            read_file_direct,
            save_file_direct,
            import_file_to_folder,
            open_file_preview,
            install_cli,
            uninstall_cli,
            get_cli_status,
            get_skill_status,
            install_skill,
            set_title_bar_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Use .run() callback to handle macOS "Open With" file events
    // RunEvent::Opened is macOS-only in Tauri v2
    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if is_markdown_extension(&path)
                        && path.is_file()
                        && !try_select_in_notes_folder(_app_handle, &path)
                    {
                        let _ = create_preview_window(_app_handle, &path.to_string_lossy());
                    }
                }
            }
        }
    });
}

#[cfg(target_os = "windows")]
mod windows_title_bar {
    use tauri::WebviewWindow;

    #[allow(non_snake_case)]
    mod dwm {
        pub const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
        pub const DWMWA_CAPTION_COLOR: u32 = 35;
        pub const DWMWA_BORDER_COLOR: u32 = 34;

        extern "system" {
            pub fn DwmSetWindowAttribute(
                hwnd: isize,
                attr: u32,
                value: *const std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
    }

    pub fn apply_title_bar_theme(window: &WebviewWindow, is_dark: bool, rgb: (u8, u8, u8)) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let hwnd = hwnd.0 as isize;

        // Windows COLORREF is little-endian 0x00BBGGRR
        let (r, g, b) = rgb;
        let caption_color: u32 =
            ((b as u32) << 16) | ((g as u32) << 8) | (r as u32);

        unsafe {
            let set_attr = |attr: u32, value: *const std::ffi::c_void, size: u32| {
                let _ = dwm::DwmSetWindowAttribute(hwnd, attr, value, size);
            };

            let dark_mode: i32 = if is_dark { 1 } else { 0 };
            set_attr(
                dwm::DWMWA_USE_IMMERSIVE_DARK_MODE,
                &dark_mode as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
            set_attr(
                dwm::DWMWA_CAPTION_COLOR,
                &caption_color as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            set_attr(
                dwm::DWMWA_BORDER_COLOR,
                &caption_color as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[tauri::command]
fn set_title_bar_theme(
    app: AppHandle,
    is_dark: bool,
    r: u8,
    g: u8,
    b: u8,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        for (label, window) in app.webview_windows() {
            if label == "main" || label.starts_with("preview-") {
                windows_title_bar::apply_title_bar_theme(&window, is_dark, (r, g, b));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, is_dark, r, g, b);
    }
    Ok(())
}
