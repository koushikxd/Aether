import type { Editor } from "@tiptap/react";
import { save, type DialogFilter } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
/**
 * Triggers the native print dialog for the editor content.
 * Users can save as PDF or print to a physical printer.
 * Uses the browser's native print functionality which produces high-quality PDFs.
 *
 * @param editor - The TipTap editor instance
 * @param _noteTitle - The note title (currently unused, but kept for API consistency)
 */
export async function downloadPdf(
  editor: Editor,
  _noteTitle: string,
): Promise<void> {
  if (!editor) throw new Error("Editor not available");

  window.print();
}

/**
 * Asks where to save a text file, suggesting `<title>.<extension>`, and
 * writes it there. Returns false if the user cancelled.
 */
export async function saveTextFile(
  text: string,
  title: string,
  filter: DialogFilter,
): Promise<boolean> {
  const filePath = await save({
    defaultPath: `${sanitizeFilename(title)}.${filter.extensions[0]}`,
    filters: [filter],
  });
  if (!filePath) return false;

  await invoke("write_file", {
    path: filePath,
    contents: Array.from(new TextEncoder().encode(text)),
  });
  return true;
}

/**
 * Downloads the markdown content as a .md file.
 *
 * @param markdown - The markdown content to save
 * @param noteTitle - The note title for the default filename
 * @returns Promise<boolean> - Returns true if file was saved successfully, false if user cancelled
 */
export function downloadMarkdown(
  markdown: string,
  noteTitle: string,
): Promise<boolean> {
  return saveTextFile(markdown, noteTitle, {
    name: "Markdown",
    extensions: ["md"],
  });
}

/**
 * Sanitizes a filename by removing invalid characters.
 * Replaces filesystem-unsafe characters with dashes.
 *
 * @param name - The filename to sanitize
 * @returns A filesystem-safe filename
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "-").trim() || "note";
}
