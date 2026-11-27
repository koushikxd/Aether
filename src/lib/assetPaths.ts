// Image, attachment, and note link paths in notes. On disk a note stores paths relative to its own
// folder (`../../assets/x.png` for `a/b/Note`); the editor needs display URLs
// from convertFileSrc. Only files inside the notes folder are converted.
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Editor, JSONContent } from "@tiptap/core";
import { withoutEmptyTitle } from "../components/editor/Title";

export interface NoteLocation {
  notesFolder: string;
  /** Note id: path relative to the notes folder, without `.md`. */
  noteId: string;
}

// convertFileSrc output: `asset://localhost/` on macOS and Linux,
// `http(s)://asset.localhost/` on Windows and Android.
const ASSET_URL = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(.+)$/;
// A URL scheme (also matches Windows drive letters), an absolute path, or an anchor.
const NOT_RELATIVE = /^(?:[a-z][a-z\d+.-]*:|[/\\#])/i;
// Characters that end or break a markdown link destination.
const UNSAFE_IN_LINK = /[\s%<>()#?]/g;

function segments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/** Resolves `.` and `..`; null when the path climbs above where it starts. */
function normalize(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else if (part !== ".") {
      out.push(part);
    }
  }
  return out;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function noteDir(noteId: string): string[] {
  return segments(noteId).slice(0, -1);
}

/** Path inside the notes folder that a display or legacy asset URL points to. */
function fromAssetUrl(src: string, notesFolder: string): string[] | null {
  const encoded = ASSET_URL.exec(src)?.[1];
  const absolute = encoded && decode(encoded);
  const file = absolute ? normalize(segments(absolute)) : null;
  const root = segments(notesFolder);
  if (!file || file.length <= root.length) return null;
  return root.every((part, i) => part === file[i])
    ? file.slice(root.length)
    : null;
}

/** Path inside the notes folder that a src relative to note `noteId` points to. */
function fromRelative(src: string, noteId: string): string[] | null {
  const decoded = NOT_RELATIVE.test(src) ? null : decode(src);
  if (!decoded) return null;
  const path = normalize([...noteDir(noteId), ...segments(decoded)]);
  return path?.length ? path : null;
}

/**
 * Path inside the notes folder (`assets/x.png`) that a display URL, legacy
 * asset URL, or path relative to the note points to.
 */
export function notePath(src: string, location: NoteLocation): string | null {
  return (
    (
      fromAssetUrl(src, location.notesFolder) ??
      fromRelative(src, location.noteId)
    )?.join("/") ?? null
  );
}

/** Id of the note a relative `.md` link in note `noteId` points to. */
export function linkedNoteId(href: string, noteId: string): string | null {
  const path = fromRelative(href.split("#")[0], noteId)?.join("/");
  return path?.endsWith(".md") ? path.slice(0, -3) : null;
}

/** Display URL for a path inside the notes folder, e.g. `assets/x.png`. */
export function assetUrl(notesFolder: string, path: string): string {
  const sep = notesFolder.includes("\\") ? "\\" : "/";
  const root = notesFolder.replace(/[\\/]+$/, "");
  return convertFileSrc([root, ...segments(path)].join(sep));
}

function relativeTo(noteId: string, path: string[]): string {
  const dir = noteDir(noteId);
  let shared = 0;
  while (
    shared < dir.length &&
    shared < path.length - 1 &&
    dir[shared] === path[shared]
  ) {
    shared += 1;
  }
  return [...dir.slice(shared).map(() => ".."), ...path.slice(shared)]
    .join("/")
    .replace(UNSAFE_IN_LINK, (c) =>
      c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c),
    );
}

/** Link from note `fromId` to note `toId`, as stored in markdown. */
export function noteHref(fromId: string, toId: string): string {
  return relativeTo(fromId, segments(`${toId}.md`));
}

/** Extensions the backend copies as images; other files become file cards. */
export const IMAGE_EXTENSIONS = [
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
];

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");
}

/** Absolute path of the file a display URL points to. */
export function assetFilePath(src: string): string | null {
  const encoded = ASSET_URL.exec(src)?.[1];
  return encoded ? decode(encoded) : null;
}

// Node attributes that hold a path into the notes folder.
const PATH_ATTRS: Record<string, string> = { image: "src", fileCard: "href" };

function mapAssetSrcs(
  node: JSONContent,
  map: (src: string) => string,
): JSONContent {
  const attr = node.type ? PATH_ATTRS[node.type] : undefined;
  const src: unknown = attr ? node.attrs?.[attr] : undefined;
  return {
    ...node,
    ...(attr &&
      typeof src === "string" && {
        attrs: { ...node.attrs, [attr]: map(src) },
      }),
    ...(node.content && {
      content: node.content.map((child) => mapAssetSrcs(child, map)),
    }),
  };
}

/**
 * A paragraph holding nothing but a link to a non-image file directly in
 * `assets/` becomes a file card.
 */
function withFileCards(node: JSONContent, location: NoteLocation): JSONContent {
  const [only, ...rest] = node.content ?? [];
  const link = only?.marks?.length === 1 ? only.marks[0] : undefined;
  const href: unknown = link?.type === "link" ? link.attrs?.href : undefined;
  if (
    node.type === "paragraph" &&
    rest.length === 0 &&
    only?.type === "text" &&
    only.text &&
    typeof href === "string" &&
    !link?.attrs?.title
  ) {
    const path = notePath(href, location)?.split("/");
    if (path?.length === 2 && path[0] === "assets" && !isImagePath(path[1])) {
      return { type: "fileCard", attrs: { href, name: only.text } };
    }
  }
  return node.content
    ? {
        ...node,
        content: node.content.map((child) => withFileCards(child, location)),
      }
    : node;
}

/** Markdown to editor: relative paths and legacy asset URLs become display URLs. */
export function withDisplaySrcs(
  doc: JSONContent,
  location: NoteLocation | null,
): JSONContent {
  if (!location) return doc;
  return mapAssetSrcs(withFileCards(doc, location), (src) => {
    const path = notePath(src, location);
    return path ? assetUrl(location.notesFolder, path) : src;
  });
}

/** Editor to markdown: display URLs become paths relative to the note. */
export function withRelativeSrcs(
  doc: JSONContent,
  location: NoteLocation | null,
): JSONContent {
  if (!location) return doc;
  return mapAssetSrcs(doc, (src) => {
    const path = fromAssetUrl(src, location.notesFolder);
    return path ? relativeTo(location.noteId, path) : src;
  });
}

/** The note's markdown (or `doc`, a copy of its content) as saved to disk. */
export function editorMarkdown(
  editor: Editor,
  location: NoteLocation | null,
  doc: JSONContent = editor.getJSON(),
): string {
  const manager = editor.storage.markdown?.manager;
  if (!manager) return editor.getText();
  // Clean up the nbsp entities TipTap writes for empty paragraphs (a line or
  // table cell of its own), keeping hand-written ones such as in <summary>
  return manager
    .serialize(withRelativeSrcs(withoutEmptyTitle(doc), location))
    .replace(/(?:&nbsp;|&#160;)(?=[ \t]*(?:\||$))/gm, " ");
}

/** Link hrefs, image srcs and file card hrefs, in document order. */
function targets(node: JSONContent, out: string[] = []): string[] {
  for (const mark of node.marks ?? []) {
    const href: unknown = mark.attrs?.href;
    if (mark.type === "link" && typeof href === "string") out.push(href);
  }
  const attr = node.type ? PATH_ATTRS[node.type] : undefined;
  const src: unknown = attr ? node.attrs?.[attr] : undefined;
  if (typeof src === "string") out.push(src);
  node.content?.forEach((child) => targets(child, out));
  return out;
}

/**
 * Old to new value of every link or file target that differs between two
 * parses of the same note, such as before and after the backend rewrote its
 * links for a rename.
 */
export function changedTargets(
  before: JSONContent,
  after: JSONContent,
): Map<string, string> {
  const old = targets(before);
  const now = targets(after);
  const changes = new Map<string, string>();
  if (old.length !== now.length) return changes;
  old.forEach((target, i) => {
    if (target !== now[i]) changes.set(target, now[i]);
  });
  return changes;
}

/** `doc` with the link and file targets in `changes` replaced. */
export function withChangedTargets(
  doc: JSONContent,
  changes: Map<string, string>,
): JSONContent {
  const changed = mapAssetSrcs(doc, (src) => changes.get(src) ?? src);
  const relink = (node: JSONContent): JSONContent => ({
    ...node,
    ...(node.marks && {
      marks: node.marks.map((mark) => {
        const href: unknown = mark.attrs?.href;
        const next = typeof href === "string" && changes.get(href);
        return mark.type === "link" && next
          ? { ...mark, attrs: { ...mark.attrs, href: next } }
          : mark;
      }),
    }),
    ...(node.content && { content: node.content.map(relink) }),
  });
  return relink(changed);
}
