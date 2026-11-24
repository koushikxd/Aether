// Runs in the browser before the app (injected by tests/e2e/app.ts).
// Fakes the Tauri backend with an in-memory notes folder.
import { emit } from "@tauri-apps/api/event";
import { mergeHandlers } from "./fake-merge";
import { vaultHandlers } from "./fake-vault";
import {
  mockConvertFileSrc,
  mockIPC,
  mockWindows,
} from "@tauri-apps/api/mocks";

const NOTES_ROOT = "/fake/notes";

/** Relative path (with extension, `/` separators) to file content. */
export type FakeFiles = Record<string, string>;

export interface FakeCall {
  cmd: string;
  args: Record<string, unknown>;
}

export interface FakeBackend {
  files: FakeFiles;
  calls: FakeCall[];
  unhandled: string[];
  /** Path or paths the next file-picker dialog returns (null = cancelled). */
  pickedFile: string | string[] | null;
  /** Ends the pending `import_notion` call: writes the files, returns the summary. */
  finishNotionImport: ((files: FakeFiles, summary: unknown) => void) | null;
  /** Holds calls to `cmd` (a slow backend) until `release(cmd)` runs them in order. */
  hold: (cmd: string) => void;
  release: (cmd: string) => void;
  emit: (event: string, payload: unknown) => Promise<void>;
  /** Birth time `get_note_info` reports for every note (null = the platform has none). */
  noteCreated: number | null;
  /** Ms `move_note` takes after the watcher reports the move (0 = no report). */
  moveLag: number;
}

declare global {
  interface Window {
    aetherFakeSeed?: FakeFiles;
    aetherFake?: FakeBackend;
    /** Use Windows display URLs (`http://asset.localhost/...`), which a test can serve. */
    aetherFakeWindowsUrls?: boolean;
    /** No notes folder chosen yet, as on first launch. */
    aetherFakeNoFolder?: boolean;
  }
}

interface NoteMetadata {
  id: string;
  title: string;
  preview: string;
  modified: number;
}

interface Note extends NoteMetadata {
  content: string;
  path: string;
}

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

const SETTINGS_PATH = ".aether/settings.json";
const DEFAULT_IGNORED_DIRS = [
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
// EXCLUDED_DIRS + DEFAULT_IGNORED_DIRS from lib.rs (`ignoredPatterns` is not honored).
const HIDDEN_DIRS = new Set([
  ".git",
  ".aether",
  ".obsidian",
  ".trash",
  "assets",
  ...DEFAULT_IGNORED_DIRS,
]);
// Rust `Settings::default()` serialized: every Option is null.
const DEFAULT_SETTINGS: Args = {
  theme: { mode: "system", customLightColors: null, customDarkColors: null },
  editorFont: null,
  gitEnabled: null,
  pinnedNoteIds: null,
  textDirection: null,
  editorWidth: null,
  defaultNoteName: null,
  interfaceZoom: null,
  customEditorWidthPx: null,
  sidebarWidthPx: null,
  ollamaModel: null,
  ignoredPatterns: null,
  customColorsLight: null,
  customColorsDark: null,
};

const files: FakeFiles = { ...window.aetherFakeSeed };
const modified = new Map<string, number>();
const calls: FakeCall[] = [];
const unhandled: string[] = [];
let clock = Math.floor(Date.now() / 1000);
/** When the seeded files were written: older than any save in the test. */
const seededAt = clock;

function writeFile(path: string, content: string) {
  files[path] = content;
  modified.set(path, (clock += 1));
}

function isArgs(value: unknown): value is Args {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value)
  );
}

function asArgs(value: unknown): Args {
  if (value === undefined) return {};
  if (isArgs(value)) return value;
  throw new Error("[fake-backend] expected object args");
}

function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`[fake-backend] arg "${key}" must be a string`);
  }
  return value;
}

function optStr(args: Args, key: string): string | null {
  const value = args[key];
  return value === undefined || value === null ? null : str(args, key);
}

function isNoteFile(path: string): boolean {
  const dirs = path.split("/").slice(0, -1);
  return path.endsWith(".md") && !dirs.some((d) => HIDDEN_DIRS.has(d));
}

function stripFrontmatter(content: string): string {
  const match = /^\s*---[\s\S]*?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

// Mirrors extract_title in src-tauri/src/lib.rs.
function extractTitle(content: string): string {
  for (const line of stripFrontmatter(content).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ") && trimmed.slice(2).trim()) {
      return trimmed.slice(2).trim();
    }
    if (trimmed) return trimmed.slice(0, 50);
  }
  return "Untitled";
}

