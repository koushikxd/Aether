import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getHTMLFromFragment, type Editor } from "@tiptap/core";
import { renderToString } from "katex";
import { toast } from "sonner";
import {
  notePath,
  withRelativeSrcs,
  type NoteLocation,
} from "../lib/assetPaths";
import { sanitizeFilename, saveTextFile } from "./pdf";

const ZIP_FILTER = { name: "Zip", extensions: ["zip"] };

export function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "string" ? error : fallback;
}

/** Asks where to save `<name>.zip`, then has the backend write it there. */
async function exportZip(
  name: string,
  command: string,
  args: Record<string, unknown>,
) {
  const dest = await save({
    defaultPath: `${sanitizeFilename(name)}.zip`,
    filters: [ZIP_FILTER],
  });
  if (!dest) return;
  toast.promise(invoke(command, { ...args, dest }), {
    loading: "Exporting zip...",
    success: "Zip exported",
    error: (error: unknown) => errorMessage(error, "Failed to export zip"),
  });
}

/**
 * The note as markdown with its sub-pages and the files in `assets/` they
 * use, in one zip. Private pages are left out unless `includePrivate`.
 */
export function exportNoteZip(
  id: string,
  markdown: string,
  title: string,
  includePrivate: boolean,
) {
  return exportZip(title, "export_note_zip", { id, markdown, includePrivate });
}

/**
 * A folder of notes (`""` for the whole notes folder) with its assets, in one
 * zip. Private pages are left out unless `includePrivate`.
 */
export function exportFolderZip(
  folder: string,
  name: string,
  includePrivate: boolean,
) {
  return exportZip(name, "export_folder_zip", { folder, includePrivate });
}

/**
 * Unpacks a zip the user picks into the notes folder. Resolves to true when
 * files were written.
 */
export async function importZip(): Promise<boolean> {
  const path = await open({ multiple: false, filters: [ZIP_FILTER] });
  if (!path) return false;
  const imported = invoke<number>("import_zip", { path });
  toast.promise(imported, {
    loading: "Importing zip...",
    success: (count) => `Imported ${count} ${count === 1 ? "file" : "files"}`,
    error: (error: unknown) => errorMessage(error, "Failed to import zip"),
  });
  return imported.then(
    (count) => count > 0,
    () => false,
  );
}

export interface NotionImportSummary {
  /** Ids of the notes written. */
  ids: string[];
  pages: number;
  images: number;
  files: number;
  skipped: { page: string; reason: string }[];
}

/** The zips of a Notion export the user picks, or null when cancelled. */
export function pickNotionZips(): Promise<string[] | null> {
  return open({ multiple: true, filters: [ZIP_FILTER] });
}

/**
 * Imports a Notion HTML export (every zip part of it), with its top-level
 * pages at the root of the notes folder.
 */
export async function importNotion(
  paths: string[],
  onProgress: (current: number, total: number) => void,
): Promise<NotionImportSummary> {
  const unlisten = await listen<{ current: number; total: number }>(
    "notion-import-progress",
    ({ payload }) => onProgress(payload.current, payload.total),
  );
  try {
    return await invoke<NotionImportSummary>("import_notion", { paths });
  } finally {
    unlisten();
  }
}

// `image/<subtype>` for extensions where the two differ.
const IMAGE_SUBTYPES: Record<string, string> = {
  jpg: "jpeg",
  svg: "svg+xml",
  tif: "tiff",
  ico: "x-icon",
};

