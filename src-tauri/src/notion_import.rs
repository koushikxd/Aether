//! Imports Notion's HTML export (one or more zips) as notes. Pages become
//! sub-page nodes (`Page.md` plus `Page/`), files go to `assets/`, links
//! between pages become relative links to the imported notes, and the
//! markdown takes the forms the editor writes, so a first save changes
//! nothing. Anything without a mapping is kept as plain text and listed in
//! the summary.

use crate::{export, relink};
use ego_tree::NodeRef;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const DEFAULT_FOLDER: &str = "Notion Import";

// Notion's text colors, as the editor's color menu offers them.
const COLORS: [(&str, &str); 9] = [
    ("gray", "#787774"),
    ("brown", "#9f6b53"),
    ("orange", "#d9730d"),
    ("yellow", "#cb912f"),
    ("green", "#448361"),
    ("blue", "#337ea9"),
    ("purple", "#9065b0"),
    ("pink", "#c14c8a"),
    ("red", "#d44c47"),
];

// Elements that start a block of their own inside a container; everything
// else is inline content.
const BLOCK_TAGS: [&str; 22] = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "blockquote",
    "pre",
    "hr",
    "details",
    "aside",
    "figure",
    "div",
    "table",
    "nav",
    "section",
    "script",
    "style",
    "link",
];

#[derive(Debug, PartialEq, Serialize)]
pub struct Skipped {
    /// The imported note's id, or the zip entry that was refused.
    pub page: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Folder the pages were imported into.
    pub folder: String,
    pub pages: usize,
    pub images: usize,
    pub files: usize,
    pub skipped: Vec<Skipped>,
}

fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("valid selector")
}

fn first<'a>(el: ElementRef<'a>, css: &str) -> Option<ElementRef<'a>> {
    el.select(&selector(css)).next()
}

fn has_class(el: ElementRef, class: &str) -> bool {
    el.value().classes().any(|c| c == class)
}

fn text(el: ElementRef) -> String {
    el.text().collect::<String>().trim().to_string()
}

/// `tag.class1.class2`, for the summary.
fn describe(el: ElementRef) -> String {
    let mut out = el.value().name().to_string();
    for class in el.value().classes() {
        out.push('.');
        out.push_str(class);
    }
    out
}