// Simplified generate_preview: first non-empty line after the title.
function generatePreview(content: string): string {
  const lines = stripFrontmatter(content).split("\n").slice(1);
  const line = lines.find((l) => l.trim()) ?? "";
  return line
    .trim()
    .replace(/^#+\s*|[*_`~]/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .slice(0, 100);
}

function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[\u00A0\uFEFF]/g, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .trim();
  return cleaned || "Untitled";
}

function leafName(id: string): string {
  return id.split("/").pop() ?? id;
}

// Mirrors bare_page_dir: a visible folder with no page file of its own.
function isBarePage(id: string): boolean {
  const leaf = leafName(id);
  return (
    !(`${id}.md` in files) &&
    !leaf.startsWith(".") &&
    !HIDDEN_DIRS.has(leaf) &&
    hasFolder(id)
  );
}

// bare_page_markdown: what a bare page reads as until its file exists.
function bareMarkdown(id: string): string {
  return `# ${leafName(id)}\n`;
}

function metadata(id: string): NoteMetadata {
  const path = `${id}.md`;
  if (isBarePage(id)) {
    // Rust gives the folder's mtime; the newest file under it stands in.
    const times = Object.keys(files)
      .filter((p) => p.startsWith(`${id}/`))
      .map((p) => modified.get(p) ?? seededAt);
    return {
      id,
      title: leafName(id),
      preview: "",
      modified: Math.max(...times),
    };
  }
  const content = files[path];
  return {
    id,
    title: extractTitle(content),
    preview: generatePreview(content),
    modified: modified.get(path) ?? seededAt,
  };
}

function note(id: string): Note {
  const path = `${id}.md`;
  return {
    ...metadata(id),
    content: files[path] ?? bareMarkdown(id),
    path: `${NOTES_ROOT}/${path}`,
  };
}

// Mirrors create_bare_page_file, for actions that need the page's file.
function createBarePageFile(id: string) {
  if (isBarePage(id)) writeFile(`${id}.md`, bareMarkdown(id));
}

function readSettings(): Args {
  const raw = files[SETTINGS_PATH];
  const stored: unknown = raw ? JSON.parse(raw) : {};
  return { ...DEFAULT_SETTINGS, ...asArgs(stored) };
}

// ALLOWED_IMAGE_EXTENSIONS in copy_image_to_assets.
const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "avif",
]);
// Leading bytes per type, as sniffed by image_extension in lib.rs.
const IMAGE_SIGNATURES: [string, string][] = [
  ["\x89PNG", "png"],
  ["\xff\xd8\xff", "jpg"],
  ["GIF8", "gif"],
  ["BM", "bmp"],
  ["II*\0", "tiff"],
  ["MM\0*", "tiff"],
];

// `assets/<stem>.<ext>`, adding `-N` to the stem while the name is taken.
function freeAssetPath(stem: string, ext: string): string {
  let path = `assets/${stem}.${ext}`;
  for (let n = 1; path in files; n += 1) path = `assets/${stem}-${n}.${ext}`;
  return path;
}

function copyImageToAssets(args: Args): Promise<string> | string {
  const name = str(args, "sourcePath").split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot + 1);
  if (dot <= 0 || !IMAGE_EXTENSIONS.has(ext.toLowerCase())) {
    return Promise.reject("Only image files can be copied to assets");
  }
  const path = freeAssetPath(sanitizeFilename(name.slice(0, dot)), ext);
  writeFile(path, `copied from ${str(args, "sourcePath")}`);
  return path;
}

