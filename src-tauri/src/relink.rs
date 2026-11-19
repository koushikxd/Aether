//! Keeps relative links and image paths pointing at the same files after
//! notes, folders, or assets move inside the notes folder.

use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;
use walkdir::WalkDir;

/// A file or folder that moved, as `(from, to)` paths relative to the notes
/// folder with `/` separators: `("Note.md", "a/b/Note.md")` or `("Projects", "Archive/Projects")`.
pub type Move = (String, String);

static IMG_SRC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\s[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("valid regex")
});

/// The start of a reference definition, `[id]: `, up to its destination.
static LINK_DEFINITION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}\[[^\]]+\]:[ \t]*").expect("valid regex"));

static LIST_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:[-+*]|\d{1,9}[.)])(?:\s|$)").expect("valid regex"));

/// A note that moved: its paths relative to the notes folder before and
/// after, and its markdown now.
pub struct Moved {
    pub old_path: String,
    pub new_path: String,
    pub markdown: String,
}

/// Where `path` lands if `from` moved to `to`, or None when it is not inside `from`.
fn relocate(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(format!("{to}/{rest}"))
}

pub fn after_moves(path: &str, moves: &[Move]) -> String {
    moves
        .iter()
        .find_map(|(from, to)| relocate(path, from, to))
        .unwrap_or_else(|| path.to_string())
}

fn parent_dir(path: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    parts.pop();
    parts
}

/// Joins a relative path onto `dir`, resolving `.` and `..`. None when it
/// climbs above the notes folder.
fn resolve(dir: &[&str], relative: &str) -> Option<String> {
    let mut out: Vec<&str> = dir.to_vec();
    for part in relative.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            _ => out.push(part),
        }
    }
    Some(out.join("/"))
}

fn relative_to(dir: &[&str], target: &str) -> String {
    let target: Vec<&str> = target.split('/').collect();
    let shared = dir
        .iter()
        .zip(&target[..target.len() - 1])
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts = vec![".."; dir.len() - shared];
    parts.extend(&target[shared..]);
    parts.join("/")
}

/// Percent-encodes what would end or break a link destination, as
/// `src/lib/assetPaths.ts` does.
fn encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_whitespace() || "%<>()#?".contains(c) {
            let mut buf = [0; 4];
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Link destination, as stored in markdown, from the note at `from` to the
/// file `target`, both relative to the notes folder.
pub fn link(from: &str, target: &str) -> String {
    encode(&relative_to(&parent_dir(from), target))
}

/// A URL with a scheme (or a Windows drive letter) or an absolute path.
pub fn is_absolute(dest: &str) -> bool {
    if dest.starts_with(['/', '\\']) {
        return true;
    }
    dest.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    })
}

/// End of a markdown link destination that starts at `start`: `<...>` or a
/// run without whitespace and with balanced parentheses.
fn destination_end(text: &str, start: usize) -> Option<usize> {
    let rest = &text[start..];
    if rest.starts_with('<') {
        return rest.find('>').map(|i| start + i + 1);
    }
    let mut depth = 0;
    let mut chars = rest.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '(' => depth += 1,
            ')' if depth == 0 => return Some(start + i),
            ')' => depth -= 1,
            c if c.is_whitespace() => return Some(start + i),
            _ => {}
        }
    }
    Some(text.len())
}

/// Byte ranges of the link and image destinations in a run of markdown that
/// holds no code, each flagged when it is an HTML attribute value. A run at
/// the start of a line can be a reference definition.
fn destinations(text: &str, line_start: bool) -> Vec<(usize, usize, bool)> {
    let mut found: Vec<(usize, usize, bool)> = text
        .match_indices("](")
        .filter_map(|(i, _)| {
            let start = i + 2;
            destination_end(text, start).map(|end| (start, end, false))
        })
        .collect();
    for caps in IMG_SRC.captures_iter(text) {
        if let Some(src) = caps.get(1).or_else(|| caps.get(2)) {
            found.push((src.start(), src.end(), true));
        }
    }
    if let Some(definition) = LINK_DEFINITION.find(text).filter(|_| line_start) {
        let start = definition.end();
        found.extend(destination_end(text, start).map(|end| (start, end, false)));
    }
    found.sort_unstable();
    found
}

