import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  useState,
} from "react";
import {
  useEditor,
  EditorContent,
  ReactRenderer,
  ReactNodeViewRenderer,
  type Editor as TiptapEditor,
} from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Link } from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, type MarkdownManager } from "@tiptap/markdown";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { lowlight } from "./lowlight";
import { CodeBlockView } from "./CodeBlockView";
import { Extension, InputRule } from "@tiptap/core";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";
import { mod, shift, isMac, isWindows } from "../../lib/platform";

// Prepend https:// if no protocol is present, except to relative links
// (paths, anchors, and links to .md notes)
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  if (/^(?:\.{0,2}\/|#)/.test(trimmed)) return trimmed;
  if (/\.md$/i.test(trimmed.split(/[?#]/)[0])) return trimmed;
  return `https://${trimmed}`;
}

// Validate URL scheme for safe opening
function isAllowedUrlScheme(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { useOptionalNotes } from "../../context/NotesContext";
import { useOptionalTabs } from "../../context/TabsContext";
import { TabStrip } from "./TabStrip";
import { useTheme } from "../../context/ThemeContext";
import { Frontmatter } from "./Frontmatter";
import { BlockMathEditor } from "./BlockMathEditor";
import { LinkEditor } from "./LinkEditor";
import { SearchToolbar } from "./SearchToolbar";
import { SlashCommand } from "./SlashCommand";
import { SelectionToolbar } from "./SelectionToolbar";
import { BlockHandle } from "./BlockHandle";
import { BlockShortcuts } from "./blocks";
import { Callout } from "./Callout";
import { Toggle, ToggleContent, ToggleSummary } from "./Toggle";
import { FileCard } from "./FileCard";
import { ResizableImage } from "./ResizableImage";
import { ColorTextStyle, MarkHighlight } from "./marks";
import { Color } from "@tiptap/extension-text-style";
import { Wikilink } from "./Wikilink";
import { getWikilinkStorage, WikilinkSuggestion } from "./WikilinkSuggestion";
import { EditorWidthHandles } from "./EditorWidthHandle";
import {
  AetherBlockMath,
  AetherInlineMath,
  EscapedDollar,
  normalizeBlockMath,
} from "./MathExtensions";
import { cn } from "../../lib/utils";
import { plainTextFromMarkdown } from "../../lib/plainText";
import { formatDateTime } from "../../lib/dates";
import { NoteInfoPanel } from "./NoteInfoPanel";
import {
  assetUrl,
  changedTargets,
  editorMarkdown,
  IMAGE_EXTENSIONS,
  isImagePath,
  linkedNoteId,
  noteHref,
  withChangedTargets,
  withDisplaySrcs,
  type NoteLocation,
} from "../../lib/assetPaths";
import { Button, IconButton, Tooltip } from "../ui";
import * as notesService from "../../services/notes";
import { downloadPdf, downloadMarkdown } from "../../services/pdf";
import {
  errorMessage,
  exportNoteHtml,
  exportNoteZip,
  noteClipboardHtml,
} from "../../services/export";
import { getVaultStatus } from "../../services/vault";
import type { Note, Settings } from "../../types/note";
import { ExportZipDialog } from "../vault/ExportZipDialog";
import {
  SpinnerIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  ShareIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  PinIcon,
  SearchIcon,
  MarkdownIcon,
  MarkdownOffIcon,
  FolderPlusIcon,
} from "../icons";

function focusAndSelectTitle(editor: TiptapEditor): boolean {
  let titleFrom = -1;
  let titleTo = -1;

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading" || node.attrs.level !== 1) {
      return true;
    }
    titleFrom = pos + 1;
    titleTo = pos + node.nodeSize - 1;
    return false;
  });

  if (titleFrom < 0 || titleTo < 0) return false;

  editor
    .chain()
    .focus()
    .setTextSelection(
      titleFrom === titleTo ? titleFrom : { from: titleFrom, to: titleTo },
    )
    .run();

  return true;
}

// Standard number-field shortcuts for KaTeX (shared between inline and block math)
const katexMacros: Record<string, string> = {
  "\\R": "\\mathbb{R}",
  "\\N": "\\mathbb{N}",
  "\\Z": "\\mathbb{Z}",
  "\\Q": "\\mathbb{Q}",
  "\\C": "\\mathbb{C}",
};

// Search highlight extension - adds yellow backgrounds to search matches
const searchHighlightPluginKey = new PluginKey("searchHighlight");

interface SearchHighlightOptions {
  matches: Array<{ from: number; to: number }>;
  currentIndex: number;
}

const SearchHighlight = Extension.create<SearchHighlightOptions>({
  name: "searchHighlight",

  addOptions() {
    return {
      matches: [],
      currentIndex: 0,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchHighlightPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, oldSet) => {
            // Map decorations through document changes
            const set = oldSet.map(tr.mapping, tr.doc);

            // Check if we need to update decorations (from transaction meta)
            const meta = tr.getMeta(searchHighlightPluginKey);
            if (meta !== undefined) {
              return meta.decorationSet;
            }

            return set;
          },
        },
        props: {
          decorations: (state) => {
            return searchHighlightPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});

// Data source for preview mode — bypasses NotesContext
export interface PreviewModeData {
  content: string | null;
  title: string;
  filePath: string;
  modified: number;
  hasExternalChanges: boolean;
  reloadVersion: number;
  save: (content: string) => Promise<void>;
  reload: () => Promise<void>;
}

interface EditorProps {
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  focusMode?: boolean;
  previewMode?: PreviewModeData;
  onEditorReady?: (editor: TiptapEditor | null) => void;
  onSaveToFolder?: () => void;
  saveToFolderDisabled?: boolean;
}

/**
 * Get character offsets where each top-level block starts in markdown.
 * Blocks are separated by blank lines, with awareness of code fences
 * and ATX headings.
 */
function getMarkdownBlockOffsets(md: string): number[] {
  const offsets: number[] = [];
  const lines = md.split("\n");
  let pos = 0;
  let prevBlank = true; // treat doc start as preceded by blank
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (inCodeFence) {
      // Only look for closing fence; don't start new blocks inside code
      if (trimmed.startsWith("```")) {
        inCodeFence = false;
      }
    } else if (trimmed.startsWith("```")) {
      // Opening fence is always a block start
      offsets.push(pos);
      inCodeFence = true;
      prevBlank = false;
    } else {
      const isBlank = trimmed === "";
      // Start a new block after a blank line, or for ATX headings
      if (!isBlank && (prevBlank || trimmed.startsWith("#"))) {
        offsets.push(pos);
      }
      prevBlank = isBlank;
    }

    pos += line.length + 1;
  }

  return offsets;
}

/** ProseMirror position at the start of the Nth top-level block. */
function blockIndexToPos(
  doc: { childCount: number; child: (i: number) => { nodeSize: number } },
  blockIndex: number,
): number {
  const idx = Math.max(0, Math.min(blockIndex, doc.childCount - 1));
  let pos = 1; // 1 for doc opening token
  for (let i = 0; i < idx; i++) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

export function Editor({
  onToggleSidebar,
  sidebarVisible,
  focusMode,
  onEditorReady,
  previewMode,
  onSaveToFolder,
  saveToFolderDisabled,
}: EditorProps) {
  // Always call the hook (rules of hooks), but it returns null outside NotesProvider
  const notesCtx = useOptionalNotes();

  // previewMode is a new object every render, so memoize on its fields
  const previewNote = useMemo(
    () =>
      previewMode?.content != null
        ? {
            id: previewMode.filePath,
            title: previewMode.title,
            content: previewMode.content,
            path: previewMode.filePath,
            modified: previewMode.modified,
          }
        : null,
    [
      previewMode?.content,
      previewMode?.filePath,
      previewMode?.title,
      previewMode?.modified,
    ],
  );
  const currentNote = previewMode
    ? previewNote
    : (notesCtx?.currentNote ?? null);

  const previewSave = previewMode?.save;
  const savePreview = useCallback(
    async (content: string, _noteId?: string) => {
      await previewSave?.(content);
    },
    [previewSave],
  );
  const saveNote: NonNullable<typeof notesCtx>["saveNote"] = previewMode
    ? savePreview
    : notesCtx!.saveNote;
  const setPendingSaveFlush = notesCtx?.setPendingSaveFlush;

  const createNote = notesCtx?.createNote;
  const consumePendingNewNote = notesCtx?.consumePendingNewNote;
  const hasExternalChanges = previewMode
    ? previewMode.hasExternalChanges
    : notesCtx!.hasExternalChanges;
  const reloadCurrentNote = previewMode
    ? previewMode.reload
    : notesCtx!.reloadCurrentNote;
  const reloadVersion = previewMode
    ? previewMode.reloadVersion
    : notesCtx!.reloadVersion;
  const pinNote = notesCtx?.pinNote;
  const unpinNote = notesCtx?.unpinNote;
  const notes = notesCtx?.notes;
  const { textDirection } = useTheme();
  const [isSaving, setIsSaving] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [pageToExport, setPageToExport] = useState<{
    id: string;
    markdown: string;
    title: string;
    isPrivate: boolean;
  } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  // Delay header transitions only when the sidebar needs to animate closed
  const needsSidebarDelay = focusMode && sidebarVisible;
  const isSidebarActive = sidebarVisible && !focusMode;
  // Source mode state
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceContent, setSourceContent] = useState("");
  const sourceTimeoutRef = useRef<number | null>(null);
  const sourceModeTransitionRef = useRef<{
    topBlockIndex: number;
    cursorBlockIndex: number;
    md?: string;
  } | null>(null);
  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [isReplaceOpen, setIsReplaceOpen] = useState(false);
  const [searchMatches, setSearchMatches] = useState<
    Array<{ from: number; to: number }>
  >([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const linkPopupRef = useRef<TippyInstance | null>(null);
  const blockMathPopupRef = useRef<TippyInstance | null>(null);
  const isLoadingRef = useRef(false);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  // Renames made by this editor's saves, oldest first
  const renamesRef = useRef<
    { from: string; to: string; changes: Map<string, string> }[]
  >([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<TiptapEditor | null>(null);
  const currentNoteIdRef = useRef<string | null>(null);
  // Track which note's content is currently loaded in the editor
  const loadedNoteIdRef = useRef<string | null>(null);
  // Image paths are only converted for notes inside the notes folder
  const notesFolderRef = useRef<string | null>(null);
  notesFolderRef.current = previewMode ? null : (notesCtx?.notesFolder ?? null);
  // Track if we need to save (use ref to avoid computing markdown on every keystroke)
  const needsSaveRef = useRef(false);
  // The file changed on disk while the editor had edits not yet saved: saves
  // wait until the user picks Refresh or Overwrite, or opens another note
  const heldRef = useRef(false);
  // Stable refs for wikilink click handler (avoids re-registering listener on every notes change)
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const notesCtxRef = useRef(notesCtx);
  notesCtxRef.current = notesCtx;
  const tabs = useOptionalTabs();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Keep ref in sync with current note ID
  currentNoteIdRef.current = currentNote?.id ?? null;

  const loadedNoteLocation = useCallback((): NoteLocation | null => {
    const notesFolder = notesFolderRef.current;
    const noteId = loadedNoteIdRef.current;
    return notesFolder && noteId ? { notesFolder, noteId } : null;
  }, []);

  // Get markdown from editor
  const getMarkdown = useCallback(
    (editorInstance: ReturnType<typeof useEditor>) =>
      editorInstance
        ? editorMarkdown(editorInstance, loadedNoteLocation())
        : "",
    [loadedNoteLocation],
  );

  // Inserts an image the backend copied into the notes folder (`assets/x.png`)
  const insertImage = useCallback(async (path: string) => {
    const notesFolder = await invoke<string>("get_notes_folder");
    editorRef.current
      ?.chain()
      .focus()
      .setImage({ src: assetUrl(notesFolder, path) })
      .run();
  }, []);

  // Copies files into `assets/` and inserts them at the cursor: images as
  // images, anything else as a file card.
  const insertFiles = useCallback(async (sourcePaths: string[]) => {
    const notesFolder = await invoke<string>("get_notes_folder");
    for (const sourcePath of sourcePaths) {
      const image = isImagePath(sourcePath);
      try {
        const path = await invoke<string>(
          image ? "copy_image_to_assets" : "copy_file_to_assets",
          { sourcePath },
        );
        const src = assetUrl(notesFolder, path);
        const editorInstance = editorRef.current;
        // After the selection, so a file inserted before is not replaced
        editorInstance
          ?.chain()
          .focus()
          .insertContentAt(
            editorInstance.state.selection.to,
            image
              ? { type: "image", attrs: { src } }
              : {
                  type: "fileCard",
                  attrs: { href: src, name: path.split("/").pop() },
                },
          )
          .run();
      } catch (error) {
        console.error("Failed to add file:", error);
        toast.error(image ? "Failed to add image" : "Failed to attach file");
      }
    }
  }, []);

  // Parse note markdown into editor content
  const parseMarkdown = useCallback(
    (manager: MarkdownManager, markdown: string) =>
      withDisplaySrcs(manager.parse(markdown), loadedNoteLocation()),
    [loadedNoteLocation],
  );

  // Load settings when note changes or notes are refreshed (e.g., after pin/unpin)
  useEffect(() => {
    if (currentNote?.id && !previewMode) {
      notesService
        .getSettings()
        .then(setSettings)
        .catch((error) => {
          console.error("Failed to load settings:", error);
        });
    }
  }, [currentNote?.id, notes, previewMode]);

  // Calculate if current note is pinned
  const isPinned =
    settings?.pinnedNoteIds?.includes(currentNote?.id || "") || false;

  // Find all matches for search query (case-insensitive)
  const findMatches = useCallback(
    (query: string, editorInstance: TiptapEditor | null) => {
      if (!editorInstance || !query.trim()) return [];

      const doc = editorInstance.state.doc;
      const lowerQuery = query.toLowerCase();
      const matches: Array<{ from: number; to: number }> = [];

      // Search through each text node
      doc.descendants((node, nodePos) => {
        if (node.isText && node.text) {
          const text = node.text;
          const lowerText = text.toLowerCase();

          let searchPos = 0;
          while (searchPos < lowerText.length && matches.length < 500) {
            const index = lowerText.indexOf(lowerQuery, searchPos);
            if (index === -1) break;

            const matchFrom = nodePos + index;
            const matchTo = matchFrom + query.length;

            // Make sure the match doesn't extend beyond valid document bounds
            if (matchTo <= doc.content.size) {
              matches.push({
                from: matchFrom,
                to: matchTo,
              });
            }

            searchPos = index + 1;
          }
        }
      });

      return matches;
    },
    [],
  );

  // Update search decorations - applies yellow backgrounds to all matches
  const updateSearchDecorations = useCallback(
    (
      matches: Array<{ from: number; to: number }>,
      currentIndex: number,
      editorInstance: TiptapEditor | null,
    ) => {
      if (!editorInstance) return;

      try {
        const { state } = editorInstance;
        const decorations: Decoration[] = [];

        // Add decorations for all matches
        matches.forEach((match, index) => {
          const isActive = index === currentIndex;
          decorations.push(
            Decoration.inline(match.from, match.to, {
              class: isActive ? "search-match-active" : "search-match",
            }),
          );
        });

        const decorationSet = DecorationSet.create(state.doc, decorations);

        // Update decorations via transaction
        const tr = state.tr.setMeta(searchHighlightPluginKey, {
          decorationSet,
        });

        editorInstance.view.dispatch(tr);

        // Scroll to current match
        if (matches[currentIndex]) {
          const match = matches[currentIndex];
          const { node } = editorInstance.view.domAtPos(match.from);
          const element = node instanceof Element ? node : node.parentElement;

          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      } catch (error) {
        console.error("Failed to update search decorations:", error);
      }
    },
    [],
  );

  // Points links and file paths at new targets in place, so the selection
  // and the nodes around them stay as they are.
  const relinkEditor = useCallback((changes: Map<string, string>) => {
    const editorInstance = editorRef.current;
    if (!editorInstance || changes.size === 0) return;
    const { tr } = editorInstance.state;
    editorInstance.state.doc.descendants((node, pos) => {
      for (const mark of node.marks) {
        const href = changes.get(mark.attrs.href);
        if (mark.type.name === "link" && href) {
          tr.addMark(
            pos,
            pos + node.nodeSize,
            mark.type.create({ ...mark.attrs, href }),
          );
        }
      }
      const attr =
        node.type.name === "image"
          ? "src"
          : node.type.name === "fileCard"
            ? "href"
            : null;
      const target = attr && changes.get(node.attrs[attr]);
      if (attr && target) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, [attr]: target });
      }
    });
    isLoadingRef.current = true;
    editorInstance.view.dispatch(tr.setMeta("addToHistory", false));
    isLoadingRef.current = false;
  }, []);

  // A save that renamed the note (its title changed) keeps the editing
  // session on the new id. The backend may also have rewritten links, such
  // as those to the page's own sub-pages: apply them without reloading.
  const followRename = useCallback(
    (savedId: string, sent: string, note: Note) => {
      if (note.id === savedId) return;
      const manager = editorRef.current?.storage.markdown?.manager;
      const notesFolder = notesFolderRef.current;
      const changes =
        manager && notesFolder
          ? changedTargets(
              withDisplaySrcs(manager.parse(sent), {
                notesFolder,
                noteId: savedId,
              }),
              withDisplaySrcs(manager.parse(note.content), {
                notesFolder,
                noteId: note.id,
              }),
            )
          : new Map<string, string>();
      renamesRef.current.push({ from: savedId, to: note.id, changes });
      if (loadedNoteIdRef.current !== savedId) return;
      loadedNoteIdRef.current = note.id;
      relinkEditor(changes);
    },
    [relinkEditor],
  );

  // Saves run one at a time. A save queued while an earlier one renamed the
  // note goes to the new id, with the links that rename rewrote; `content`
  // gets both. Resolves when the save is done.
  const queueSave = useCallback(
    (
      noteId: string,
      content: (id: string, changes: Map<string, string>[]) => string,
    ) => {
      const since = renamesRef.current.length;
      const save = saveChainRef.current.then(async () => {
        let id = noteId;
        const changes: Map<string, string>[] = [];
        for (const rename of renamesRef.current.slice(since)) {
          if (rename.from !== id) continue;
          id = rename.to;
          changes.push(rename.changes);
        }
        const markdown = content(id, changes);
        setIsSaving(true);
        try {
          await saveNote(markdown, id, (note) =>
            followRename(id, markdown, note),
          );
        } finally {
          setIsSaving(false);
        }
      });
      // A failed save must not stop the ones queued after it
      saveChainRef.current = save.catch(() => undefined);
      return save;
    },
    [saveNote, followRename],
  );

  // Queues a save of pending edits (to the note loaded in the editor, not
  // currentNoteIdRef, which may have changed). Resolves when every save
  // queued so far is done.
  const flushPendingSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const editorInstance = editorRef.current;
    const noteId = loadedNoteIdRef.current;
    if (heldRef.current) {
      needsSaveRef.current = false;
    } else if (needsSaveRef.current && editorInstance && noteId) {
      needsSaveRef.current = false;
      const doc = editorInstance.getJSON();
      void queueSave(noteId, (id, changes) => {
        const notesFolder = notesFolderRef.current;
        return editorMarkdown(
          editorInstance,
          notesFolder ? { notesFolder, noteId: id } : null,
          changes.reduce(withChangedTargets, doc),
        );
      });
    }
    return saveChainRef.current;
  }, [queueSave]);

  // Schedule a debounced save (markdown computed only when timer fires)
  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    if (!loadedNoteIdRef.current) return;

    needsSaveRef.current = true;
    saveTimeoutRef.current = window.setTimeout(() => {
      void flushPendingSave();
    }, 500);
  }, [flushPendingSave]);

  // Moves flush first, so no save is left to write to a path that moved
  useEffect(() => {
    if (!setPendingSaveFlush) return undefined;
    setPendingSaveFlush(flushPendingSave);
    return () => setPendingSaveFlush(null);
  }, [setPendingSaveFlush, flushPendingSave]);

  const closeBlockMathPopup = useCallback(() => {
    if (blockMathPopupRef.current) {
      blockMathPopupRef.current.destroy();
      blockMathPopupRef.current = null;
    }
  }, []);

  const handleEditMath = useCallback(
    (pos: number) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      if (linkPopupRef.current) {
        linkPopupRef.current.destroy();
        linkPopupRef.current = null;
      }
      closeBlockMathPopup();

      const node = currentEditor.state.doc.nodeAt(pos);
      if (node?.type.name !== "blockMath" && node?.type.name !== "inlineMath") {
        return;
      }

      const virtualElement = {
        getBoundingClientRect: () => {
          const nodeDom = currentEditor.view.nodeDOM(pos);
          if (nodeDom instanceof HTMLElement) {
            return nodeDom.getBoundingClientRect();
          }

          const start = currentEditor.view.coordsAtPos(pos);
          const end = currentEditor.view.coordsAtPos(pos + node.nodeSize);
          const left = Math.min(start.left, end.left);
          const top = Math.min(start.top, end.top);
          const right = Math.max(start.right, end.right);
          const bottom = Math.max(start.bottom, end.bottom);

          return {
            width: Math.max(2, right - left),
            height: Math.max(20, bottom - top),
            top,
            left,
            right,
            bottom,
            x: left,
            y: top,
            toJSON: () => ({}),
          } as DOMRect;
        },
      };

      const component = new ReactRenderer(BlockMathEditor, {
        props: {
          initialLatex: String(node.attrs.latex ?? ""),
          onSubmit: (latex: string) => {
            const trimmed = latex.trim();
            if (!trimmed) {
              toast.error("Please enter a formula.");
              return;
            }
            currentEditor
              .chain()
              .focus()
              .command(({ tr }) => {
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  latex: trimmed,
                });
                return true;
              })
              .setTextSelection(pos + node.nodeSize)
              .run();
            closeBlockMathPopup();
          },
          onCancel: () => {
            // Move cursor after the node instead of restoring the NodeSelection,
            // which would re-trigger native DOM selection highlight bleed
            currentEditor
              .chain()
              .focus()
              .setTextSelection(pos + node.nodeSize)
              .run();
            closeBlockMathPopup();
          },
        },
        editor: currentEditor,
      });

      blockMathPopupRef.current = tippy(document.body, {
        getReferenceClientRect: () => virtualElement.getBoundingClientRect(),
        appendTo: () => document.body,
        content: component.element,
        showOnCreate: true,
        interactive: true,
        trigger: "manual",
        placement: "bottom-start",
        offset: [0, 8],
        onDestroy: () => {
          component.destroy();
        },
      });
    },
    [closeBlockMathPopup],
  );

  const handleAddBlockMath = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    closeBlockMathPopup();
    if (linkPopupRef.current) {
      linkPopupRef.current.destroy();
      linkPopupRef.current = null;
    }
    const { selection, doc } = currentEditor.state;
    const { from, to, empty, $from } = selection;

    if (
      selection instanceof NodeSelection &&
      selection.node.type.name === "blockMath"
    ) {
      handleEditMath(from);
      return;
    }

    if (!empty) {
      const selectedNode = doc.nodeAt(from);
      if (
        selectedNode?.type.name === "blockMath" &&
        from + selectedNode.nodeSize === to
      ) {
        handleEditMath(from);
        return;
      }
    }

    if (empty) {
      const nodeBefore = $from.nodeBefore;
      if (nodeBefore?.type.name === "blockMath") {
        handleEditMath(from - nodeBefore.nodeSize);
        return;
      }
      const nodeAfter = $from.nodeAfter;
      if (nodeAfter?.type.name === "blockMath") {
        handleEditMath(from);
        return;
      }
    }

    const selectedText = empty ? "" : doc.textBetween(from, to, "\n");
    const initialLatex = normalizeBlockMath(selectedText);
    const targetRange = { from, to };
    const hasSelection = from !== to;

    const virtualElement = {
      getBoundingClientRect: () => {
        if (hasSelection) {
          const startPos = currentEditor.view.domAtPos(from);
          const endPos = currentEditor.view.domAtPos(to);

          if (startPos && endPos) {
            try {
              const range = document.createRange();
              range.setStart(startPos.node, startPos.offset);
              range.setEnd(endPos.node, endPos.offset);
              return range.getBoundingClientRect();
            } catch (error) {
              console.error("Block math range creation failed:", error);
            }
          }
        }

        const coords = currentEditor.view.coordsAtPos(from);
        return {
          width: 2,
          height: 20,
          top: coords.top,
          left: coords.left,
          right: coords.right,
          bottom: coords.bottom,
          x: coords.left,
          y: coords.top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    };

    const component = new ReactRenderer(BlockMathEditor, {
      props: {
        initialLatex,
        onSubmit: (latex: string) => {
          const normalizedLatex = latex.trim();
          if (!normalizedLatex) {
            toast.error("Please enter a formula.");
            return;
          }

          const inserted = currentEditor
            .chain()
            .focus()
            .insertContentAt(targetRange, {
              type: "blockMath",
              attrs: { latex: normalizedLatex },
            })
            .command(({ state, tr, dispatch }) => {
              if (!dispatch) return true;

              const { $to } = tr.selection;
              if ($to.nodeAfter?.isTextblock) {
                tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1));
                tr.scrollIntoView();
                return true;
              }

              const paragraphType =
                state.schema.nodes.paragraph ??
                $to.parent.type.contentMatch.defaultType;
              const paragraphNode = paragraphType?.create();
              const insertPos = $to.nodeAfter ? $to.pos : $to.end();

              if (paragraphNode) {
                const $insertPos = tr.doc.resolve(insertPos);
                if (
                  $insertPos.parent.canReplaceWith(
                    $insertPos.index(),
                    $insertPos.index(),
                    paragraphNode.type,
                  )
                ) {
                  tr.insert(insertPos, paragraphNode);
                  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
                  tr.scrollIntoView();
                  return true;
                }
              }

              tr.scrollIntoView();
              return true;
            })
            .run();

          if (inserted) {
            closeBlockMathPopup();
          }
        },
        onCancel: () => {
          currentEditor.commands.focus();
          closeBlockMathPopup();
        },
      },
      editor: currentEditor,
    });

    blockMathPopupRef.current = tippy(document.body, {
      getReferenceClientRect: () => virtualElement.getBoundingClientRect(),
      appendTo: () => document.body,
      content: component.element,
      showOnCreate: true,
      interactive: true,
      trigger: "manual",
      placement: "bottom-start",
      offset: [0, 8],
      onDestroy: () => {
        component.destroy();
      },
    });
  }, [closeBlockMathPopup, handleEditMath]);

  const handleAddInlineMath = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    closeBlockMathPopup();
    const pos = currentEditor.state.selection.from;
    const component = new ReactRenderer(BlockMathEditor, {
      props: {
        initialLatex: "",
        onSubmit: (latex: string) => {
          const trimmed = latex.trim();
          if (!trimmed) {
            toast.error("Please enter a formula.");
            return;
          }
          currentEditor
            .chain()
            .focus()
            .insertContentAt(pos, {
              type: "inlineMath",
              attrs: { latex: trimmed },
            })
            .run();
          closeBlockMathPopup();
        },
        onCancel: () => {
          currentEditor.commands.focus();
          closeBlockMathPopup();
        },
      },
      editor: currentEditor,
    });

    blockMathPopupRef.current = tippy(document.body, {
      getReferenceClientRect: () => {
        const { left, top, bottom } = currentEditor.view.coordsAtPos(pos);
        return new DOMRect(left, top, 2, bottom - top);
      },
      appendTo: () => document.body,
      content: component.element,
      showOnCreate: true,
      interactive: true,
      trigger: "manual",
      placement: "bottom-start",
      offset: [0, 8],
      onDestroy: () => {
        component.destroy();
      },
    });
  }, [closeBlockMathPopup]);

  const editor = useEditor({
    textDirection,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
        codeBlock: false,
        // Link is configured below; StarterKit's own copy opens every clicked
        // link with window.open, including links to notes.
        link: false,
      }),
      CodeBlockLowlight.extend({
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
        // The default fence is always ```, which a ``` line in the code ends
        renderMarkdown(node, h) {
          const language: unknown = node.attrs?.language;
          const code = node.content ? h.renderChildren(node.content) : "";
          const longest = (code.match(/`+/g) ?? []).reduce(
            (max, run) => Math.max(max, run.length),
            0,
          );
          const fence = "`".repeat(Math.max(3, longest + 1));
          const info = typeof language === "string" ? language : "";
          return `${fence}${info}\n${code}\n${fence}`;
        },
      }).configure({
        lowlight,
        defaultLanguage: null,
      }),
      Placeholder.configure({
        placeholder: "Start writing...",
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "underline cursor-pointer",
        },
      }),
      // Convert markdown link syntax [text](url) into real links when typed
      Extension.create({
        name: "markdownLinkInputRule",
        addInputRules() {
          return [
            new InputRule({
              find: /\[([^\]]+)\]\(([^)]+)\)$/,
              handler: ({ state, range, match, commands }) => {
                const [, text, rawUrl] = match;
                const url = normalizeUrl(rawUrl);
                commands.command(({ tr }) => {
                  const linkMark = state.schema.marks.link.create({
                    href: url,
                  });
                  const textNode = state.schema.text(text, [linkMark]);
                  tr.replaceWith(range.from, range.to, textNode);
                  return true;
                });
              },
            }),
          ];
        },
      }),
      ResizableImage,
      FileCard,
      Callout,
      Toggle,
      ToggleSummary,
      ToggleContent,
      MarkHighlight,
      ColorTextStyle,
      Color,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      TableKit.configure({
        table: {
          resizable: false,
          HTMLAttributes: {
            class: "not-prose",
          },
        },
      }),
      Frontmatter,
      Markdown.configure({}),
      SearchHighlight.configure({
        matches: [],
        currentIndex: 0,
      }),
      SlashCommand,
      BlockShortcuts,
      Wikilink,
      WikilinkSuggestion,
      AetherBlockMath.configure({
        katexOptions: {
          throwOnError: false,
          displayMode: true,
          macros: katexMacros,
        },
        onClick: (_node, pos) => {
          handleEditMath(pos);
        },
      }),
      AetherInlineMath.configure({
        katexOptions: {
          throwOnError: false,
          macros: katexMacros,
        },
        onClick: (_node, pos) => {
          handleEditMath(pos);
        },
      }),
      EscapedDollar,
    ],
    editorProps: {
      attributes: {
        class:
          "prose prose-lg dark:prose-invert max-w-3xl mx-auto focus:outline-none min-h-full px-6 pt-8 pb-24",
        spellcheck: "true",
        autocorrect: "on",
        autocapitalize: "sentences",
      },
      // Serialize copied text as markdown instead of plain text
      clipboardTextSerializer: (slice) => {
        const fallback = slice.content.textBetween(
          0,
          slice.content.size,
          "\n\n",
        );
        const currentEditor = editorRef.current;
        const manager = currentEditor?.storage.markdown?.manager;
        if (!currentEditor || !manager) return fallback;
        try {
          const doc = currentEditor.schema.topNodeType.create(
            null,
            slice.content,
          );
          return manager.serialize(doc.toJSON());
        } catch {
          return fallback;
        }
      },
      // Trap Tab key inside the editor
      handleKeyDown: (_view, event) => {
        if (event.key === "Tab") {
          // Allow default tab behavior (indent in lists, etc.)
          // but prevent focus from leaving the editor
          return false;
        }
        return false;
      },
      // Handle markdown and image paste
      handlePaste: (_view, event) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        // Check for images first
        const items = Array.from(clipboardData.items);
        const imageItem = items.find((item) => item.type.startsWith("image/"));

        if (imageItem) {
          const blob = imageItem.getAsFile();
          if (blob) {
            // Convert blob to base64 and handle async operations
            const reader = new FileReader();
            reader.addEventListener("load", async () => {
              if (typeof reader.result !== "string") return;
              const base64 = reader.result.split(",")[1]; // Remove data:image/...;base64, prefix

              try {
                // Save clipboard image
                const relativePath = await invoke<string>(
                  "save_clipboard_image",
                  { base64Data: base64 },
                );
                await insertImage(relativePath);
              } catch (error) {
                console.error("Failed to paste image:", error);
                toast.error("Failed to paste image");
              }
            });
            reader.addEventListener("error", () => {
              console.error("Failed to read clipboard image:", reader.error);
              toast.error("Failed to read clipboard image");
            });
            reader.readAsDataURL(blob);
            return true; // Handled
          }
        }

        // Handle markdown text paste
        const text = clipboardData.getData("text/plain");
        if (!text) return false;

        // Check if text looks like markdown (has common markdown patterns)
        const markdownPatterns =
          /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>\s|```|^\s*\[.*\]\(.*\)|^\s*!\[|\*\*.*\*\*|__.*__|~~.*~~|^\s*[-*_]{3,}\s*$|^\|.+\||\$\$[\s\S]+?\$\$/m;
        if (!markdownPatterns.test(text)) {
          // Not markdown, let TipTap handle it normally
          return false;
        }

        // Parse markdown and insert using editor ref
        const currentEditor = editorRef.current;
        if (!currentEditor) return false;

        const manager = currentEditor.storage.markdown?.manager;
        if (manager && typeof manager.parse === "function") {
          try {
            const parsed = parseMarkdown(manager, text);
            if (parsed) {
              currentEditor.commands.insertContent(parsed);
              return true;
            }
          } catch {
            // Fall back to default paste behavior
          }
        }

        return false;
      },
    },
    onCreate: ({ editor: editorInstance }) => {
      editorRef.current = editorInstance;
    },
    onUpdate: () => {
      if (isLoadingRef.current) return;
      scheduleSave();
    },
    // Prevent flash of unstyled content during initial render
    immediatelyRender: false,
  });

  // Track the modified timestamp of the loaded content
  const loadedModifiedRef = useRef<number | null>(null);
  // Track reloadVersion to detect manual refreshes
  const lastReloadVersionRef = useRef(0);

  // Notify parent component when editor is ready
  useEffect(() => {
    onEditorReady?.(editor);
  }, [editor, onEditorReady]);

  // Sync notes list into editor storage for wikilink autocomplete
  useEffect(() => {
    if (!editor || !notes) return;
    const storage = getWikilinkStorage(editor);
    if (storage) storage.notes = notes;
  }, [editor, notes]);

  // Search navigation functions (defined after editor is created)
  const goToNextMatch = useCallback(() => {
    if (searchMatches.length === 0 || !editor) return;
    const nextIndex = (currentMatchIndex + 1) % searchMatches.length;
    setCurrentMatchIndex(nextIndex);
    updateSearchDecorations(searchMatches, nextIndex, editor);
  }, [searchMatches, currentMatchIndex, editor, updateSearchDecorations]);

  const goToPreviousMatch = useCallback(() => {
    if (searchMatches.length === 0 || !editor) return;
    const prevIndex =
      (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    setCurrentMatchIndex(prevIndex);
    updateSearchDecorations(searchMatches, prevIndex, editor);
  }, [searchMatches, currentMatchIndex, editor, updateSearchDecorations]);

  // Handle search query change
  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const replaceCurrent = useCallback(
    (replaceText: string) => {
      if (!editor || !searchQuery.trim()) return;

      // Recompute from current doc state to avoid stale debounced matches.
      const currentMatches = findMatches(searchQuery, editor);
      if (currentMatches.length === 0) return;

      const safeIndex = Math.min(currentMatchIndex, currentMatches.length - 1);
      const match = currentMatches[safeIndex];
      if (!match) return;

      editor.view.dispatch(
        editor.state.tr.insertText(replaceText, match.from, match.to),
      );

      const newMatches = findMatches(searchQuery, editor);
      setSearchMatches(newMatches);

      if (newMatches.length > 0) {
        // Move to the first match after the replaced range.
        const nextPos = match.from + replaceText.length;
        const nextIndex = newMatches.findIndex((m) => m.from >= nextPos);
        const resolvedIndex = nextIndex === -1 ? 0 : nextIndex;
        setCurrentMatchIndex(resolvedIndex);
        updateSearchDecorations(newMatches, resolvedIndex, editor);
      } else {
        setCurrentMatchIndex(0);
        updateSearchDecorations([], 0, editor);
      }
    },
    [
      editor,
      searchQuery,
      currentMatchIndex,
      findMatches,
      updateSearchDecorations,
    ],
  );

  const replaceAll = useCallback(
    (replaceText: string) => {
      if (!editor || !searchQuery) return;
      const currentMatches = findMatches(searchQuery, editor);
      if (currentMatches.length === 0) return;

      const tr = editor.state.tr;
      for (let i = currentMatches.length - 1; i >= 0; i--) {
        const match = currentMatches[i];
        tr.insertText(replaceText, match.from, match.to);
      }
      editor.view.dispatch(tr);

      const newMatches = findMatches(searchQuery, editor);
      setSearchMatches(newMatches);
      setCurrentMatchIndex(0);
      updateSearchDecorations(newMatches, 0, editor);
    },
    [editor, searchQuery, findMatches, updateSearchDecorations],
  );

  // Debounced search effect
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchMatches([]);
      setCurrentMatchIndex(0);
      // Clear decorations when search is empty
      if (editor) {
        updateSearchDecorations([], 0, editor);
      }
      return undefined;
    }

    const timer = setTimeout(() => {
      if (!editor) return;
      const matches = findMatches(searchQuery, editor);
      setSearchMatches(matches);
      setCurrentMatchIndex(0);
      // Always update decorations (clears old highlights when no matches)
      updateSearchDecorations(matches, 0, editor);
    }, 150);

    return () => clearTimeout(timer);
  }, [searchQuery, editor, findMatches, updateSearchDecorations]);

  // Handle clicks on wikilinks, links to notes, and external links
  useEffect(() => {
    if (!editor) return undefined;

    // Cmd+click opens a linked note in a new tab
    const openLinkedNote = (id: string, e: MouseEvent) => {
      if ((e.metaKey || e.ctrlKey) && tabsRef.current) {
        tabsRef.current.openInNewTab(id);
      } else {
        void notesCtxRef.current?.selectNote(id);
      }
    };

    const handleEditorClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      // Check for wikilink click first (no modifier key required)
      const wikilinkEl = target.closest("[data-wikilink]");
      if (wikilinkEl) {
        e.preventDefault();
        const noteTitle = wikilinkEl.getAttribute("data-note-title");
        const currentNotes = notesRef.current;
        if (noteTitle && currentNotes) {
          const note = currentNotes.find(
            (n) => n.title.toLowerCase() === noteTitle.toLowerCase(),
          );
          if (note) {
            openLinkedNote(note.id, e);
          } else {
            toast.info(`Note "${noteTitle}" does not exist yet`);
          }
        }
        return;
      }

      // Prevent links from opening unless Cmd/Ctrl+Click
      const link = target.closest("a");
      if (link) {
        e.preventDefault();
        const fromId = currentNoteIdRef.current;
        const linkedId =
          fromId && linkedNoteId(link.getAttribute("href") ?? "", fromId);
        if (linkedId && notesCtxRef.current) {
          if (notesRef.current?.some((n) => n.id === linkedId)) {
            openLinkedNote(linkedId, e);
          } else {
            toast.info(`Note "${linkedId}" does not exist`);
          }
          return;
        }
        if ((e.metaKey || e.ctrlKey) && link.href) {
          // Use raw href attribute and normalize to handle protocol-less URLs
          const rawHref = link.getAttribute("href") ?? "";
          const normalizedHref = normalizeUrl(rawHref);
          if (isAllowedUrlScheme(normalizedHref)) {
            openUrl(normalizedHref).catch((error) =>
              console.error("Failed to open link:", error),
            );
          } else {
            toast.error("Cannot open links with this URL scheme");
          }
        }
      }
    };

    const editorElement = editor.view.dom;
    editorElement.addEventListener("click", handleEditorClick);

    return () => {
      editorElement.removeEventListener("click", handleEditorClick);
    };
  }, [editor]);

  // Load note content when the current note changes
  useEffect(() => {
    // Skip if no note or editor
    if (!currentNote || !editor) {
      return;
    }

    // A rename by our own save already moved loadedNoteIdRef (followRename)
    const isSameNote = currentNote.id === loadedNoteIdRef.current;

    // Flush any pending save before switching to a different note
    if (!isSameNote && needsSaveRef.current) {
      void flushPendingSave();
    }
    // Reset source mode when switching notes
    if (!isSameNote) {
      heldRef.current = false;
      setSourceMode(false);
      if (sourceTimeoutRef.current) {
        clearTimeout(sourceTimeoutRef.current);
        sourceTimeoutRef.current = null;
      }
    }
    // Check if this is a manual reload (user clicked Refresh button or pressed Cmd+R)
    const isManualReload = reloadVersion !== lastReloadVersionRef.current;

    if (isSameNote) {
      if (isManualReload) {
        // Manual reload - update the editor content
        lastReloadVersionRef.current = reloadVersion;
        loadedModifiedRef.current = currentNote.modified;
        heldRef.current = false;
        setSourceContent(currentNote.content);
        isLoadingRef.current = true;
        const { from, to } = editor.state.selection;
        const manager = editor.storage.markdown?.manager;
        if (manager) {
          try {
            const parsed = parseMarkdown(manager, currentNote.content);
            editor.commands.setContent(parsed);
          } catch {
            editor.commands.setContent(currentNote.content);
          }
        } else {
          editor.commands.setContent(currentNote.content);
        }
        const size = editor.state.doc.content.size;
        editor.commands.setTextSelection({
          from: Math.min(from, size),
          to: Math.min(to, size),
        });
        isLoadingRef.current = false;
        return;
      }
      // Just a save - update refs but don't reload content
      loadedModifiedRef.current = currentNote.modified;
      return;
    }

    const isNewNote = loadedNoteIdRef.current === null;
    const wasEmpty = !isNewNote && currentNote.content?.trim() === "";
    const loadingNoteId = currentNote.id;

    loadedNoteIdRef.current = loadingNoteId;
    loadedModifiedRef.current = currentNote.modified;

    isLoadingRef.current = true;

    // Blur editor before setting content to prevent ghost cursor
    editor.commands.blur();

    // Parse markdown and set content
    const manager = editor.storage.markdown?.manager;
    if (manager) {
      try {
        const parsed = parseMarkdown(manager, currentNote.content);
        editor.commands.setContent(parsed);
      } catch {
        // Fallback to plain text if parsing fails
        editor.commands.setContent(currentNote.content);
      }
    } else {
      editor.commands.setContent(currentNote.content);
    }

    // Scroll to top, or where the tab was left, after content is set (must be
    // after setContent to work reliably)
    const scrollTop = tabsRef.current?.takeScrollRestore(loadingNoteId) ?? 0;
    scrollContainerRef.current?.scrollTo(0, scrollTop);

    // Capture note ID to check in RAF callback - prevents race condition
    // if user switches notes quickly before RAF fires
    requestAnimationFrame(() => {
      // Bail if a different note started loading
      if (loadedNoteIdRef.current !== loadingNoteId) {
        return;
      }

      // Scroll again in RAF to ensure it takes effect after DOM updates
      scrollContainerRef.current?.scrollTo(0, scrollTop);

      isLoadingRef.current = false;

      if (consumePendingNewNote?.(loadingNoteId)) {
        if (!focusAndSelectTitle(editor)) {
          editor.commands.focus("start");
        }
        return;
      }

      // For brand new empty notes, focus and select all so user can start typing
      // Skip if the note list has focus (e.g. keyboard navigation with arrow keys)
      if ((isNewNote || wasEmpty) && currentNote.content.trim() === "") {
        const noteListFocused =
          document.activeElement?.closest("[data-note-list]");
        if (!noteListFocused) {
          editor.commands.focus("start");
          editor.commands.selectAll();
        }
      }
      // For existing notes, don't auto-focus - let user click where they want
    });
  }, [
    currentNote,
    editor,
    flushPendingSave,
    reloadVersion,
    consumePendingNewNote,
    parseMarkdown,
  ]);

  // Scroll to top on mount (e.g., when returning from settings)
  useEffect(() => {
    scrollContainerRef.current?.scrollTo(0, 0);
  }, []);

  // Cleanup on unmount - flush pending saves
  const flushOnUnmountRef = useRef(flushPendingSave);
  flushOnUnmountRef.current = flushPendingSave;
  useEffect(() => {
    return () => {
      // Fire and forget - save will complete in background
      void flushOnUnmountRef.current();
      if (linkPopupRef.current) {
        linkPopupRef.current.destroy();
      }
      if (blockMathPopupRef.current) {
        blockMathPopupRef.current.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run cleanup on unmount, reading the refs as they are then

  // Link handlers - show inline popup at cursor position
  const handleAddLink = useCallback(() => {
    if (!editor) return;

    // Close block math popup if open (popups are mutually exclusive)
    closeBlockMathPopup();

    // Destroy existing popup if any
    if (linkPopupRef.current) {
      linkPopupRef.current.destroy();
      linkPopupRef.current = null;
    }

    // Get existing link URL if cursor is on a link
    const existingUrl = editor.getAttributes("link").href || "";

    // Get selection bounds for popup placement using DOM Range for accurate multi-line support
    const { from, to } = editor.state.selection;
    const hasSelection = from !== to;

    // Create a virtual element at the selection for tippy to anchor to
    const virtualElement = {
      getBoundingClientRect: () => {
        // For selections with text, use DOM Range for accurate bounds
        if (hasSelection) {
          const startPos = editor.view.domAtPos(from);
          const endPos = editor.view.domAtPos(to);

          if (startPos && endPos) {
            try {
              const range = document.createRange();
              range.setStart(startPos.node, startPos.offset);
              range.setEnd(endPos.node, endPos.offset);
              return range.getBoundingClientRect();
            } catch (e) {
              // Fallback if range creation fails
              console.error("Range creation failed:", e);
            }
          }
        }

        // For collapsed cursor, use coordsAtPos with proper viewport positioning
        const coords = editor.view.coordsAtPos(from);

        // Create a DOMRect-like object with proper positioning
        return {
          width: 2,
          height: 20,
          top: coords.top,
          left: coords.left,
          right: coords.right,
          bottom: coords.bottom,
          x: coords.left,
          y: coords.top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    };

    // Create the link editor component
    const component = new ReactRenderer(LinkEditor, {
      props: {
        initialUrl: existingUrl,
        // Only show text input if there's no selection AND not editing an existing link
        initialText: hasSelection || existingUrl ? undefined : "",
        onSubmit: (url: string, text?: string) => {
          const normalizedUrl = normalizeUrl(url);
          if (normalizedUrl) {
            if (text !== undefined) {
              // No selection case - insert new link with text
              if (text.trim()) {
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    type: "text",
                    text: text.trim(),
                    marks: [{ type: "link", attrs: { href: normalizedUrl } }],
                  })
                  .run();
              }
            } else {
              // Has selection - apply link to selection
              editor
                .chain()
                .focus()
                .extendMarkRange("link")
                .setLink({ href: normalizedUrl })
                .run();
            }
          } else {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
          }
          linkPopupRef.current?.destroy();
          linkPopupRef.current = null;
        },
        onRemove: () => {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
          linkPopupRef.current?.destroy();
          linkPopupRef.current = null;
        },
        onCancel: () => {
          editor.commands.focus();
          linkPopupRef.current?.destroy();
          linkPopupRef.current = null;
        },
      },
      editor,
    });

    // Create tippy popup
    linkPopupRef.current = tippy(document.body, {
      getReferenceClientRect: () => virtualElement.getBoundingClientRect(),
      appendTo: () => document.body,
      content: component.element,
      showOnCreate: true,
      interactive: true,
      trigger: "manual",
      placement: "bottom-start",
      offset: [0, 8],
      onDestroy: () => {
        component.destroy();
      },
    });
  }, [editor, closeBlockMathPopup]);

  // Image handler
  const handleAddImage = useCallback(async () => {
    if (!editor) return;
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    });
    if (selected) {
      try {
        // Copy image to assets folder and get relative path (assets/filename.ext)
        const relativePath = await invoke<string>("copy_image_to_assets", {
          sourcePath: selected,
        });
        await insertImage(relativePath);
      } catch (error) {
        console.error("Failed to add image:", error);
      }
    }
  }, [editor, insertImage]);

  // Attach any file from the file picker
  const handleAddFile = useCallback(async () => {
    const selected = await openDialog({ multiple: false });
    if (selected) await insertFiles([selected]);
  }, [insertFiles]);

  // Files dropped from the OS. The backend opens dropped .md files.
  useEffect(() => {
    if (!editor) return undefined;
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== "drop") return;
      const files = payload.paths.filter(
        (path) => !/\.(?:md|markdown)$/i.test(path),
      );
      const { x, y } = payload.position.toLogical(window.devicePixelRatio);
      const pos = editor.view.posAtCoords({ left: x, top: y })?.pos;
      if (files.length === 0 || pos === undefined) return;
      editor.commands.setTextSelection(pos);
      void insertFiles(files);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [editor, insertFiles]);

  // Listen for slash command image insertion
  useEffect(() => {
    const handler = () => handleAddImage();
    window.addEventListener("slash-command-image", handler);
    return () => window.removeEventListener("slash-command-image", handler);
  }, [handleAddImage]);

  useEffect(() => {
    const handler = () => void handleAddFile();
    window.addEventListener("slash-command-file", handler);
    return () => window.removeEventListener("slash-command-file", handler);
  }, [handleAddFile]);

  // Listen for slash command block math insertion
  useEffect(() => {
    const handler = () => handleAddBlockMath();
    window.addEventListener("slash-command-block-math", handler);
    return () =>
      window.removeEventListener("slash-command-block-math", handler);
  }, [handleAddBlockMath]);

  useEffect(() => {
    const handler = () => handleAddInlineMath();
    window.addEventListener("slash-command-inline-math", handler);
    return () =>
      window.removeEventListener("slash-command-inline-math", handler);
  }, [handleAddInlineMath]);

  // Listen for slash command sub-page creation: a new note inside this
  // note's sub-page folder, linked at the cursor
  useEffect(() => {
    const handler = async () => {
      const parentId = loadedNoteIdRef.current;
      const ctx = notesCtxRef.current;
      if (!parentId || !ctx) return;
      try {
        const subPage = await notesService.createNote(parentId);
        await ctx.refreshNotes();
        if (loadedNoteIdRef.current !== parentId) return;
        editorRef.current
          ?.chain()
          .focus()
          .insertContent({
            type: "text",
            text: subPage.title,
            marks: [
              {
                type: "link",
                attrs: { href: noteHref(parentId, subPage.id) },
              },
            ],
          })
          .unsetMark("link")
          .run();
        tabsRef.current?.openInNewTab(subPage.id);
      } catch (error) {
        console.error("Failed to create sub-page:", error);
        toast.error(errorMessage(error, "Failed to create sub-page"));
      }
    };
    window.addEventListener("slash-command-sub-page", handler);
    return () => window.removeEventListener("slash-command-sub-page", handler);
  }, []);

  // Keyboard shortcut for Cmd+Shift+L to add link (only when editor is focused)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // With Shift held, e.key is "L"
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "l"
      ) {
        // Only handle if we're in the editor
        const target = e.target;
        if (!(target instanceof Element)) return;
        const isInEditor = target.closest(".ProseMirror");
        if (isInEditor && editor) {
          e.preventDefault();
          handleAddLink();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleAddLink, editor]);

  // Keyboard shortcut for Cmd+Shift+C to open copy menu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // With Shift held, e.key is "C"
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        e.preventDefault();
        setCopyMenuOpen(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Open and focus editor search (supports repeated Cmd/Ctrl+F)
  const openEditorSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, []);

  // Cmd/Ctrl+F to open search, ⌥⌘F (macOS) / Ctrl+H to open replace
  // (works when document/editor area is focused)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const openFind =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f";
      // Cmd+H is reserved by macOS (Hide), so replace uses the platform
      // convention: ⌥⌘F on macOS, Ctrl+H elsewhere. e.code is checked on
      // macOS because ⌥ changes e.key to a special character ("ƒ").
      const openReplace = isMac
        ? e.metaKey && e.altKey && !e.shiftKey && e.code === "KeyF"
        : e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "h";
      if (openFind || openReplace) {
        if (!currentNote || !editor) return;

        const target = e.target;
        if (!(target instanceof Element)) return;
        const tagName = target.tagName.toLowerCase();

        // Don't intercept if user is in an input/textarea (except the editor itself or search toolbar)
        if (
          (tagName === "input" || tagName === "textarea") &&
          !target.closest(".ProseMirror") &&
          !target.closest(".search-toolbar-container")
        ) {
          return;
        }

        // Don't intercept if in sidebar
        if (target.closest('[class*="sidebar"]')) {
          return;
        }

        // Open search for the editor
        e.preventDefault();
        if (openReplace) {
          setIsReplaceOpen(true);
        }
        openEditorSearch();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editor, currentNote, openEditorSearch]);

  // Clear search on note switch
  useEffect(() => {
    if (currentNote?.id) {
      setSearchOpen(false);
      setSearchQuery("");
      setReplaceQuery("");
      setIsReplaceOpen(false);
      setSearchMatches([]);
      setCurrentMatchIndex(0);
      // Clear decorations
      if (editor) {
        updateSearchDecorations([], 0, editor);
      }
    }
  }, [currentNote?.id, editor, updateSearchDecorations]);

  // Copy handlers
  const handleCopyMarkdown = useCallback(async () => {
    if (!editor) return;
    try {
      const markdown = getMarkdown(editor);
      await invoke("copy_to_clipboard", { text: markdown });
      toast.success("Copied as Markdown");
    } catch (error) {
      console.error("Failed to copy markdown:", error);
      toast.error("Failed to copy");
    }
  }, [editor, getMarkdown]);

  const handleCopyPlainText = useCallback(async () => {
    if (!editor) return;
    try {
      const markdown = getMarkdown(editor);
      const plainText = plainTextFromMarkdown(markdown);
      await invoke("copy_to_clipboard", { text: plainText });
      toast.success("Copied as plain text");
    } catch (error) {
      console.error("Failed to copy plain text:", error);
      toast.error("Failed to copy");
    }
  }, [editor, getMarkdown]);

  const handleCopyHtml = useCallback(async () => {
    if (!editor) return;
    try {
      const location = loadedNoteLocation();
      const html = location
        ? await noteClipboardHtml(editor, location)
        : editor.getHTML();
      await invoke("copy_to_clipboard", { text: html });
      toast.success("Copied as HTML");
    } catch (error) {
      console.error("Failed to copy HTML:", error);
      toast.error("Failed to copy");
    }
  }, [editor, loadedNoteLocation]);

  // Download handlers
  const handleDownloadPdf = useCallback(async () => {
    if (!editor || !currentNote) return;
    try {
      await downloadPdf(editor, currentNote.title);
    } catch (error) {
      console.error("Failed to open print dialog:", error);
      toast.error("Failed to open print dialog");
    }
  }, [editor, currentNote]);

  // Listen for Cmd+P print shortcut
  useEffect(() => {
    const handler = () => handleDownloadPdf();
    window.addEventListener("print-note", handler);
    return () => window.removeEventListener("print-note", handler);
  }, [handleDownloadPdf]);

  const handleDownloadMarkdown = useCallback(async () => {
    if (!editor || !currentNote) return;
    try {
      const markdown = getMarkdown(editor);
      const saved = await downloadMarkdown(markdown, currentNote.title);
      if (saved) {
        toast.success("Markdown saved successfully");
      }
    } catch (error) {
      console.error("Failed to download markdown:", error);
      toast.error("Failed to save markdown");
    }
  }, [editor, currentNote, getMarkdown]);

  // Only a page with private pages in it has anything to ask about.
  const handleExportZip = useCallback(async () => {
    const id = loadedNoteIdRef.current;
    if (!editor || !currentNote || !id) return;
    const markdown = getMarkdown(editor);
    const title = currentNote.title;
    const { privateRoots, privateNoteIds } = await getVaultStatus();
    const isPrivate = privateRoots.some(
      (root) => root === id || id.startsWith(`${root}/`),
    );
    const page = { id, markdown, title, isPrivate };
    if (isPrivate || privateNoteIds.some((p) => p.startsWith(`${id}/`))) {
      setPageToExport(page);
    } else {
      void exportNoteZip(page.id, page.markdown, page.title, false);
    }
  }, [editor, currentNote, getMarkdown]);

  const handleExportHtml = useCallback(() => {
    const location = loadedNoteLocation();
    if (!editor || !currentNote || !location) return;
    void exportNoteHtml(editor, location, currentNote.title);
  }, [editor, currentNote, loadedNoteLocation]);

  // Toggle source mode — computes anchor data and toggles state;
  // focus/scroll restoration happens in the useLayoutEffect below.
  const toggleSourceMode = useCallback(() => {
    if (!editor) return;
    const container = scrollContainerRef.current;

    if (!sourceMode) {
      // === Entering source mode (TipTap → textarea) ===
      const md = getMarkdown(editor);

      // Find which top-level block is at the viewport top
      let topBlockIndex = 0;
      if (container) {
        const rect = container.getBoundingClientRect();
        try {
          const topPos = editor.view.posAtCoords({
            left: rect.left + rect.width / 2,
            top: rect.top + 10,
          });
          if (topPos) {
            const resolved = editor.state.doc.resolve(
              Math.min(topPos.pos, editor.state.doc.content.size),
            );
            topBlockIndex = resolved.index(0);
          }
        } catch {
          // posAtCoords can fail at edges
        }
      }

      // Find which block the cursor is in
      let cursorBlockIndex = 0;
      try {
        const { from } = editor.state.selection;
        const resolved = editor.state.doc.resolve(
          Math.min(from, editor.state.doc.content.size),
        );
        cursorBlockIndex = resolved.index(0);
      } catch {
        // resolve can fail at edges
      }

      sourceModeTransitionRef.current = { topBlockIndex, cursorBlockIndex, md };
      setSourceContent(md);
      setSourceMode(true);
    } else {
      // === Exiting source mode (textarea → TipTap) ===
      const textarea = container?.querySelector("textarea");

      // Find which block is at the top of the textarea and which has the cursor
      let topBlockIndex = 0;
      let cursorBlockIndex = 0;
      if (textarea) {
        const blockOffsets = getMarkdownBlockOffsets(sourceContent);
        const lineHeight =
          parseFloat(getComputedStyle(textarea).lineHeight) || 20;
        const topLine = Math.floor(textarea.scrollTop / lineHeight);
        const lines = sourceContent.split("\n");
        let charOffset = 0;
        for (let i = 0; i < Math.min(topLine, lines.length); i++) {
          charOffset += lines[i].length + 1;
        }
        for (let i = 0; i < blockOffsets.length; i++) {
          if (blockOffsets[i] <= charOffset) topBlockIndex = i;
          if (blockOffsets[i] <= textarea.selectionStart) cursorBlockIndex = i;
        }
      }

      sourceModeTransitionRef.current = { topBlockIndex, cursorBlockIndex };

      // Parse and set content
      const manager = editor.storage.markdown?.manager;
      if (manager) {
        try {
          const parsed = parseMarkdown(manager, sourceContent);
          editor.commands.setContent(parsed);
        } catch {
          editor.commands.setContent(sourceContent);
        }
      } else {
        editor.commands.setContent(sourceContent);
      }
      setSourceMode(false);
    }
  }, [editor, sourceMode, sourceContent, getMarkdown, parseMarkdown]);

  // Restore focus and scroll position after source mode transitions.
  // useLayoutEffect runs synchronously after React commits DOM changes,
  // guaranteeing the new textarea / EditorContent is mounted.
  useLayoutEffect(() => {
    let rafId: number | undefined;
    const transition = sourceModeTransitionRef.current;
    if (!transition) {
      return () => {};
    }
    sourceModeTransitionRef.current = null;

    const container = scrollContainerRef.current;

    if (sourceMode) {
      // Just entered source mode — focus textarea and scroll to anchor block
      const textarea = container?.querySelector("textarea");
      if (!textarea) return () => {};

      const md = transition.md || "";

      // Place cursor at the start of the same block in markdown
      const blockOffsets = getMarkdownBlockOffsets(md);
      const cursorPos =
        transition.cursorBlockIndex < blockOffsets.length
          ? blockOffsets[transition.cursorBlockIndex]
          : md.length;
      textarea.setSelectionRange(cursorPos, cursorPos);
      textarea.focus();

      if (transition.topBlockIndex < blockOffsets.length) {
        const charOffset = blockOffsets[transition.topBlockIndex];
        const linesBefore = md.slice(0, charOffset).split("\n").length - 1;
        const lineHeight =
          parseFloat(getComputedStyle(textarea).lineHeight) || 20;
        textarea.scrollTop = linesBefore * lineHeight;
      }
    } else if (editor) {
      // Just exited source mode — focus editor and scroll to anchor block.
      // Use rAF because EditorContent reattaches the ProseMirror view in
      // its own useEffect, which hasn't run yet during useLayoutEffect.
      rafId = requestAnimationFrame(() => {
        if (!editor.view?.dom?.isConnected) return;
        const doc = editor.state.doc;
        editor.commands.focus(
          blockIndexToPos(doc, transition.cursorBlockIndex),
        );

        // Scroll to anchor block
        const el = scrollContainerRef.current;
        if (el) {
          try {
            el.scrollTop = 0;
            const coords = editor.view.coordsAtPos(
              blockIndexToPos(doc, transition.topBlockIndex),
            );
            const containerRect = el.getBoundingClientRect();
            el.scrollTop = coords.top - containerRect.top;
          } catch {
            // coordsAtPos can fail if view isn't fully rendered
          }
        }
      });
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [sourceMode, editor]);

  // Listen for toggle-source-mode custom event (from App.tsx shortcut / command palette)
  useEffect(() => {
    const handler = () => toggleSourceMode();
    window.addEventListener("toggle-source-mode", handler);
    return () => window.removeEventListener("toggle-source-mode", handler);
  }, [toggleSourceMode]);

  // Auto-save in source mode with debounce
  const handleSourceChange = useCallback(
    (value: string) => {
      setSourceContent(value);
      if (sourceTimeoutRef.current) {
        clearTimeout(sourceTimeoutRef.current);
      }
      sourceTimeoutRef.current = window.setTimeout(() => {
        sourceTimeoutRef.current = null;
        const noteId = loadedNoteIdRef.current;
        if (noteId && !heldRef.current) void queueSave(noteId, () => value);
      }, 300);
    },
    [queueSave],
  );

  // A file changed on disk: reload it unless the editor has unsaved edits,
  // which then wait for Refresh or Overwrite
  useEffect(() => {
    if (!hasExternalChanges) return;
    if (needsSaveRef.current || sourceTimeoutRef.current !== null) {
      heldRef.current = true;
    } else {
      void reloadCurrentNote();
    }
  }, [hasExternalChanges, reloadCurrentNote]);

  const overwriteExternalChanges = useCallback(() => {
    heldRef.current = false;
    const noteId = loadedNoteIdRef.current;
    if (sourceMode) {
      if (noteId) void queueSave(noteId, () => sourceContent);
    } else {
      needsSaveRef.current = true;
      void flushPendingSave();
    }
  }, [sourceMode, sourceContent, queueSave, flushPendingSave]);

  if (!currentNote) {
    // Preview mode: show loading state (content not yet loaded)
    if (previewMode) {
      return (
        <div className="flex-1 flex flex-col bg-bg">
          {!isWindows && (
            <div
              className="h-10 shrink-0 flex items-end px-4 pb-1"
              data-tauri-drag-region
            ></div>
          )}
          <div className="flex-1 flex items-center justify-center">
            <SpinnerIcon className="w-6 h-6 text-text-muted animate-spin" />
          </div>
        </div>
      );
    }

    // A note is selected but not yet loaded — show loading spinner to avoid empty state flash
    if (notesCtx?.selectedNoteId) {
      return (
        <div className="flex-1 flex flex-col bg-bg">
          {!isWindows && (
            <div
              className="h-10 shrink-0 flex items-end px-4 pb-1"
              data-tauri-drag-region
            ></div>
          )}
          <div className="flex-1 flex items-center justify-center">
            <SpinnerIcon className="w-6 h-6 text-text-muted animate-spin" />
          </div>
        </div>
      );
    }

    // Folder mode: show empty state with "New Note" button
    return (
      <div className="flex-1 flex flex-col bg-bg">
        {/* Drag region */}
        {!isWindows && (
          <div
            className="h-10 shrink-0 flex items-end px-4 pb-1"
            data-tauri-drag-region
          ></div>
        )}
        <div className="flex-1 flex items-center justify-center pb-8">
          <div className="text-center text-text-muted select-none">
            <div
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- tinted via CSS mask with backgroundColor, which an <img> cannot render
              role="img"
              aria-label="Notepad on a stack of books"
              className="w-42 aspect-square mx-auto mb-1"
              style={{
                backgroundColor: "var(--color-text)",
                WebkitMaskImage: "url(/notepad-on-books.svg)",
                WebkitMaskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskImage: "url(/notepad-on-books.svg)",
                maskSize: "contain",
                maskRepeat: "no-repeat",
                maskPosition: "center",
              }}
            />
            <h1 className="text-2xl text-text font-serif mb-1 tracking-[-0.01em] ">
              What's on your mind?
            </h1>
            <p className="text-sm">
              Pick up where you left off, or start something new
            </p>
            {createNote && (
              <Button
                onClick={createNote}
                variant="secondary"
                size="md"
                className="mt-4"
              >
                New Note{" "}
                <span className="text-text-muted ml-1">
                  {mod}
                  {isMac ? "" : "+"}N
                </span>
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-bg overflow-hidden">
      {/* Drag region with sidebar toggle, date and save status */}
      <div
        className={cn(
          "h-11 shrink-0 flex items-center justify-between px-3",
          !isSidebarActive && !isWindows && "pl-22",
        )}
        data-tauri-drag-region
      >
        <div
          className={`flex-1 h-full flex items-center gap-1 min-w-0 mr-2 transition-opacity duration-400 ${needsSidebarDelay ? "delay-200" : ""} ${focusMode ? "opacity-0 pointer-events-none" : "opacity-100"}`}
          data-tauri-drag-region
        >
          {onToggleSidebar && (
            <IconButton
              onClick={onToggleSidebar}
              title={
                isSidebarActive
                  ? `Hide sidebar (${mod}${isMac ? "" : "+"}\\)`
                  : `Show sidebar (${mod}${isMac ? "" : "+"}\\)`
              }
              className="titlebar-no-drag shrink-0"
            >
              <PanelLeftIcon className="w-4.5 h-4.5 stroke-[1.5]" />
            </IconButton>
          )}
          {tabs ? (
            <TabStrip />
          ) : (
            <span className="text-xs text-text-muted mb-px truncate">
              {formatDateTime(currentNote.modified)}
            </span>
          )}
        </div>
        <div
          className={`titlebar-no-drag flex items-center gap-px shrink-0 transition-opacity duration-400 ${needsSidebarDelay ? "delay-200" : ""} ${focusMode ? "opacity-0 pointer-events-none" : "opacity-100"}`}
        >
          {hasExternalChanges ? (
            <>
              <Tooltip
                content={`The file changed on disk. Load it and drop your unsaved edits (${mod}${isMac ? "" : "+"}R)`}
              >
                <button
                  onClick={reloadCurrentNote}
                  className="h-7 px-2 flex items-center gap-1 text-xs text-text-muted hover:bg-bg-emphasis rounded transition-colors font-medium"
                >
                  <RefreshCwIcon className="w-4 h-4 stroke-[1.6]" />
                  <span>Refresh</span>
                </button>
              </Tooltip>
              <Tooltip content="Save your edits over the file on disk">
                <button
                  onClick={overwriteExternalChanges}
                  className="h-7 px-2 flex items-center text-xs text-text-muted hover:bg-bg-emphasis rounded transition-colors font-medium"
                >
                  Overwrite
                </button>
              </Tooltip>
            </>
          ) : isSaving ? (
            <Tooltip content="Saving...">
              <div className="h-7 w-7 flex items-center justify-center">
                <SpinnerIcon className="w-4.5 h-4.5 text-text-muted/40 stroke-[1.5] animate-spin" />
              </div>
            </Tooltip>
          ) : (
            <Tooltip content="All changes saved">
              <div className="h-7 w-7 flex items-center justify-center rounded-full">
                <CircleCheckIcon className="w-4.5 h-4.5 mt-px stroke-[1.5] text-text-muted/40" />
              </div>
            </Tooltip>
          )}
          {currentNote && pinNote && unpinNote && (
            <Tooltip content={isPinned ? "Unpin note" : "Pin note"}>
              <IconButton
                onClick={async () => {
                  if (!currentNote) return;
                  try {
                    if (isPinned) {
                      await unpinNote(currentNote.id);
                      toast.success("Note unpinned");
                    } else {
                      await pinNote(currentNote.id);
                      toast.success("Note pinned");
                    }
                    // Reload settings to update isPinned state
                    const updatedSettings = await notesService.getSettings();
                    setSettings(updatedSettings);
                  } catch (error) {
                    console.error("Failed to pin/unpin note:", error);
                    toast.error(
                      `Failed to ${isPinned ? "unpin" : "pin"} note: ${
                        error instanceof Error ? error.message : "Unknown error"
                      }`,
                    );
                  }
                }}
              >
                <PinIcon
                  className={cn(
                    "w-5 h-5 stroke-[1.3]",
                    isPinned && "fill-current",
                  )}
                />
              </IconButton>
            </Tooltip>
          )}
          {currentNote && (
            <Tooltip content={`Find in note (${mod}${isMac ? "" : "+"}F)`}>
              <IconButton onClick={openEditorSearch}>
                <SearchIcon className="w-4.25 h-4.25 stroke-[1.6]" />
              </IconButton>
            </Tooltip>
          )}
          {currentNote && (
            <Tooltip
              content={
                sourceMode
                  ? `View Formatted (${mod}${isMac ? "" : "+"}${shift}${isMac ? "" : "+"}M)`
                  : `View Markdown Source (${mod}${isMac ? "" : "+"}${shift}${isMac ? "" : "+"}M)`
              }
            >
              <IconButton onClick={toggleSourceMode}>
                {sourceMode ? (
                  <MarkdownOffIcon className="w-4.75 h-4.75 stroke-[1.4]" />
                ) : (
                  <MarkdownIcon className="w-4.75 h-4.75 stroke-[1.4]" />
                )}
              </IconButton>
            </Tooltip>
          )}
          {currentNote && !previewMode && (
            <NoteInfoPanel
              key={currentNote.id}
              noteId={currentNote.id}
              modified={currentNote.modified}
              getText={() =>
                sourceMode
                  ? plainTextFromMarkdown(sourceContent)
                  : (editor?.getText({ blockSeparator: "\n" }) ?? "")
              }
            />
          )}
          <DropdownMenu.Root open={copyMenuOpen} onOpenChange={setCopyMenuOpen}>
            <Tooltip
              content={`Export (${mod}${isMac ? "" : "+"}${shift}${isMac ? "" : "+"}C)`}
            >
              <DropdownMenu.Trigger asChild>
                <IconButton aria-label="Export">
                  <ShareIcon className="w-4.25 h-4.25 stroke-[1.6]" />
                </IconButton>
              </DropdownMenu.Trigger>
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-35 bg-bg border border-border rounded-md shadow-lg py-1 z-50"
                sideOffset={5}
                align="end"
                onCloseAutoFocus={(e) => {
                  // Prevent focus returning to trigger button
                  e.preventDefault();
                }}
                onKeyDown={(e) => {
                  // Stop arrow keys from bubbling to note list navigation
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.stopPropagation();
                  }
                }}
              >
                <DropdownMenu.Item
                  className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                  onSelect={handleCopyMarkdown}
                >
                  <CopyIcon className="w-4 h-4 stroke-[1.6]" />
                  Copy Markdown
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                  onSelect={handleCopyPlainText}
                >
                  <CopyIcon className="w-4 h-4 stroke-[1.6]" />
                  Copy Plain Text
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                  onSelect={handleCopyHtml}
                >
                  <CopyIcon className="w-4 h-4 stroke-[1.6]" />
                  Copy HTML
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="h-px bg-border my-1" />
                <DropdownMenu.Item
                  className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                  onSelect={handleDownloadPdf}
                >
                  <DownloadIcon className="w-4 h-4 stroke-[1.6]" />
                  Print as PDF
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                  onSelect={handleDownloadMarkdown}
                >
                  <DownloadIcon className="w-4 h-4 stroke-[1.6]" />
                  Export Markdown
                </DropdownMenu.Item>
                {!previewMode && (
                  <>
                    <DropdownMenu.Item
                      className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                      onSelect={() => void handleExportZip()}
                    >
                      <DownloadIcon className="w-4 h-4 stroke-[1.6]" />
                      Export Zip
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2"
                      onSelect={handleExportHtml}
                    >
                      <DownloadIcon className="w-4 h-4 stroke-[1.6]" />
                      Export HTML
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {onSaveToFolder && (
            <Tooltip content="Save in Folder">
              <IconButton
                onClick={onSaveToFolder}
                aria-label="Save in Folder"
                disabled={saveToFolderDisabled}
              >
                {saveToFolderDisabled ? (
                  <SpinnerIcon className="w-4.25 h-4.25 animate-spin" />
                ) : (
                  <FolderPlusIcon className="w-4.25 h-4.25 stroke-[1.6]" />
                )}
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Editor content area with resize handles overlay */}
      <div data-editor-content-area className="flex-1 relative overflow-hidden">
        {!focusMode && !sourceMode && (
          <EditorWidthHandles containerRef={scrollContainerRef} />
        )}
        <div
          data-editor-scroll
          ref={scrollContainerRef}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden"
          dir={textDirection}
        >
          {sourceMode ? (
            /* Markdown source textarea */
            <div className="h-full">
              <textarea
                value={sourceContent}
                onChange={(e) => handleSourceChange(e.target.value)}
                wrap="off"
                dir={textDirection}
                className="w-full h-full bg-transparent text-text focus:outline-none resize-none px-6 pt-8 pb-24 mx-auto block"
                style={{
                  maxWidth: "var(--editor-max-width, 48rem)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.875em",
                  lineHeight: "var(--editor-line-height)",
                  tabSize: 2,
                }}
                spellCheck={false}
              />
            </div>
          ) : (
            <>
              {searchOpen && (
                <div className="sticky top-2 z-10 animate-in fade-in slide-in-from-top-4 duration-200 pointer-events-none pr-2 flex justify-end">
                  <div className="pointer-events-auto">
                    <SearchToolbar
                      inputRef={searchInputRef}
                      query={searchQuery}
                      onChange={handleSearchChange}
                      onNext={goToNextMatch}
                      onPrevious={goToPreviousMatch}
                      onClose={() => {
                        setSearchOpen(false);
                        setSearchQuery("");
                        setReplaceQuery("");
                        setIsReplaceOpen(false);
                        setSearchMatches([]);
                        setCurrentMatchIndex(0);
                        // Clear decorations and refocus editor
                        if (editor) {
                          updateSearchDecorations([], 0, editor);
                          editor.commands.focus();
                        }
                      }}
                      currentMatch={
                        searchMatches.length === 0 ? 0 : currentMatchIndex + 1
                      }
                      totalMatches={searchMatches.length}
                      replaceQuery={replaceQuery}
                      onReplaceChange={setReplaceQuery}
                      onReplace={() => replaceCurrent(replaceQuery)}
                      onReplaceAll={() => replaceAll(replaceQuery)}
                      isReplaceOpen={isReplaceOpen}
                      onToggleReplace={() => setIsReplaceOpen(!isReplaceOpen)}
                    />
                  </div>
                </div>
              )}
              <div
                ref={editorAreaRef}
                className="h-full relative"
                onContextMenu={async (e) => {
                  if (!editor) return;

                  // Get the position at the click coordinates
                  const clickPos = editor.view.posAtCoords({
                    left: e.clientX,
                    top: e.clientY,
                  });

                  if (!clickPos) return;

                  // Set the selection to the clicked position
                  editor.chain().focus().setTextSelection(clickPos.pos).run();

                  // Check if we're in a table after updating selection
                  if (!editor.isActive("table")) return;

                  e.preventDefault();

                  try {
                    // Work with the updated selection
                    const { state } = editor;
                    const { selection } = state;
                    const { $anchor } = selection;

                    // Find the table cell/header node
                    let cellDepth = $anchor.depth;
                    while (
                      cellDepth > 0 &&
                      state.doc.resolve($anchor.pos).node(cellDepth).type
                        .name !== "tableCell" &&
                      state.doc.resolve($anchor.pos).node(cellDepth).type
                        .name !== "tableHeader"
                    ) {
                      cellDepth--;
                    }

                    // Guard: if we didn't find a table cell, bail out
                    if (cellDepth <= 0) return;

                    const resolvedNode = state.doc
                      .resolve($anchor.pos)
                      .node(cellDepth);
                    if (
                      resolvedNode.type.name !== "tableCell" &&
                      resolvedNode.type.name !== "tableHeader"
                    ) {
                      return;
                    }

                    // Get the cell position
                    const cellPos = $anchor.before(cellDepth);

                    // Check if we're in the first column (index 0 in parent row)
                    const rowNode = state.doc
                      .resolve(cellPos)
                      .node(cellDepth - 1);
                    let cellIndex = 0;
                    rowNode.forEach((_node, offset) => {
                      if (
                        offset <
                        cellPos - $anchor.before(cellDepth - 1) - 1
                      ) {
                        cellIndex++;
                      }
                    });
                    const isFirstColumn = cellIndex === 0;

                    // Check if we're in the first row (index 0 in parent table)
                    const tableNode = state.doc
                      .resolve(cellPos)
                      .node(cellDepth - 2);
                    let rowIndex = 0;
                    tableNode.forEach((_node, offset) => {
                      if (
                        offset <
                        $anchor.before(cellDepth - 1) -
                          $anchor.before(cellDepth - 2) -
                          1
                      ) {
                        rowIndex++;
                      }
                    });
                    const isFirstRow = rowIndex === 0;

                    const menuItems = [];

                    // Only show "Add Column Before" if not in first column
                    if (!isFirstColumn) {
                      menuItems.push(
                        await MenuItem.new({
                          text: "Add Column Before",
                          action: () =>
                            editor.chain().focus().addColumnBefore().run(),
                        }),
                      );
                    }
                    menuItems.push(
                      await MenuItem.new({
                        text: "Add Column After",
                        action: () =>
                          editor.chain().focus().addColumnAfter().run(),
                      }),
                    );
                    menuItems.push(
                      await MenuItem.new({
                        text: "Delete Column",
                        action: () =>
                          editor.chain().focus().deleteColumn().run(),
                      }),
                    );
                    menuItems.push(
                      await PredefinedMenuItem.new({ item: "Separator" }),
                    );

                    // Only show "Add Row Above" if not in first row
                    if (!isFirstRow) {
                      menuItems.push(
                        await MenuItem.new({
                          text: "Add Row Above",
                          action: () =>
                            editor.chain().focus().addRowBefore().run(),
                        }),
                      );
                    }
                    menuItems.push(
                      await MenuItem.new({
                        text: "Add Row Below",
                        action: () =>
                          editor.chain().focus().addRowAfter().run(),
                      }),
                    );
                    menuItems.push(
                      await MenuItem.new({
                        text: "Delete Row",
                        action: () => editor.chain().focus().deleteRow().run(),
                      }),
                    );
                    menuItems.push(
                      await PredefinedMenuItem.new({ item: "Separator" }),
                    );
                    menuItems.push(
                      await MenuItem.new({
                        text: "Toggle Header Row",
                        action: () =>
                          editor.chain().focus().toggleHeaderRow().run(),
                      }),
                    );
                    menuItems.push(
                      await MenuItem.new({
                        text: "Toggle Header Column",
                        action: () =>
                          editor.chain().focus().toggleHeaderColumn().run(),
                      }),
                    );
                    menuItems.push(
                      await PredefinedMenuItem.new({ item: "Separator" }),
                    );
                    menuItems.push(
                      await MenuItem.new({
                        text: "Delete Table",
                        action: () =>
                          editor.chain().focus().deleteTable().run(),
                      }),
                    );

                    const menu = await Menu.new({ items: menuItems });

                    await menu.popup();
                  } catch (err) {
                    console.error("Table context menu error:", err);
                  }
                }}
              >
                <EditorContent editor={editor} className="h-full text-text" />
                {editor && (
                  <>
                    <BlockHandle editor={editor} containerRef={editorAreaRef} />
                    <SelectionToolbar editor={editor} onLink={handleAddLink} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {pageToExport && (
        <ExportZipDialog
          title={`Export ${pageToExport.title}`}
          description="This page and its sub-pages, with their assets, in one zip."
          privateWarning={
            pageToExport.isPrivate
              ? "This is a private page. It and its sub-pages are exported unencrypted."
              : undefined
          }
          onExport={(includePrivate) =>
            void exportNoteZip(
              pageToExport.id,
              pageToExport.markdown,
              pageToExport.title,
              includePrivate,
            )
          }
          onClose={() => setPageToExport(null)}
        />
      )}
    </div>
  );
}