const HTML_STYLE = `
body { max-width: 46rem; margin: 3rem auto; padding: 0 1.5rem; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; }
img { display: block; max-width: 100%; height: auto; margin: 1rem 0; }
a { color: #0969da; }
code { font: 0.875em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3f4f6; padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: #f3f4f6; padding: 1rem; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid #d0d7de; color: #59636e; }
table { border-collapse: collapse; }
th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.75rem; text-align: left; }
th { background: #f6f8fa; }
mark { background: #fff3a3; color: inherit; }
[data-callout] { position: relative; margin: 1rem 0; padding: 0.75rem 1rem 0.75rem 2.75rem; border-radius: 6px; background: #f6f8fa; }
[data-callout]::before { content: attr(data-icon); position: absolute; left: 1rem; top: 0.75rem; }
[data-callout] > :first-child, [data-type="detailsContent"] > :first-child { margin-top: 0; }
[data-callout] > :last-child, [data-type="detailsContent"] > :last-child { margin-bottom: 0; }
details { margin: 1rem 0; }
summary { cursor: pointer; font-weight: 500; }
[data-type="detailsContent"] { padding: 0.5rem 0 0 1.25rem; }
ul[data-type="taskList"] { list-style: none; padding-left: 0.25rem; }
ul[data-type="taskList"] li { display: flex; gap: 0.5rem; }
ul[data-type="taskList"] li p { margin: 0; }
.frontmatter { display: none; }
`;

/**
 * The note as one HTML document: images (files in the notes folder) embedded
 * as data URLs, math rendered to MathML, and file cards as links with the
 * note's relative path, since attachments cannot be embedded usefully. An
 * image that cannot be read keeps its relative path, and a web image its URL;
 * `missing` counts them.
 */
async function noteHtml(
  editor: Editor,
  location: NoteLocation,
  title: string,
): Promise<{ page: Document; missing: number }> {
  const doc = editor.schema.nodeFromJSON(
    withRelativeSrcs(editor.getJSON(), location),
  );
  const page = document.implementation.createHTMLDocument(title);
  const charset = page.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const style = page.createElement("style");
  style.textContent = HTML_STYLE;
  page.head.prepend(charset);
  page.head.append(style);
  page.body.innerHTML = getHTMLFromFragment(doc.content, editor.schema);

  let missing = 0;
  await Promise.all(
    [...page.body.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (/^https?:/i.test(src)) {
        missing += 1;
        return;
      }
      const path = notePath(src, location);
      if (!path) return;
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      try {
        const data = await invoke<string>("read_asset_base64", { path });
        img.setAttribute(
          "src",
          `data:image/${IMAGE_SUBTYPES[ext] ?? ext};base64,${data}`,
        );
      } catch {
        missing += 1;
      }
    }),
  );
  for (const card of page.body.querySelectorAll<HTMLElement>(
    "[data-file-card]",
  )) {
    const link = page.createElement("a");
    link.setAttribute("href", card.dataset.href ?? "");
    link.textContent = card.dataset.name ?? "";
    const paragraph = page.createElement("p");
    paragraph.append(link);
    card.replaceWith(paragraph);
  }
  for (const math of page.body.querySelectorAll<HTMLElement>("[data-latex]")) {
    math.innerHTML = renderToString(math.dataset.latex ?? "", {
      displayMode: math.dataset.type === "block-math",
      output: "mathml",
      throwOnError: false,
    });
  }
  return { page, missing };
}

function warnMissing(missing: number) {
  if (missing > 0) {
    toast.warning(
      `${missing} ${missing === 1 ? "image" : "images"} could not be embedded`,
    );
  }
}

export async function exportNoteHtml(
  editor: Editor,
  location: NoteLocation,
  title: string,
) {
  try {
    const { page, missing } = await noteHtml(editor, location, title);
    const html = `<!doctype html>\n${page.documentElement.outerHTML}\n`;
    if (
      await saveTextFile(html, title, { name: "HTML", extensions: ["html"] })
    ) {
      toast.success("HTML exported");
      warnMissing(missing);
    }
  } catch (error) {
    console.error("Failed to export HTML:", error);
    toast.error(errorMessage(error, "Failed to export HTML"));
  }
}

/** The note's HTML for the clipboard, with images embedded as in the export. */
export async function noteClipboardHtml(
  editor: Editor,
  location: NoteLocation,
): Promise<string> {
  const { page, missing } = await noteHtml(editor, location, "");
  warnMissing(missing);
  return page.body.innerHTML;
}