/// Splits a line into `(is_code, text)` runs, treating backtick code spans as code.
fn code_spans(line: &str) -> Vec<(bool, &str)> {
    let bytes = line.as_bytes();
    let mut ticks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        while i < bytes.len() && bytes[i] == b'`' {
            i += 1;
        }
        if i > start {
            ticks.push((start, i - start));
        } else {
            i += 1;
        }
    }
    let mut runs = Vec::new();
    let mut text_start = 0;
    let mut k = 0;
    while k < ticks.len() {
        let (open, len) = ticks[k];
        match ticks[k + 1..].iter().position(|&(_, l)| l == len) {
            Some(p) => {
                let close = ticks[k + 1 + p].0 + len;
                runs.push((false, &line[text_start..open]));
                runs.push((true, &line[open..close]));
                text_start = close;
                k += p + 2;
            }
            None => k += 1,
        }
    }
    runs.push((false, &line[text_start..]));
    runs
}

/// The fence character and length when `line` opens or closes a fenced code
/// block. A backtick fence's info string holds no backticks, so a line that
/// starts with inline code such as "```js``` text" is not one.
fn fence(line: &str) -> Option<(char, usize)> {
    let body = line.trim_start_matches([' ', '\t', '>']);
    let c = body.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = body.len() - body.trim_start_matches(c).len();
    (len >= 3 && !(c == '`' && body[len..].contains('`'))).then_some((c, len))
}

/// Columns of leading whitespace, with a tab reaching the next multiple of 4.
fn indentation(line: &str) -> usize {
    let mut columns = 0;
    for c in line.chars() {
        match c {
            ' ' => columns += 1,
            '\t' => columns += 4 - columns % 4,
            _ => break,
        }
    }
    columns
}

/// The file a link destination in a note in `dir` points to, relative to the
/// notes folder, and its `?query#fragment`. None for URLs, absolute paths,
/// anchors, and paths that climb above the notes folder.
fn link_target<'a>(dir: &[&str], dest: &'a str) -> Option<(String, &'a str)> {
    let dest = dest
        .strip_prefix('<')
        .and_then(|d| d.strip_suffix('>'))
        .unwrap_or(dest);
    let (path, suffix) = dest.split_at(dest.find(['?', '#']).unwrap_or(dest.len()));
    if path.is_empty() || is_absolute(path) {
        return None;
    }
    Some((resolve(dir, &urlencoding::decode(path).ok()?)?, suffix))
}