// Mirrors copy_file_to_assets: any file, by its sanitized name.
function copyFileToAssets(args: Args): string {
  const source = str(args, "sourcePath");
  const name = source.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const [stem, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let path = `assets/${sanitizeFilename(stem)}${ext}`;
  for (let n = 1; path in files; n += 1) {
    path = `assets/${sanitizeFilename(stem)}-${n}${ext}`;
  }
  writeFile(path, `copied from ${source}`);
  return path;
}

/** Mirrors asset_file: the `path` arg as a file in the notes folder's assets/, or null. */
function assetFile(args: Args): string | null {
  const prefix = `${NOTES_ROOT}/`;
  const path = str(args, "path");
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  return rel.startsWith("assets/") && rel in files ? rel : null;
}

function getAssetSize(args: Args): Promise<number> | number {
  const rel = assetFile(args);
  if (!rel) return Promise.reject("Not a file in the assets folder");
  return files[rel].length;
}

function openAsset(args: Args): Promise<never> | null {
  return assetFile(args)
    ? null
    : Promise.reject("Not a file in the assets folder");
}

function saveClipboardImage(args: Args): Promise<string> | string {
  const bytes = atob(str(args, "base64Data"));
  const webp = bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  const ext = webp
    ? "webp"
    : IMAGE_SIGNATURES.find(([magic]) => bytes.startsWith(magic))?.[1];
  if (!ext) return Promise.reject("Unsupported image type");
  const path = freeAssetPath(
    `screenshot-${Math.floor(Date.now() / 1000)}`,
    ext,
  );
  writeFile(path, str(args, "base64Data"));
  return path;
}

type Move = [from: string, to: string];

function relocate(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

function parentDir(path: string): string[] {
  return path.split("/").slice(0, -1);
}

function resolve(dir: string[], relative: string): string | null {
  const out = [...dir];
  for (const part of relative.split("/")) {
    if (part === "..") {
      if (!out.pop()) return null;
    } else if (part && part !== ".") {
      out.push(part);
    }
  }
  return out.join("/");
}

function relativeTo(dir: string[], target: string): string {
  const parts = target.split("/");
  let shared = 0;
  while (shared < dir.length && shared < parts.length - 1) {
    if (dir[shared] !== parts[shared]) break;
    shared += 1;
  }
  return [...dir.slice(shared).map(() => ".."), ...parts.slice(shared)]
    .join("/")
    .replace(/[\s%<>()#?]/g, encodeURIComponent);
}

// relink_notes in src-tauri/src/relink.rs, without its code-block and
// angle-bracket handling: re-points relative links after files moved.
function relink(moves: Move[]) {
  const moved = (path: string, back = false) =>
    moves
      .map(([from, to]) =>
        back ? relocate(path, to, from) : relocate(path, from, to),
      )
      .find((p) => p !== null) ?? path;
  for (const path of Object.keys(files).filter(isNoteFile)) {
    const oldDir = parentDir(moved(path, true));
    const newDir = parentDir(path);
    const content = files[path].replace(
      /(\]\(|src=")([^\s)"]+)/g,
      (match, lead: string, dest: string) => {
        const hash = dest.indexOf("#");
        const link = hash < 0 ? dest : dest.slice(0, hash);
        if (!link || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(link)) return match;
        const target = resolve(oldDir, decodeURIComponent(link));
        if (target === null) return match;
        const next = moved(target);
        if (next === target && oldDir.join("/") === newDir.join("/")) {
          return match;
        }
        const fragment = hash < 0 ? "" : dest.slice(hash);
        return `${lead}${relativeTo(newDir, next)}${fragment}`;
      },
    );
    if (content !== files[path]) writeFile(path, content);
  }
}

// Folders exist only through the files in them, so an emptied sub-page
// folder disappears on its own (Rust removes it explicitly).
function hasFolder(path: string): boolean {
  return Object.keys(files).some((p) => p.startsWith(`${path}/`));
}

/** Moves a file, or every file under a folder, keeping modified times. */
function moveFiles(from: string, to: string) {
  for (const path of Object.keys(files)) {
    const next = relocate(path, from, to);
    if (next === null) continue;
    files[next] = files[path];
    modified.set(next, modified.get(path) ?? seededAt);
    delete files[path];
  }
}

// follow_moved_ids: pinned ids follow their notes; settings are written only on change.
function followPins(moves: Move[]) {
  const settings = readSettings();
  const pinned = settings.pinnedNoteIds;
  if (!Array.isArray(pinned)) return;
  const followed = pinned.map((id: unknown) => {
    if (typeof id !== "string") return id;
    const path = moves
      .map(([from, to]) => relocate(`${id}.md`, from, to))
      .find((p) => p !== null);
    return path ? path.slice(0, -3) : id;
  });
  if (followed.every((id, i) => id === pinned[i])) return;
  settings.pinnedNoteIds = followed;
  writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Mirrors move_note: keeps the leaf name, takes the sub-page folder along,
// follows pins, rewrites links.
function moveNote(args: Args): Promise<string> | string {
  const id = str(args, "id");
  const target = str(args, "targetFolder");
  const leaf = id.split("/").pop() ?? id;
  const newId = target ? `${target}/${leaf}` : leaf;
  if (!(`${id}.md` in files) && !isBarePage(id)) {
    return Promise.reject("Note not found");
  }
  if (newId === id) return id;
  if (target === id || target.startsWith(`${id}/`)) {
    return Promise.reject("Cannot move a page into its own sub-pages");
  }
  const subPages = hasFolder(id);
  if (`${newId}.md` in files || (subPages && hasFolder(newId))) {
    return Promise.reject(
      "A note with that name already exists in the target folder",
    );
  }
  createBarePageFile(id);
  const moves: Move[] = [[`${id}.md`, `${newId}.md`]];
  if (subPages) moves.push([id, newId]);
  moves.forEach(([from, to]) => moveFiles(from, to));
  followPins(moves);
  relink(moves);
  if (!fake.moveLag) return newId;
  // The real watcher reports the rename at once, while relinking still runs
  return emit("file-change", { changed_ids: [id, newId] }).then(
    () => new Promise((done) => setTimeout(() => done(newId), fake.moveLag)),
  );
}

// Mirrors save_note: the file is named after the H1 and renamed, with its
// sub-page folder, when it changes.
function saveNote(args: Args): Note {
  const id = optStr(args, "id");
  const content = str(args, "content");
  const leaf = sanitizeFilename(extractTitle(content));
  const slash = id?.lastIndexOf("/") ?? -1;
  const prefix = id && slash >= 0 ? `${id.slice(0, slash)}/` : "";
  const subPages = id !== null && hasFolder(id);
  const taken = (candidate: string) =>
    `${candidate}.md` in files || (subPages && hasFolder(candidate));
  let newId = `${prefix}${leaf}`;
  for (let n = 1; newId !== id && taken(newId); n += 1) {
    newId = `${prefix}${leaf}-${n}`;
  }
  writeFile(`${newId}.md`, content);
  if (id && id !== newId) {
    delete files[`${id}.md`];
    const moves: Move[] = [[`${id}.md`, `${newId}.md`]];
    if (subPages) {
      moveFiles(id, newId);
      moves.push([id, newId]);
    }
    followPins(moves);
    relink(moves);
  }
  return note(newId);
}

// Mirrors create_note with the default "Untitled" name template.
function createNote(args: Args): Note {
  const folder = optStr(args, "targetFolder");
  const hidden = folder?.split("/").find((dir) => HIDDEN_DIRS.has(dir));
  if (hidden) {
    // Commands reject with a string, as Tauri does for Err(String)
    throw `The sidebar hides notes in a folder named "${hidden}". Rename the page first.`;
  }
  const base = folder ? `${folder}/Untitled` : "Untitled";
  let id = base;
  for (let n = 1; `${id}.md` in files; n += 1) id = `${base}-${n}`;
  writeFile(`${id}.md`, "# Untitled\n\n");
  return note(id);
}

// Mirrors delete_note: a page takes its sub-page folder with it.
function deleteNote(args: Args): null {
  const id = str(args, "id");
  delete files[`${id}.md`];
  for (const path of Object.keys(files)) {
    if (path.startsWith(`${id}/`)) delete files[path];
  }
  return null;
}

// Mirrors sub_page_counts: what deleteNote takes along besides the note.
function subPageCounts(args: Args): { subPages: number; otherFiles: number } {
  const id = str(args, "id");
  const counts = { subPages: 0, otherFiles: 0 };
  if (HIDDEN_DIRS.has(id.split("/").pop() ?? "")) return counts;
  for (const path of Object.keys(files)) {
    if (!path.startsWith(`${id}/`)) continue;
    if (isNoteFile(path)) counts.subPages += 1;
    else counts.otherFiles += 1;
  }
  return counts;
}

// Case-insensitive substring match over each line, title line included (the
// Rust phrase matching has its own tests). `preview` is the first matching line.
function searchNotes(args: Args) {
  const query = str(args, "query").trim().toLowerCase();
  return Object.keys(files)
    .filter(isNoteFile)
    .flatMap((path) => {
      const lines = stripFrontmatter(files[path]).split("\n");
      const line = lines.find((l) => l.toLowerCase().includes(query));
      if (line === undefined) return [];
      const meta = metadata(path.slice(0, -3));
      return [{ ...meta, preview: line.trim(), score: 1 }];
    });
}

// Calls waiting on a held command, run in order on release.
const held = new Map<string, (() => void)[]>();

const fake: FakeBackend = {
  files,
  calls,
  unhandled,
  pickedFile: null,
  finishNotionImport: null,
  hold: (cmd) => {
    held.set(cmd, held.get(cmd) ?? []);
  },
  release: (cmd) => {
    const waiting = held.get(cmd) ?? [];
    held.delete(cmd);
    waiting.forEach((run) => run());
  },
  emit,
  // 2026-03-15 12:00 UTC: the same calendar day in every time zone.
  noteCreated: 1773576000,
  moveLag: 0,
};

const handlers: Record<string, Handler> = {
  get_notes_folder: () => (window.aetherFakeNoFolder ? null : NOTES_ROOT),
  start_file_watcher: () => null,
  list_notes: () => {
    const ids = readSettings().pinnedNoteIds;
    const pinned = new Set<unknown>(Array.isArray(ids) ? ids : []);
    const folders = new Set<string>();
    for (const path of Object.keys(files)) {
      const dirs = parentDir(path);
      const hidden = dirs.findIndex((d) => HIDDEN_DIRS.has(d));
      const visible = hidden < 0 ? dirs : dirs.slice(0, hidden);
      visible.forEach((_, i) => folders.add(visible.slice(0, i + 1).join("/")));
    }
    const notes = [
      ...Object.keys(files)
        .filter(isNoteFile)
        .map((path) => path.slice(0, -3)),
      ...[...folders].filter(isBarePage),
    ].map(metadata);
    notes.sort(
      (a, b) =>
        Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
        b.modified - a.modified,
    );
    return notes;
  },
  read_note: (args) => {
    const id = str(args, "id");
    if (!(`${id}.md` in files) && !isBarePage(id)) {
      return Promise.reject("Note not found");
    }
    return note(id);
  },
  get_note_info: (args) => {
    const id = str(args, "id");
    if (!(`${id}.md` in files) && !isBarePage(id)) {
      return Promise.reject("Note not found");
    }
    return { created: fake.noteCreated };
  },
  save_note: saveNote,
  search_notes: searchNotes,
  create_note: createNote,
  delete_note: deleteNote,
  sub_page_counts: subPageCounts,
  move_note: moveNote,
  get_settings: readSettings,
  update_settings: (args) => {
    writeFile(SETTINGS_PATH, JSON.stringify(args.newSettings, null, 2));
    return null;
  },
  git_is_available: () => false,
  // git::GitStatus::default(): the folder is not a repository.
  git_get_status: () => ({
    isRepo: false,
    hasRemote: false,
    hasUpstream: false,
    remoteUrl: null,
    changedCount: 0,
    aheadCount: 0,
    behindCount: 0,
    currentBranch: null,
    error: null,
  }),
  set_title_bar_theme: () => null,
  // Settings page. Template tags are not expanded.
  get_default_ignored_patterns: () => DEFAULT_IGNORED_DIRS,
  preview_note_name: (args) => sanitizeFilename(str(args, "template")),
  copy_to_clipboard: () => null,
  copy_image_to_assets: copyImageToAssets,
  save_clipboard_image: saveClipboardImage,
  copy_file_to_assets: copyFileToAssets,
  get_asset_size: getAssetSize,
  open_asset: openAsset,
  // The command palette asks which AI CLIs are installed: none are.
  ai_check_claude_cli: () => false,
  ai_check_codex_cli: () => false,
  ai_check_opencode_cli: () => false,
  ai_check_ollama_cli: () => false,
  "plugin:dialog|open": () => fake.pickedFile,
  // The user accepts the suggested file name on the Desktop.
  "plugin:dialog|save": (args) =>
    `/Users/me/Desktop/${str(asArgs(args.options), "defaultPath")}`,
  // Writes outside the notes folder (exports); the call log is the record.
  write_file: () => null,
  export_note_zip: () => null,
  export_folder_zip: () => null,
  import_zip: () => 3,
  // Pending until the test calls finishNotionImport; the test emits progress.
  import_notion: () =>
    new Promise((finish) => {
      fake.finishNotionImport = (imported, summary) => {
        for (const [path, content] of Object.entries(imported)) {
          writeFile(path, content);
        }
        finish(summary);
      };
    }),
  // Mirrors read_asset_base64: a file in the notes folder, by its relative path.
  read_asset_base64: (args) => {
    const path = str(args, "path");
    return path in files
      ? btoa(files[path])
      : Promise.reject(`Could not read ${path}`);
  },
  "plugin:updater|check": () => null,
  // Cmd+W on the last tab; the call log is the record.
  "plugin:window|close": () => null,
  ...vaultHandlers({ files, writeFile, createBarePageFile }),
  ...mergeHandlers({ files, writeFile, createBarePageFile }),
};

mockWindows("main");
mockConvertFileSrc(window.aetherFakeWindowsUrls ? "windows" : "macos");
mockIPC(
  (cmd, payload) => {
    const args = asArgs(payload);
    calls.push({ cmd, args: structuredClone(args) });
    const handler = handlers[cmd];
    if (!handler) {
      unhandled.push(cmd);
      throw new Error(`[fake-backend] unhandled command: ${cmd}`);
    }
    const waiting = held.get(cmd);
    if (!waiting) return handler(args);
    return new Promise((done) => {
      waiting.push(() => done(handler(args)));
    });
  },
  { shouldMockEvents: true },
);

window.aetherFake = fake;