/// Text escaped the way the editor's markdown serializer does it.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\\' | '`' | '*' | '_' | '[' | ']' | '~' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// A Notion id: 32 hex digits, without dashes.
fn is_notion_id(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A file name without the ` <id>` Notion adds before the extension.
fn strip_id(stem: &str) -> &str {
    match stem.rsplit_once(' ') {
        Some((name, id)) if is_notion_id(id) => name,
        _ => stem,
    }
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// The export path an `href` in a page in `dir` points to, or None for URLs
/// and anchors. `..` above the export root resolves to nothing.
fn resolve(dir: &str, href: &str) -> Option<String> {
    let path = href.split(['#', '?']).next().unwrap_or("");
    if path.is_empty() || relink::is_absolute(path) {
        return None;
    }
    let decoded = urlencoding::decode(path).ok()?;
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// Every file in the export's zips by its path. Zips at an archive's root
/// are how Notion wraps a multi-part export; they are opened as part of it.
#[derive(Default)]
struct Export {
    archives: Vec<ZipArchive<File>>,
    files: HashMap<String, (usize, usize)>,
    /// HTML pages, in zip order.
    pages: Vec<String>,
}

impl Export {
    fn open(paths: &[PathBuf], skipped: &mut Vec<Skipped>) -> Result<Self, String> {
        let mut export = Self::default();
        for path in paths {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let file = File::open(path).map_err(|_| format!("Could not open {name}"))?;
            export.add(file, &name, skipped)?;
        }
        Ok(export)
    }

    fn add(&mut self, file: File, name: &str, skipped: &mut Vec<Skipped>) -> Result<(), String> {
        let mut archive =
            ZipArchive::new(file).map_err(|_| format!("{name} is not a valid zip file"))?;
        let number = self.archives.len();
        let mut nested = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(message)?;
            if entry.is_dir() {
                continue;
            }
            let entry_name = entry.name().map_err(message)?.into_owned();
            let Some(path) = export::safe_entry_path(&entry, &entry_name) else {
                skipped.push(Skipped {
                    page: entry_name,
                    reason: "Unsafe path in the zip, not imported".to_string(),
                });
                continue;
            };
            let path = path.to_string_lossy().replace('\\', "/");
            if !path.contains('/') && path.ends_with(".zip") {
                nested.push((index, path));
            } else if !self.files.contains_key(&path) {
                if path.ends_with(".html") {
                    self.pages.push(path.clone());
                }
                self.files.insert(path, (number, index));
            }
        }
        self.archives.push(archive);
        for (index, path) in nested {
            let mut temp = tempfile::tempfile().map_err(message)?;
            {
                let mut entry = self.archives[number].by_index(index).map_err(message)?;
                std::io::copy(&mut entry, &mut temp).map_err(message)?;
            }
            self.add(temp, &path, skipped)?;
        }
        Ok(())
    }

    fn copy(&mut self, path: &str, out: &mut impl std::io::Write) -> Result<(), String> {
        let (archive, index) = self.files[path];
        let mut entry = self.archives[archive].by_index(index).map_err(message)?;
        std::io::copy(&mut entry, out).map(drop).map_err(message)
    }

    fn html(&mut self, path: &str) -> Result<Html, String> {
        let mut bytes = Vec::new();
        self.copy(path, &mut bytes)
            .map_err(|e| format!("Could not read {path}: {e}"))?;
        Ok(Html::parse_document(&String::from_utf8_lossy(&bytes)))
    }
}

/// A note to write: a page, or the index note of a database inside a page.
struct Note {
    title: String,
    /// The page's path in the export; empty for databases.
    path: String,
    /// Where Notion keeps this node's sub-pages.
    child_dir: String,
    /// Database rows: pages this node holds for certain.
    rows: Vec<String>,
    /// Pages this node shows as sub-page blocks.
    links: Vec<String>,
    parent: Option<usize>,
}

/// Collects the pages and databases, without rendering anything yet.
fn scan(export: &mut Export) -> Result<(Vec<Note>, HashMap<String, usize>), String> {
    let mut nodes = Vec::new();
    // Databases go after the pages, so their nodes start at `pages.len()`.
    let mut databases = Vec::new();
    let mut notion_ids = HashMap::new();
    for path in export.pages.clone() {
        let doc = export.html(&path)?;
        let root = doc.root_element();
        let stem = path.trim_end_matches(".html");
        let (dir, file) = (parent_of(stem), stem.rsplit('/').next().unwrap_or(stem));
        let child_dir = join(dir, strip_id(file));
        let title = first(root, "h1.page-title")
            .map(text)
            .unwrap_or_else(|| strip_id(file).to_string());
        let page = nodes.len();
        if let Some(id) = file.rsplit(' ').next().filter(|id| is_notion_id(id)) {
            notion_ids.insert(id.to_string(), page);
        }
        let links = root
            .select(&selector("figure.link-to-page a[href]"))
            .filter_map(|a| resolve(dir, a.attr("href")?))
            .collect();
        let mut rows = Vec::new();
        for collection in root.select(&selector(".page-body div.collection-content")) {
            // Rows live under the page's own folder, which also rules out cycles.
            let held: Vec<String> = collection
                .select(&selector("td.cell-title a[href]"))
                .filter_map(|a| resolve(dir, a.attr("href")?))
                .filter(|row| row.starts_with(&format!("{child_dir}/")))
                .collect();
            if is_full_page_database(root) {
                rows.extend(held);
                continue;
            }
            let title = first(collection, ".collection-title")
                .map(text)
                .unwrap_or_else(|| "Database".to_string());
            if let Some(id) = collection.attr("id") {
                notion_ids.insert(id.replace('-', ""), export.pages.len() + databases.len());
            }
            databases.push(Note {
                child_dir: join(&child_dir, &title),
                title,
                path: String::new(),
                rows: held,
                links: Vec::new(),
                parent: Some(page),
            });
        }
        nodes.push(Note {
            title,
            path,
            child_dir,
            rows,
            links,
            parent: None,
        });
    }
    nodes.extend(databases);
    assign_parents(&mut nodes);
    Ok((nodes, notion_ids))
}

/// A page is a full-page database when its body is only the database.
fn is_full_page_database(root: ElementRef) -> bool {
    first(root, ".page-body").is_some_and(|body| {
        let mut children = body.child_elements();
        children
            .next()
            .is_some_and(|only| has_class(only, "collection-content"))
            && children.next().is_none()
    })
}

/// A page's parent is the database listing it as a row, or else the page
/// whose sub-page folder holds it; with several pages of the same name,
/// the one that shows it as a sub-page.
fn assign_parents(nodes: &mut [Note]) {
    let mut row_owner = HashMap::new();
    let mut by_child_dir: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        for row in &node.rows {
            row_owner.entry(row.as_str()).or_insert(i);
        }
        by_child_dir
            .entry(node.child_dir.as_str())
            .or_default()
            .push(i);
    }
    let parents: Vec<Option<usize>> = nodes
        .iter()
        .map(|node| {
            if node.path.is_empty() {
                return node.parent;
            }
            row_owner.get(node.path.as_str()).copied().or_else(|| {
                let candidates = by_child_dir.get(parent_of(&node.path))?;
                candidates
                    .iter()
                    .copied()
                    .find(|&c| nodes[c].links.contains(&node.path))
                    .or(candidates.first().copied())
            })
        })
        .collect();
    for (node, parent) in nodes.iter_mut().zip(parents) {
        node.parent = parent;
    }
}

/// Note ids for every node: `<parent>/<title>`, with `-N` added while the
/// name is taken in this import or on disk.
fn place(nodes: &[Note], root: &Path, folder: &str, ignored: &[String]) -> Vec<String> {
    fn id_of(
        i: usize,
        nodes: &[Note],
        ids: &mut Vec<Option<String>>,
        taken: &mut HashSet<String>,
        root: &Path,
        folder: &str,
        ignored: &[String],
    ) -> String {
        if let Some(id) = &ids[i] {
            return id.clone();
        }
        let dir = match nodes[i].parent {
            Some(parent) => id_of(parent, nodes, ids, taken, root, folder, ignored),
            None => folder.to_string(),
        };
        let name = crate::sanitize_filename(&nodes[i].title);
        let base = join(&dir, &name);
        let mut id = base.clone();
        let mut counter = 1;
        // A page named like a folder the scanner skips would hide its sub-pages there.
        while crate::is_hidden_dir(id.rsplit('/').next().unwrap_or(&id), ignored)
            || taken.contains(&id.to_lowercase())
            || root.join(format!("{id}.md")).exists()
            || root.join(&id).exists()
        {
            id = format!("{base}-{counter}");
            counter += 1;
        }
        taken.insert(id.to_lowercase());
        ids[i] = Some(id.clone());
        id
    }
    let mut ids = vec![None; nodes.len()];
    let mut taken = HashSet::new();
    (0..nodes.len())
        .map(|i| id_of(i, nodes, &mut ids, &mut taken, root, folder, ignored))
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Paragraph,
    List,
    Other,
}

struct Block {
    markdown: String,
    kind: Kind,
}

impl Block {
    fn paragraph(markdown: String) -> Self {
        Self {
            markdown,
            kind: Kind::Paragraph,
        }
    }

    fn other(markdown: String) -> Self {
        Self {
            markdown,
            kind: Kind::Other,
        }
    }
}

/// Blocks separated by blank lines. The editor keeps a paragraph at the end
/// of a note, so after any other block it writes an empty one.
fn join_blocks(blocks: &[Block]) -> String {
    let mut out = blocks
        .iter()
        .map(|b| b.markdown.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if !blocks.last().is_some_and(|b| b.kind == Kind::Paragraph) {
        out.push_str("\n\n");
    }
    out
}

/// Prefixes the first line with `first` and indents the rest by `indent`.
fn prefix_lines(markdown: &str, first: &str, rest: &str) -> String {
    markdown
        .split('\n')
        .enumerate()
        .map(|(i, line)| match (i, line.is_empty()) {
            (0, _) => format!("{first}{line}"),
            (_, true) => rest.trim_end().to_string(),
            _ => format!("{rest}{line}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A markdown table as the editor writes it: columns padded to their widest
/// cell (in UTF-16 units, as JavaScript counts), between line breaks.
fn markdown_table(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let width = |s: &str| s.encode_utf16().count();
    let widths: Vec<usize> = (0..columns)
        .map(|i| {
            rows.iter()
                .filter_map(|r| r.get(i))
                .map(|c| width(c))
                .max()
                .unwrap_or(0)
                .max(3)
        })
        .collect();
    let line = |cells: Vec<&str>| {
        let padded: Vec<String> = cells
            .iter()
            .zip(&widths)
            .map(|(c, w)| format!("{c}{}", " ".repeat(w - width(c))))
            .collect();
        format!("| {} |\n", padded.join(" | "))
    };
    let row = |r: &Vec<String>| {
        line(
            (0..columns)
                .map(|i| r.get(i).map_or("", String::as_str))
                .collect(),
        )
    };
    let mut out = String::from("\n");
    if let Some(header) = rows.first() {
        out.push_str(&row(header));
        let dashes: Vec<String> = widths.iter().map(|w| "-".repeat(*w)).collect();
        out.push_str(&line(dashes.iter().map(String::as_str).collect()));
    }
    for r in rows.iter().skip(1) {
        out.push_str(&row(r));
    }
    out
}

fn table_cell(markdown: &str) -> String {
    markdown.trim().replace('\n', "<br>").replace('|', "\\|")
}

/// A YAML key or scalar, quoted when plain YAML would read it differently.
fn yaml(value: &str) -> String {
    let plain = value
        .chars()
        .all(|c| c.is_alphanumeric() || " _.-/".contains(c))
        && value.starts_with(char::is_alphanumeric)
        && !value.ends_with(' ')
        && !["true", "false", "yes", "no", "on", "off", "null"]
            .contains(&value.to_lowercase().as_str());
    if plain {
        value.to_string()
    } else {
        serde_json::to_string(value).expect("string serializes")
    }
}

fn checkbox(el: ElementRef) -> Option<bool> {
    first(el, "input[type=checkbox]").map(|input| input.attr("checked").is_some())
}

fn code_language(notion: &str) -> String {
    match notion.to_lowercase().as_str() {
        // Notion offers TypeScript but exports its blocks as `tsx`.
        "tsx" => "typescript".to_string(),
        "plain text" => String::new(),
        other => other.replace(' ', "-"),
    }
}

fn longest_backtick_run(text: &str) -> usize {
    text.split(|c| c != '`').map(str::len).max().unwrap_or(0)
}

/// `code` as a CommonMark code span: between more backticks than it holds,
/// with a space inside each end where the edge would otherwise merge with
/// them or lose a space.
fn inline_code(code: &str) -> String {
    let ticks = "`".repeat(longest_backtick_run(code) + 1);
    let pad = code.starts_with('`')
        || code.ends_with('`')
        || (code.starts_with(' ') && code.ends_with(' ') && !code.trim().is_empty());
    let space = if pad { " " } else { "" };
    format!("{ticks}{space}{code}{space}{ticks}")
}

fn image_width(img: ElementRef) -> Option<u32> {
    img.attr("style")?.split(';').find_map(|rule| {
        let px = rule
            .trim()
            .strip_prefix("width:")?
            .trim()
            .strip_suffix("px")?;
        px.trim().parse::<f64>().ok().map(|w| w.round() as u32)
    })
}

/// Where a link or image in the page points.
enum Target {
    Note(String),
    Asset(String),
    Url,
}

/// The page being rendered.
struct Page<'a> {
    /// Its folder in the export, against which its links resolve.
    dir: &'a str,
    /// Its note path (`<id>.md`), from which written links are relative.
    note: String,
    note_id: &'a str,
    full_page_database: bool,
}

struct Importer<'a> {
    root: &'a Path,
    export: Export,
    /// Note id for each page's export path.
    notes: HashMap<String, String>,
    /// Note id for each Notion page or database id.
    notion_ids: HashMap<String, String>,
    /// `assets/<name>` for each export file already copied.
    assets: HashMap<String, String>,
    /// Database index notes found while rendering a page: `(id, markdown)`.
    pending: Vec<(String, String)>,
    images: usize,
    files: usize,
    skipped: Vec<Skipped>,
}

impl Importer<'_> {
    fn skip(&mut self, page: &Page, reason: String) {
        self.skipped.push(Skipped {
            page: page.note_id.to_string(),
            reason,
        });
    }

    fn page(&mut self, page: &Page, doc: &Html) -> String {
        let root = doc.root_element();
        let mut blocks = Vec::new();
        let title = first(root, "h1.page-title").map(text).unwrap_or_default();
        let title = if title.is_empty() {
            "Untitled".to_string()
        } else {
            title
        };
        if let Some(properties) = first(root, "header table.properties") {
            blocks.push(Block::other(self.frontmatter(properties)));
        }
        blocks.push(Block::other(format!("# {}", escape(&title))));
        if let Some(header) = first(root, "article > header") {
            for el in header.child_elements() {
                if has_class(el, "page-description") {
                    let description = self.inline(page, el);
                    if !description.trim().is_empty() {
                        blocks.push(Block::paragraph(description.trim().to_string()));
                    }
                } else if !has_class(el, "page-title") && !has_class(el, "properties") {
                    let reason = format!(
                        "Unsupported page header element {}, not imported",
                        describe(el)
                    );
                    self.skip(page, reason);
                }
            }
        }
        if let Some(body) = first(root, ".page-body") {
            blocks.extend(self.blocks(page, body));
        }
        join_blocks(&blocks)
    }

    fn frontmatter(&mut self, properties: ElementRef) -> String {
        let mut lines = vec!["---".to_string()];
        for row in properties.select(&selector("tr")) {
            let (Some(name), Some(cell)) = (first(row, "th"), first(row, "td")) else {
                continue;
            };
            let key = yaml(&text(name));
            if let Some(checked) = checkbox(cell) {
                lines.push(format!("{key}: {checked}"));
            } else if has_class(row, "property-row-multi_select") {
                let values: Vec<String> = cell
                    .select(&selector(".selected-value"))
                    .map(|v| format!("  - {}", yaml(&text(v))))
                    .collect();
                if values.is_empty() {
                    lines.push(format!("{key}: []"));
                } else {
                    lines.push(format!("{key}:"));
                    lines.extend(values);
                }
            } else {
                let value = first(cell, "time")
                    .and_then(|t| t.attr("datetime").map(str::to_string))
                    .unwrap_or_else(|| text(cell));
                lines.push(format!("{key}: {}", yaml(&value)));
            }
        }
        lines.push("---".to_string());
        lines.join("\n")
    }

    /// The blocks in a container. Inline content between blocks becomes a
    /// paragraph, and Notion's one-item lists in a row become one list.
    fn blocks(&mut self, page: &Page, parent: ElementRef) -> Vec<Block> {
        let mut out = Vec::new();
        let mut inline = String::new();
        let children: Vec<NodeRef<Node>> = parent.children().collect();
        let mut i = 0;
        while i < children.len() {
            let child = children[i];
            i += 1;
            let Some(el) =
                ElementRef::wrap(child).filter(|e| BLOCK_TAGS.contains(&e.value().name()))
            else {
                inline.push_str(&self.inline_node(page, child));
                continue;
            };
            flush(&mut inline, &mut out);
            if let Some(kind) = list_kind(el) {
                let mut lists = vec![el];
                while let Some(next) = children
                    .get(i)
                    .and_then(|n| ElementRef::wrap(*n))
                    .filter(|n| list_kind(*n) == Some(kind))
                {
                    lists.push(next);
                    i += 1;
                }
                out.push(self.list(page, kind, &lists));
            } else {
                out.extend(self.block(page, el));
            }
        }
        flush(&mut inline, &mut out);
        out
    }

    fn block(&mut self, page: &Page, el: ElementRef) -> Vec<Block> {
        let name = el.value().name();
        let markdown = match name {
            "p" => {
                let text = self.inline(page, el);
                return if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![Block::paragraph(text.trim().to_string())]
                };
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = name[1..].parse().unwrap_or(1);
                format!("{} {}", "#".repeat(level), self.inline(page, el).trim())
            }
            "hr" => "---".to_string(),
            "pre" => {
                let language = el
                    .attr("data-notion-code-syntax")
                    .map(code_language)
                    .unwrap_or_default();
                let code: String = el.text().collect();
                let fence = "`".repeat(longest_backtick_run(&code).max(2) + 1);
                format!("{fence}{language}\n{code}\n{fence}")
            }
            "blockquote" => {
                let body = join_blocks_tight(&self.blocks(page, el), "\n\n");
                body.split('\n')
                    .map(|line| {
                        if line.is_empty() {
                            ">".to_string()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            "details" => self.toggle(page, el),
            "aside" if has_class(el, "callout") => self.callout(page, el),
            "figure" => return self.figure(page, el),
            "table" => self.table(page, el),
            "div" if has_class(el, "collection-content") => return self.database(page, el),
            "div"
                if el
                    .value()
                    .classes()
                    .all(|c| ["indented", "column-list", "column"].contains(&c)) =>
            {
                return self.blocks(page, el);
            }
            "script" | "style" | "link" => return Vec::new(),
            _ => return self.unsupported(page, el),
        };
        vec![Block::other(markdown)]
    }

    fn unsupported(&mut self, page: &Page, el: ElementRef) -> Vec<Block> {
        self.skip(
            page,
            format!("Unsupported block {}, kept as plain text", describe(el)),
        );
        let words: Vec<&str> = el.text().flat_map(str::split_whitespace).collect();
        if words.is_empty() {
            Vec::new()
        } else {
            vec![Block::paragraph(escape(&words.join(" ")))]
        }
    }

    fn list(&mut self, page: &Page, kind: &str, lists: &[ElementRef]) -> Block {
        let mut number: u64 = lists[0]
            .attr("start")
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let mut items = Vec::new();
        for item in lists
            .iter()
            .flat_map(|l| l.child_elements())
            .filter(|e| e.value().name() == "li")
        {
            let marker = match kind {
                "numbered-list" => {
                    number += 1;
                    format!("{}. ", number - 1)
                }
                "to-do-list" if checkbox(item) == Some(true) => "- [x] ".to_string(),
                "to-do-list" => "- [ ] ".to_string(),
                _ => "- ".to_string(),
            };
            let indent = if kind == "numbered-list" {
                " ".repeat(marker.len())
            } else {
                "  ".to_string()
            };
            let body = join_blocks_tight(&self.blocks(page, item), "\n");
            items.push(prefix_lines(&body, &marker, &indent));
        }
        Block {
            markdown: items.join("\n"),
            kind: Kind::List,
        }
    }

    fn toggle(&mut self, page: &Page, el: ElementRef) -> String {
        let summary = el
            .child_elements()
            .find(|e| e.value().name() == "summary")
            .map(text)
            .unwrap_or_default();
        let body = el
            .child_elements()
            .find(|e| has_class(*e, "indented"))
            .map(|content| join_blocks_tight(&self.blocks(page, content), "\n\n"))
            .unwrap_or_default();
        let body = if body.is_empty() {
            body
        } else {
            format!("{body}\n\n")
        };
        let title = summary
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!("<details><summary>{title}</summary>\n\n{body}</details>")
    }

    fn callout(&mut self, page: &Page, el: ElementRef) -> String {
        let icon = el
            .attr("data-notion-callout-icon")
            .filter(|icon| !icon.is_empty() && !icon.contains('/'))
            .map(|icon| format!(" {icon}"))
            .unwrap_or_default();
        let body = el
            .child_elements()
            .filter(|e| e.value().name() == "div")
            .last()
            .map(|content| join_blocks_tight(&self.blocks(page, content), "\n\n"))
            .unwrap_or_default();
        let mut lines = vec![format!("> [!note]{icon}")];
        lines.extend(body.split('\n').filter(|_| !body.is_empty()).map(|line| {
            if line.is_empty() {
                ">".to_string()
            } else {
                format!("> {line}")
            }
        }));
        lines.join("\n")
    }

    fn figure(&mut self, page: &Page, el: ElementRef) -> Vec<Block> {
        let mut blocks = if let Some(latex) = el.attr("data-notion-equation") {
            vec![Block::other(format!("$$\n{latex}\n$$"))]
        } else if has_class(el, "link-to-page") {
            first(el, "a")
                .map(|a| vec![Block::paragraph(self.link(page, a))])
                .unwrap_or_default()
        } else if let Some(img) = first(el, "img") {
            vec![self.image(page, img)]
        } else if let Some(bookmark) = first(el, "a.bookmark") {
            let href = bookmark.attr("href").unwrap_or("");
            let title = first(bookmark, ".bookmark-title")
                .map(text)
                .unwrap_or_default();
            let title = if title.is_empty() { href } else { &title };
            vec![Block::paragraph(format!("[{}]({href})", escape(title)))]
        } else if let Some(a) = first(el, "a[href]") {
            let link = self.link(page, a);
            // A link to a copied file is a file card, which is not a paragraph.
            let card = a
                .attr("href")
                .and_then(|href| resolve(page.dir, href))
                .is_some_and(|path| self.assets.contains_key(&path));
            vec![if card {
                Block::other(link)
            } else {
                Block::paragraph(link)
            }]
        } else {
            return self.unsupported(page, el);
        };
        if let Some(caption) = first(el, "figcaption") {
            let text = self.inline(page, caption);
            if !text.trim().is_empty() {
                blocks.push(Block::paragraph(text.trim().to_string()));
            }
        }
        blocks
    }

    fn image(&mut self, page: &Page, img: ElementRef) -> Block {
        let src = img.attr("src").unwrap_or("");
        let dest = match resolve(page.dir, src) {
            None => src.to_string(),
            Some(path) => match self.asset(&path, true) {
                Ok(asset) => relink::link(&page.note, &asset),
                Err(reason) => {
                    self.skip(page, reason);
                    return Block::paragraph(escape(&path));
                }
            },
        };
        match image_width(img) {
            Some(width) => Block::other(format!(
                r#"<img src="{}" width="{width}">"#,
                relink::escape_attribute(&dest)
            )),
            None => Block::other(format!("![]({dest})")),
        }
    }

    /// Copies an export file into `assets/` once; returns `assets/<name>`.
    fn asset(&mut self, path: &str, image: bool) -> Result<String, String> {
        if let Some(asset) = self.assets.get(path) {
            return Ok(asset.clone());
        }
        if !self.export.files.contains_key(path) {
            return Err(format!("{path} is not in the export"));
        }
        let assets_dir = self.root.join("assets");
        let copy = |export: &mut Export| -> Result<String, String> {
            std::fs::create_dir_all(&assets_dir).map_err(message)?;
            let name = crate::unique_asset_name(&assets_dir, Path::new(path));
            let mut out = File::create_new(assets_dir.join(&name)).map_err(message)?;
            export.copy(path, &mut out)?;
            Ok(format!("assets/{name}"))
        };
        let asset = copy(&mut self.export).map_err(|e| format!("Could not copy {path}: {e}"))?;
        if image {
            self.images += 1;
        } else {
            self.files += 1;
        }
        self.assets.insert(path.to_string(), asset.clone());
        Ok(asset)
    }

    /// What `a` points to, or why it cannot be linked.
    fn target(&mut self, page: &Page, a: ElementRef) -> Result<Target, String> {
        let href = a.attr("href").unwrap_or("");
        let Some(path) = resolve(page.dir, href) else {
            return Ok(Target::Url);
        };
        let by_page_id = || {
            a.attr("data-notion-page-id")
                .and_then(|id| self.notion_ids.get(&id.replace('-', "")))
                .cloned()
        };
        if let Some(id) = self.notes.get(&path).cloned().or_else(by_page_id) {
            return Ok(Target::Note(id));
        }
        if path.ends_with(".html") {
            return Err(format!("{path} is not in the export"));
        }
        self.asset(&path, false).map(Target::Asset)
    }

    fn link(&mut self, page: &Page, a: ElementRef) -> String {
        let href = a.attr("href").unwrap_or("");
        let words: Vec<&str> = a.text().flat_map(str::split_whitespace).collect();
        let label = if words.is_empty() {
            escape(href)
        } else {
            escape(&words.join(" "))
        };
        match self.target(page, a) {
            Ok(Target::Note(id)) => format!(
                "[{label}]({})",
                relink::link(&page.note, &format!("{id}.md"))
            ),
            Ok(Target::Asset(asset)) => format!("[{label}]({})", relink::link(&page.note, &asset)),
            Ok(Target::Url) => format!("[{label}]({href})"),
            Err(reason) => {
                self.skip(page, reason);
                label
            }
        }
    }

    /// A simple table; the first row is the header.
    fn table(&mut self, page: &Page, el: ElementRef) -> String {
        let rows: Vec<Vec<String>> = el
            .select(&selector("tr"))
            .map(|tr| {
                tr.child_elements()
                    .map(|cell| table_cell(&self.inline(page, cell)))
                    .collect()
            })
            .collect();
        markdown_table(&rows)
    }

    /// An inline database becomes an index note beside the rows' folder
    /// and a link to it; a full-page database is the page's own table.
    fn database(&mut self, page: &Page, el: ElementRef) -> Vec<Block> {
        if page.full_page_database {
            return vec![Block::other(self.collection_table(page, el))];
        }
        let id = el.attr("id").unwrap_or("").replace('-', "");
        let Some(note_id) = self.notion_ids.get(&id).cloned() else {
            return self.unsupported(page, el);
        };
        let index = Page {
            dir: page.dir,
            note: format!("{note_id}.md"),
            note_id: &note_id,
            full_page_database: false,
        };
        let title = first(el, ".collection-title").map(text).unwrap_or_default();
        let markdown = join_blocks(&[
            Block::other(format!("# {}", escape(&title))),
            Block::other(self.collection_table(&index, el)),
        ]);
        self.pending.push((note_id.clone(), markdown));
        let link = relink::link(&page.note, &index.note);
        vec![Block::paragraph(format!("[{}]({link})", escape(&title)))]
    }

    /// A database's rows as a table, with the titles linking to the row pages.
    fn collection_table(&mut self, page: &Page, el: ElementRef) -> String {
        let header: Vec<String> = el
            .select(&selector("thead th"))
            .map(|th| table_cell(&escape(&text(th))))
            .collect();
        let mut rows = vec![header];
        for tr in el.select(&selector("tbody tr")) {
            let cells = tr.child_elements().map(|td| {
                if let Some(a) = first(td, "a[href]").filter(|_| has_class(td, "cell-title")) {
                    return self.link(page, a);
                }
                if let Some(checked) = checkbox(td) {
                    return if checked { "Yes" } else { "No" }.to_string();
                }
                let values: Vec<String> = td
                    .select(&selector(".selected-value"))
                    .map(|v| escape(&text(v)))
                    .collect();
                if values.is_empty() {
                    self.inline(page, td)
                } else {
                    values.join(", ")
                }
            });
            rows.push(cells.map(|c| table_cell(&c)).collect());
        }
        markdown_table(&rows)
    }

    fn inline(&mut self, page: &Page, el: ElementRef) -> String {
        el.children()
            .map(|child| self.inline_node(page, child))
            .collect()
    }

    fn inline_node(&mut self, page: &Page, node: NodeRef<Node>) -> String {
        match node.value() {
            Node::Text(t) => escape(t),
            Node::Element(_) => ElementRef::wrap(node)
                .map(|el| self.inline_element(page, el))
                .unwrap_or_default(),
            _ => String::new(),
        }
    }

    fn inline_element(&mut self, page: &Page, el: ElementRef) -> String {
        if let Some(latex) = el.attr("data-notion-inline-equation") {
            return format!("${latex}$");
        }
        let wrap = |inner: String, open: &str, close: &str| {
            if inner.trim().is_empty() {
                inner
            } else {
                format!("{open}{inner}{close}")
            }
        };
        match el.value().name() {
            "br" => "  \n".to_string(),
            "a" => self.link(page, el),
            "img" => self.image(page, el).markdown,
            "code" => inline_code(&el.text().collect::<String>()),
            "input" | "script" | "style" => String::new(),
            "strong" | "b" => wrap(self.inline(page, el), "**", "**"),
            "em" | "i" => wrap(self.inline(page, el), "*", "*"),
            "del" | "s" => wrap(self.inline(page, el), "~~", "~~"),
            "u" => wrap(self.inline(page, el), "<u>", "</u>"),
            name => {
                let inner = self.inline(page, el);
                let color = el
                    .value()
                    .classes()
                    .find_map(|c| c.strip_prefix("highlight-"));
                if el
                    .attr("style")
                    .is_some_and(|s| s.contains("border-bottom"))
                {
                    wrap(inner, "<u>", "</u>")
                } else if color.is_some_and(|c| c.ends_with("_background"))
                    || (name == "mark" && color.is_none())
                {
                    wrap(inner, "<mark>", "</mark>")
                } else if let Some((_, hex)) = COLORS.iter().find(|(c, _)| Some(*c) == color) {
                    wrap(inner, &format!(r#"<span style="color: {hex}">"#), "</span>")
                } else {
                    inner
                }
            }
        }
    }
}

/// Blocks inside a list item, quote, toggle or callout. Lists follow the
/// line before them directly; other blocks are separated by `separator`.
fn join_blocks_tight(blocks: &[Block], separator: &str) -> String {
    let mut out = String::new();
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            out.push_str(if block.kind == Kind::List {
                "\n"
            } else {
                separator
            });
        }
        out.push_str(&block.markdown);
    }
    out
}

fn flush(inline: &mut String, out: &mut Vec<Block>) {
    let text = inline.trim();
    if !text.is_empty() {
        out.push(Block::paragraph(text.to_string()));
    }
    inline.clear();
}

fn list_kind(el: ElementRef) -> Option<&'static str> {
    let kind = ["bulleted-list", "numbered-list", "to-do-list"]
        .into_iter()
        .find(|kind| has_class(el, kind));
    kind.or(match el.value().name() {
        "ul" => Some("bulleted-list"),
        "ol" => Some("numbered-list"),
        _ => None,
    })
}

/// The folder to import into: `folder`, or a new `Notion Import` folder
/// (with `-N` when that name is taken).
fn destination(root: &Path, folder: Option<&str>) -> Result<String, String> {
    if let Some(folder) = folder {
        crate::validate_folder_path(folder)?;
        if !root.join(folder).is_dir() {
            return Err(format!("The folder \"{folder}\" does not exist"));
        }
        return Ok(folder.to_string());
    }
    let mut name = DEFAULT_FOLDER.to_string();
    let mut counter = 1;
    while root.join(&name).exists() || root.join(format!("{name}.md")).exists() {
        name = format!("{DEFAULT_FOLDER}-{counter}");
        counter += 1;
    }
    std::fs::create_dir_all(root.join(&name)).map_err(message)?;
    Ok(name)
}

/// Imports the Notion HTML export in `zips` (the parts of one export) into
/// `folder` under the notes folder `root`, or into a new `Notion Import`
/// folder. Calls `progress(written, total)` after each note.
pub fn import(
    root: &Path,
    zips: &[PathBuf],
    folder: Option<&str>,
    ignored: &[String],
    mut progress: impl FnMut(usize, usize),
) -> Result<Summary, String> {
    let mut skipped = Vec::new();
    let mut export = Export::open(zips, &mut skipped)?;
    if export.pages.is_empty() {
        return Err(
            "No Notion pages found. In Notion, export as HTML with sub-pages included.".to_string(),
        );
    }
    let (nodes, node_ids) = scan(&mut export)?;
    let folder = destination(root, folder)?;
    let ids = place(&nodes, root, &folder, ignored);
    let mut importer = Importer {
        root,
        notes: nodes
            .iter()
            .zip(&ids)
            .filter(|(node, _)| !node.path.is_empty())
            .map(|(node, id)| (node.path.clone(), id.clone()))
            .collect(),
        notion_ids: node_ids
            .into_iter()
            .map(|(notion_id, node)| (notion_id, ids[node].clone()))
            .collect(),
        export,
        assets: HashMap::new(),
        pending: Vec::new(),
        images: 0,
        files: 0,
        skipped,
    };
    let total = nodes.len();
    let mut written = 0;
    let mut write = |id: &str, markdown: &str| -> Result<(), String> {
        let path = root.join(format!("{id}.md"));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(message)?;
        }
        std::fs::write(&path, markdown).map_err(|e| format!("Could not write {id}.md: {e}"))?;
        written += 1;
        progress(written, total);
        Ok(())
    };
    for (node, id) in nodes
        .iter()
        .zip(&ids)
        .filter(|(node, _)| !node.path.is_empty())
    {
        let doc = importer.export.html(&node.path)?;
        let page = Page {
            dir: parent_of(&node.path),
            note: format!("{id}.md"),
            note_id: id,
            full_page_database: is_full_page_database(doc.root_element()),
        };
        let markdown = importer.page(&page, &doc);
        write(id, &markdown)?;
        for (index_id, index) in std::mem::take(&mut importer.pending) {
            write(&index_id, &index)?;
        }
    }
    Ok(Summary {
        folder,
        pages: written,
        images: importer.images,
        files: importer.files,
        skipped: importer.skipped,
    })
}