/// Undoes the escaping of `escape_attribute`.
fn unescape_attribute(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// Escapes an HTML attribute value as `src/components/editor/ResizableImage.ts`
/// does when it saves an `<img>`.
pub fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

/// Replaces each link and image destination in `markdown` for which `f`
/// returns a new one. Destinations in code are skipped.
fn map_destinations(markdown: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut open_fence: Option<(char, usize)> = None;
    // An indented line is code after a blank line or more code, outside lists.
    // Lists are tracked roughly: from an item to the next unindented line
    // after a blank one.
    let mut after_blank = true;
    let mut in_indented_code = false;
    let mut in_list = false;
    for line in markdown.split_inclusive('\n') {
        if let Some((c, len)) = open_fence {
            let closes = fence(line).is_some_and(|(c2, len2)| c2 == c && len2 >= len)
                && line.trim_end().ends_with(c);
            if closes {
                open_fence = None;
                after_blank = true;
            }
            out.push_str(line);
            continue;
        }
        if line.trim().is_empty() {
            after_blank = true;
            out.push_str(line);
            continue;
        }
        let blank_before = std::mem::replace(&mut after_blank, false);
        let indent = indentation(line);
        in_indented_code = indent >= 4 && !in_list && (blank_before || in_indented_code);
        if in_indented_code {
            out.push_str(line);
            continue;
        }
        if let Some(opened) = fence(line) {
            open_fence = Some(opened);
            out.push_str(line);
            continue;
        }
        if LIST_ITEM.is_match(line) {
            in_list = true;
        } else if indent == 0 && blank_before {
            in_list = false;
        }
        for (i, (is_code, text)) in code_spans(line).into_iter().enumerate() {
            if is_code {
                out.push_str(text);
                continue;
            }
            let mut cursor = 0;
            for (start, end, html) in destinations(text, i == 0) {
                if start < cursor {
                    continue;
                }
                let dest = &text[start..end];
                let new_dest = if html {
                    f(&unescape_attribute(dest)).map(|d| escape_attribute(&d))
                } else {
                    f(dest)
                };
                if let Some(new_dest) = new_dest {
                    out.push_str(&text[cursor..start]);
                    out.push_str(&new_dest);
                    cursor = end;
                }
            }
            out.push_str(&text[cursor..]);
        }
    }
    out
}

/// Rewrites the relative destinations in `markdown`, the content of a note
/// that moved from `old_path` to `new_path` (the same path when it stayed),
/// so they point at the same files after `moves`. Links into a moved file or
/// folder follow it, and a moved note's links to other files or folders under
/// `root` keep pointing at them. Anything else (URLs without a scheme such as
/// `example.com`, missing files, absolute paths, anchors, wikilinks, code) is
/// left alone, and `?query#fragment`s are kept as written.
pub fn rewrite_links(
    root: &Path,
    markdown: &str,
    old_path: &str,
    new_path: &str,
    moves: &[Move],
) -> String {
    let old_dir = parent_dir(old_path);
    let new_dir = parent_dir(new_path);
    map_destinations(markdown, |dest| {
        let (target, suffix) = link_target(&old_dir, dest)?;
        let moved_target = after_moves(&target, moves);
        if moved_target == target && (old_dir == new_dir || !root.join(&target).exists()) {
            return None;
        }
        Some(format!(
            "{}{suffix}",
            encode(&relative_to(&new_dir, &moved_target))
        ))
    })
}

/// Paths, relative to the notes folder, of the files that the relative links
/// and images in `markdown`, the note at `note_path`, point to.
pub fn linked_paths(markdown: &str, note_path: &str) -> Vec<String> {
    let dir = parent_dir(note_path);
    let mut paths = Vec::new();
    map_destinations(markdown, |dest| {
        paths.extend(link_target(&dir, dest).map(|(target, _)| target));
        None
    });
    paths
}

/// Applies `rewrite_links` to every note under `root` after `moves` have
/// happened on disk. Returns the notes that moved. A note whose new links
/// cannot be written keeps its old ones.
pub fn relink_notes(root: &Path, moves: &[Move], ignored_dirs: &[String]) -> Vec<Moved> {
    let mut moved = Vec::new();
    let entries = WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| super::is_visible_notes_entry(e, ignored_dirs))
        .flatten();
    for entry in entries {
        let Some(id) = super::id_from_abs_path(root, entry.path(), ignored_dirs) else {
            continue;
        };
        // Not UTF-8, so not a note Aether can edit.
        let Ok(markdown) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let new_path = format!("{id}.md");
        let old_path = moves
            .iter()
            .find_map(|(from, to)| relocate(&new_path, to, from))
            .unwrap_or_else(|| new_path.clone());
        let rewritten = rewrite_links(root, &markdown, &old_path, &new_path, moves);
        let markdown = if rewritten == markdown {
            markdown
        } else {
            match std::fs::write(entry.path(), &rewritten) {
                Ok(()) => rewritten,
                Err(e) => {
                    eprintln!("Failed to update links in {new_path}: {e}");
                    markdown
                }
            }
        };
        if old_path != new_path {
            moved.push(Moved {
                old_path,
                new_path,
                markdown,
            });
        }
    }
    moved
}
