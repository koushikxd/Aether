import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useNotes } from "../../context/NotesContext";
import { useTabs } from "../../context/TabsContext";
import { useTheme } from "../../context/ThemeContext";
import { useGit } from "../../context/GitContext";
import * as notesService from "../../services/notes";
import * as aiService from "../../services/ai";
import { downloadPdf, downloadMarkdown } from "../../services/pdf";
import type { NoteMetadata, Settings } from "../../types/note";
import type { Editor } from "@tiptap/react";
import {
  CommandItem,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui";
import { cleanTitle } from "../../lib/utils";
import { plainTextFromMarkdown } from "../../lib/plainText";
import { useDeleteNoteWarning } from "../../lib/folderTree";
import { editorMarkdown } from "../../lib/assetPaths";
import {
  CopyIcon,
  DownloadIcon,
  SettingsIcon,
  SwatchIcon,
  GitCommitIcon,
  RefreshCwIcon,
  AddNoteIcon,
  TrashIcon,
  PinIcon,
  ClaudeIcon,
  ZenIcon,
  MarkdownIcon,
  CodexIcon,
  OpenCodeIcon,
  OllamaIcon,
  FolderIcon,
  KeyboardIcon,
  SearchIcon,
  NoteIcon,
  PencilIcon,
  FileExportIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
} from "../icons";
import { alt, mod, shift } from "../../lib/platform";
import type { NoteNavigation } from "../../lib/noteNavigation";
import type { AiProvider } from "../../services/ai";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: ReactNode;
  subView?: boolean;
  action: () => void;
}

export type SubView = "search" | "recent" | "theme" | "ai" | "copy";
type View = "root" | SubView;

const SUB_VIEW_NAMES: Record<SubView, string> = {
  search: "Search Notes",
  recent: "Recent Notes",
  theme: "Theme",
  ai: "Edit with AI",
  copy: "Copy / Export",
};

const AI_PROVIDERS: Record<
  AiProvider,
  { label: string; Icon: typeof ClaudeIcon }
> = {
  claude: { label: "Claude Code", Icon: ClaudeIcon },
  codex: { label: "OpenAI Codex", Icon: CodexIcon },
  opencode: { label: "OpenCode", Icon: OpenCodeIcon },
  ollama: { label: "Ollama", Icon: OllamaIcon },
};

/** Wraps each query word found in `text` in a <mark>, ignoring case. */
function highlight(text: string, query: string): ReactNode {
  const words = query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  // Longest first, so "notes" wins over "no" where both match
  words.sort((a, b) => b.length - a.length);
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-transparent text-text font-semibold">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

interface CommandPaletteProps {
  open: boolean;
  /** Sub-view to show when the palette opens; root when unset. */
  initialView?: SubView;
  /** Picked notes open in a new tab, and Esc closes the palette (Cmd+T). */
  newTab?: boolean;
  navigation: NoteNavigation;
  onClose: () => void;
  /** Runs when a command opens or creates a note, so App can leave Settings. */
  onOpenNote: () => void;
  onOpenSettings?: () => void;
  onOpenShortcuts?: () => void;
  onOpenAiModal?: (provider: AiProvider) => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  editorRef?: React.RefObject<Editor | null>;
}

export function CommandPalette({
  open,
  initialView,
  newTab = false,
  navigation,
  onClose,
  onOpenNote,
  onOpenSettings,
  onOpenShortcuts,
  onOpenAiModal,
  focusMode,
  onToggleFocusMode,
  editorRef,
}: CommandPaletteProps) {
  const {
    notes,
    selectNote,
    createNote,
    deleteNote,
    currentNote,
    duplicateNote,
    pinNote,
    unpinNote,
    notesFolder,
    createNoteInFolder,
  } = useNotes();
  const { openInNewTab } = useTabs();
  const { recentNotes, parentPageId, goBack, goForward } = navigation;
  // Cmd+Shift+O opens Recent Notes on the previous note, so Enter switches back
  const startIndex =
    initialView === "recent" &&
    recentNotes.length > 1 &&
    recentNotes[0].id === currentNote?.id
      ? 1
      : 0;
  const { setTheme } = useTheme();
  const { status, gitAvailable, gitEnabled, commit, sync, isSyncing } =
    useGit();
  const [view, setView] = useState<View>(initialView ?? "root");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(startIndex);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const deleteWarning = useDeleteNoteWarning(
    deleteDialogOpen ? noteToDelete : null,
  );
  const [searchResults, setSearchResults] = useState<
    notesService.SearchResult[]
  >([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [availableAiProviders, setAvailableAiProviders] = useState<
    AiProvider[]
  >([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentNoteId = currentNote?.id;

  // Clear search on open and close, reset view, query and selection on open
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setSearchResults([]);
    if (open) {
      setView(initialView ?? "root");
      setQuery("");
      setSelectedIndex(startIndex);
    }
  }

  const openView = useCallback((next: View) => {
    setView(next);
    setQuery("");
    setSelectedIndex(0);
    setSearchResults([]);
  }, []);

  const openNote = useCallback(
    (id: string, inNewTab = newTab) => {
      if (inNewTab) openInNewTab(id);
      else void selectNote(id);
      onOpenNote();
      onClose();
    },
    [newTab, openInNewTab, selectNote, onOpenNote, onClose],
  );

  // Clear AI providers whenever the palette closes or no note is selected
  const canLoadAiProviders = open && !!currentNoteId;
  const [prevCanLoadAiProviders, setPrevCanLoadAiProviders] =
    useState(canLoadAiProviders);
  if (canLoadAiProviders !== prevCanLoadAiProviders) {
    setPrevCanLoadAiProviders(canLoadAiProviders);
    if (!canLoadAiProviders) setAvailableAiProviders([]);
  }

  // Load settings when palette opens or current note changes
  useEffect(() => {
    if (open) {
      void notesService.getSettings().then(setSettings);
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- currentNoteId is a deliberate refetch trigger for pinned state
  }, [open, currentNoteId]);

  useEffect(() => {
    if (!open || !currentNoteId) return undefined;

    let active = true;
    aiService
      .getAvailableAiProviders()
      .then((providers) => {
        if (active) {
          setAvailableAiProviders(providers);
        }
      })
      .catch((error) => {
        if (active) {
          console.error("Failed to discover AI providers:", error);
          setAvailableAiProviders([]);
        }
      });

    return () => {
      active = false;
    };
  }, [open, currentNoteId]);

  // Root commands and the command lists of the Theme, AI, and Copy sub-views
  const commands = useMemo(() => {
    const subViewCommand = (
      subView: SubView,
      label: string,
      icon: ReactNode,
    ): Command => ({
      id: `view-${subView}`,
      label,
      icon,
      subView: true,
      action: () => openView(subView),
    });
    const aiCommands: Command[] = [];
    const copyCommands: Command[] = [];
    const baseCommands: Command[] = [
      {
        ...subViewCommand(
          "search",
          "Search Notes",
          <SearchIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        ),
        shortcut: `${mod} ${shift} F`,
      },
      {
        ...subViewCommand(
          "recent",
          "Recent Notes",
          <NoteIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        ),
        shortcut: `${mod} ${shift} O`,
      },
      {
        id: "new-note",
        label: "New Note",
        shortcut: `${mod} N`,
        icon: <AddNoteIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          void createNote();
          onOpenNote();
          onClose();
        },
      },
    ];

    // Navigation commands, each only when it has somewhere to go
    if (currentNote) {
      baseCommands.push({
        id: "new-sub-page",
        label: "New Sub-page",
        shortcut: `${mod} ${shift} N`,
        icon: <AddNoteIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          void createNoteInFolder(currentNote.id);
          onOpenNote();
          onClose();
        },
      });
    }
    if (goBack) {
      baseCommands.push({
        id: "go-back",
        label: "Go Back",
        shortcut: `${mod} [`,
        icon: <ArrowLeftIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          goBack();
          onOpenNote();
          onClose();
        },
      });
    }
    if (goForward) {
      baseCommands.push({
        id: "go-forward",
        label: "Go Forward",
        shortcut: `${mod} ]`,
        icon: <ArrowRightIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          goForward();
          onOpenNote();
          onClose();
        },
      });
    }
    if (parentPageId) {
      baseCommands.push({
        id: "go-to-parent",
        label: "Go to Parent Page",
        shortcut: `${mod} ${alt} ↑`,
        icon: <ArrowUpIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => openNote(parentPageId),
      });
    }

    // Add note-specific commands if a note is selected
    if (currentNote) {
      const isPinned =
        settings?.pinnedNoteIds?.includes(currentNote.id) || false;
      if (onOpenAiModal) {
        for (const provider of availableAiProviders) {
          const { label, Icon } = AI_PROVIDERS[provider];
          aiCommands.push({
            id: `ai-edit-${provider}`,
            label,
            icon: <Icon className="w-4.5 h-4.5 fill-text-muted" />,
            action: () => {
              onOpenAiModal(provider);
              onClose();
            },
          });
        }
      }

      baseCommands.push(
        {
          id: isPinned ? "unpin-note" : "pin-note",
          label: isPinned ? "Unpin Current Note" : "Pin Current Note",
          icon: <PinIcon className="w-5 h-5 stroke-[1.3]" />,
          action: async () => {
            try {
              if (isPinned) {
                await unpinNote(currentNote.id);
              } else {
                await pinNote(currentNote.id);
              }
              onClose();
            } catch (error) {
              console.error("Failed to pin/unpin note:", error);
              toast.error(`Failed to ${isPinned ? "unpin" : "pin"} note`);
            }
          },
        },
        ...(aiCommands.length > 0
          ? [
              subViewCommand(
                "ai",
                "Edit with AI...",
                <PencilIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
              ),
            ]
          : []),
        {
          id: "duplicate-note",
          label: "Duplicate Current Note",
          shortcut: `${mod} D`,
          icon: <CopyIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            await duplicateNote(currentNote.id);
            onOpenNote();
            onClose();
          },
        },
        {
          id: "move-note",
          label: "Move to...",
          icon: <ArrowRightIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: () => {
            onClose();
            window.dispatchEvent(
              new CustomEvent("open-move-picker", {
                detail: { ids: [currentNote.id] },
              }),
            );
          },
        },
        {
          id: "delete-note",
          label: "Delete Current Note",
          icon: <TrashIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: () => {
            setNoteToDelete(currentNote.id);
            setDeleteDialogOpen(true);
          },
        },
        subViewCommand(
          "copy",
          "Copy / Export...",
          <FileExportIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        ),
      );

      copyCommands.push(
        {
          id: "copy-markdown",
          label: "Copy Markdown",
          icon: <CopyIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            try {
              await invoke("copy_to_clipboard", { text: currentNote.content });
              toast.success("Copied as Markdown");
              onClose();
            } catch (error) {
              console.error("Failed to copy markdown:", error);
              toast.error("Failed to copy");
            }
          },
        },
        {
          id: "copy-plain",
          label: "Copy Plain Text",
          icon: <CopyIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            try {
              const plainText = plainTextFromMarkdown(currentNote.content);
              await invoke("copy_to_clipboard", { text: plainText });
              toast.success("Copied as plain text");
              onClose();
            } catch (error) {
              console.error("Failed to copy plain text:", error);
              toast.error("Failed to copy");
            }
          },
        },
        // Command actions run only from click/keydown handlers, never during render
        /* oxlint-disable react/refs */
        {
          id: "copy-html",
          label: "Copy HTML",
          icon: <CopyIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            try {
              if (!editorRef?.current) {
                toast.error("Editor not available");
                return;
              }
              const html = editorRef.current.getHTML();
              await invoke("copy_to_clipboard", { text: html });
              toast.success("Copied as HTML");
              onClose();
            } catch (error) {
              console.error("Failed to copy HTML:", error);
              toast.error("Failed to copy");
            }
          },
        },
        {
          id: "download-pdf",
          label: "Print as PDF",
          icon: <DownloadIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            try {
              if (!editorRef?.current || !currentNote) {
                toast.error("Editor not available");
                return;
              }
              await downloadPdf(editorRef.current, currentNote.title);
              // Note: window.print() opens the print dialog but doesn't wait for user action
              // No success toast needed - the print dialog provides its own feedback
              onClose();
            } catch (error) {
              console.error("Failed to open print dialog:", error);
              toast.error("Failed to open print dialog");
            }
          },
        },
        {
          id: "download-markdown",
          label: "Export Markdown",
          icon: <DownloadIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            try {
              if (!currentNote) {
                toast.error("No note selected");
                return;
              }
              // Use live editor content, fall back to saved content
              const editorInstance = editorRef?.current;
              const markdown = editorInstance
                ? editorMarkdown(
                    editorInstance,
                    notesFolder
                      ? { notesFolder, noteId: currentNote.id }
                      : null,
                  )
                : currentNote.content;
              const saved = await downloadMarkdown(markdown, currentNote.title);
              if (saved) {
                toast.success("Markdown saved successfully");
                onClose();
              }
            } catch (error) {
              console.error("Failed to download markdown:", error);
              toast.error("Failed to save markdown");
            }
          },
        },
        /* oxlint-enable react/refs */
      );
    }

    // Add git commands when git integration is visible and initialized
    if (gitEnabled && gitAvailable && status?.isRepo) {
      const hasChanges = (status?.changedCount ?? 0) > 0;
      const canSync = status?.hasRemote && status?.hasUpstream && !isSyncing;

      if (hasChanges) {
        baseCommands.push({
          id: "git-commit",
          label: "Git: Quick Commit",
          icon: <GitCommitIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            const success = await commit("Quick commit from Aether");
            if (success) {
              toast.success("Changes committed");
            } else {
              toast.error("Failed to commit");
            }
            onClose();
          },
        });
      }

      if (canSync) {
        baseCommands.push({
          id: "git-sync",
          label: "Git: Sync (Pull and Push)",
          icon: <RefreshCwIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
          action: async () => {
            const result = await sync();
            if (result.ok) {
              toast.success(result.message);
            } else {
              toast.error(result.error);
            }
            onClose();
          },
        });
      }
    }

    // Focus mode and source toggle
    baseCommands.push(
      {
        id: "focus-mode",
        label: focusMode ? "Exit Focus Mode" : "Enter Focus Mode",
        shortcut: `${mod} ${shift} Enter`,
        icon: <ZenIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          onToggleFocusMode?.();
          onClose();
        },
      },
      {
        id: "toggle-source",
        label: "Toggle Markdown Source",
        shortcut: `${mod} ${shift} M`,
        icon: <MarkdownIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          window.dispatchEvent(new CustomEvent("toggle-source-mode"));
          onClose();
        },
      },
    );

    // Open notes folder
    if (notesFolder) {
      baseCommands.push({
        id: "open-folder",
        label: "Open Notes Folder",
        icon: <FolderIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: async () => {
          try {
            await invoke("open_in_file_manager", { path: notesFolder });
            onClose();
          } catch (error) {
            console.error("Failed to open folder:", error);
            toast.error("Failed to open folder");
          }
        },
      });
    }

    // Keyboard shortcuts, settings, and theme commands at the bottom
    baseCommands.push(
      {
        id: "keyboard-shortcuts",
        label: "Keyboard Shortcuts",
        shortcut: `${mod} /`,
        icon: <KeyboardIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          onOpenShortcuts?.();
          onClose();
        },
      },
      {
        id: "settings",
        label: "Settings",
        shortcut: `${mod} ,`,
        icon: <SettingsIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          onOpenSettings?.();
          onClose();
        },
      },
      subViewCommand(
        "theme",
        "Theme...",
        <SwatchIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
      ),
    );

    const themeCommands = (["light", "dark", "system"] as const).map(
      (mode): Command => ({
        id: `theme-${mode}`,
        label: mode.charAt(0).toUpperCase() + mode.slice(1),
        icon: <SwatchIcon className="w-4.5 h-4.5 stroke-[1.5]" />,
        action: () => {
          setTheme(mode);
          onClose();
        },
      }),
    );

    return {
      root: baseCommands,
      theme: themeCommands,
      ai: aiCommands,
      copy: copyCommands,
    };
  }, [
    openView,
    openNote,
    createNote,
    createNoteInFolder,
    goBack,
    goForward,
    parentPageId,
    currentNote,
    onClose,
    onOpenNote,
    onOpenSettings,
    onOpenAiModal,
    availableAiProviders,
    setTheme,
    gitEnabled,
    gitAvailable,
    status,
    commit,
    sync,
    isSyncing,
    duplicateNote,
    settings,
    pinNote,
    unpinNote,
    focusMode,
    onToggleFocusMode,
    notesFolder,
    onOpenShortcuts,
    editorRef,
  ]);

  // Debounced full-content search, only in the Search Notes sub-view
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || view !== "search" || !trimmed) return undefined;

    // A response for an older query must not replace newer results
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const results = await notesService.searchNotes(trimmed);
        if (current) setSearchResults(results);
      } catch (err) {
        console.error("Search failed:", err);
      }
    }, 150);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, open, view]);

  const visibleCommands = useMemo(() => {
    const list = view === "search" || view === "recent" ? [] : commands[view];
    const lower = query.trim().toLowerCase();
    if (!lower) return list;
    return list.filter((cmd) => cmd.label.toLowerCase().includes(lower));
  }, [view, commands, query]);

  // Root and Recent Notes filter titles in memory; Search Notes asks the backend
  const visibleNotes = useMemo<NoteMetadata[]>(() => {
    const lower = query.trim().toLowerCase();
    const byTitle = (list: NoteMetadata[]) =>
      list.filter((note) =>
        cleanTitle(note.title).toLowerCase().includes(lower),
      );
    switch (view) {
      case "root":
        return lower ? byTitle(notes).slice(0, 10) : recentNotes.slice(0, 5);
      case "recent":
        return byTitle(recentNotes);
      case "search":
        return lower ? searchResults : recentNotes.slice(0, 9);
      default:
        return [];
    }
  }, [view, query, notes, recentNotes, searchResults]);

  const rowCount = visibleCommands.length + visibleNotes.length;

  const runRow = useCallback(
    (index: number, inNewTab?: boolean) => {
      if (index < visibleCommands.length) {
        visibleCommands[index].action();
        return;
      }
      const note = visibleNotes[index - visibleCommands.length];
      if (note) openNote(note.id, inNewTab);
    },
    [visibleCommands, visibleNotes, openNote],
  );

  // Focus input when opened, and again on entering a sub-view by clicking its row
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- view is a deliberate refocus trigger
  }, [open, view]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedItem = listRef.current.querySelector(
        `[data-index="${selectedIndex}"]`,
      );
      selectedItem?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedIndex]);

  const handleDeleteConfirm = useCallback(async () => {
    if (noteToDelete) {
      try {
        await deleteNote(noteToDelete);
        setNoteToDelete(null);
        setDeleteDialogOpen(false);
        onClose();
      } catch (error) {
        console.error("Failed to delete note:", error);
        toast.error("Failed to delete note");
      }
    }
  }, [noteToDelete, deleteNote, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Cmd+1-9 runs the row in that slot. Stopping the event keeps App and
      // Settings (which binds Cmd+1-5 to tabs) from handling it too.
      if (
        view !== "root" &&
        (e.metaKey || e.ctrlKey) &&
        /^[1-9]$/.test(e.key)
      ) {
        e.preventDefault();
        e.stopPropagation();
        runRow(Number(e.key) - 1);
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(0, Math.min(i + 1, rowCount - 1)));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          // Cmd+Enter opens a note in a new tab
          runRow(selectedIndex, e.metaKey || e.ctrlKey || undefined);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          if (view === "root" || newTab) onClose();
          else openView("root");
          break;
        case "Backspace":
          if (view !== "root" && query === "") {
            e.preventDefault();
            e.stopPropagation();
            openView("root");
          }
          break;
      }
    },
    [view, query, rowCount, selectedIndex, runRow, onClose, openView, newTab],
  );

  if (!open) return null;

  const commandsCount = visibleCommands.length;
  const highlightQuery = view === "search" ? query.trim() : "";
  // Root rows show their own shortcut; sub-view rows show their Cmd+1-9 slot
  const shortcutFor = (index: number, own?: string) => {
    if (view === "root") return own;
    return index < 9 ? `${mod} ${index + 1}` : undefined;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center py-11 px-4 pointer-events-none">
      {/* Palette */}
      <div
        data-command-menu
        className="relative w-full h-full max-h-108 max-w-2xl bg-bg rounded-xl shadow-2xl overflow-hidden border border-border animate-slide-down flex flex-col pointer-events-auto"
      >
        {/* Search input, with the sub-view name as a chip */}
        <div className="border-b border-border flex-none flex items-center">
          {view !== "root" && (
            <span className="ml-4 shrink-0 rounded-md bg-bg-muted px-2 py-0.5 text-sm font-medium text-text">
              {SUB_VIEW_NAMES[view]}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
              if (!e.target.value.trim()) setSearchResults([]);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              view === "root"
                ? "Search notes or type a command..."
                : newTab
                  ? "Open a note in a new tab..."
                  : view === "search"
                    ? "Search note contents..."
                    : "Type to filter..."
            }
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 min-w-0 px-4.5 py-3.5 text-[17px] bg-transparent outline-none text-text placeholder-text-muted/50"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto h-full p-2.5 flex-1">
          {rowCount === 0 ? (
            <div className="text-sm font-medium opacity-50 text-text-muted p-2">
              No results found
            </div>
          ) : (
            <>
              {/* Commands section */}
              {visibleCommands.length > 0 && (
                <div className="space-y-0.5 mb-5">
                  {view === "root" && (
                    <div className="text-sm font-medium text-text-muted px-2.5 py-1.5">
                      Commands
                    </div>
                  )}
                  {visibleCommands.map((cmd, i) => {
                    return (
                      <div key={cmd.id} data-index={i}>
                        <CommandItem
                          label={cmd.label}
                          shortcut={shortcutFor(i, cmd.shortcut)}
                          subView={cmd.subView}
                          icon={cmd.icon}
                          isSelected={selectedIndex === i}
                          onClick={cmd.action}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Notes section */}
              {visibleNotes.length > 0 && (
                <div className="space-y-0.5">
                  {view === "root" && (
                    <div className="text-sm font-medium text-text-muted px-2.5 py-1.5">
                      Notes
                    </div>
                  )}
                  {visibleNotes.map((note, i) => {
                    const title = cleanTitle(note.title);
                    const firstLetter = title.charAt(0).toUpperCase();
                    // Clean subtitle: treat whitespace-only or &nbsp; as empty
                    const cleanSubtitle = note.preview
                      ?.replace(/&nbsp;/g, " ")
                      .replace(/\u00A0/g, " ")
                      .trim();
                    const index = commandsCount + i;
                    return (
                      <div key={note.id} data-index={index}>
                        <CommandItem
                          label={title}
                          subtitle={
                            cleanSubtitle &&
                            highlight(cleanSubtitle, highlightQuery)
                          }
                          shortcut={shortcutFor(index)}
                          iconText={firstLetter}
                          variant="note"
                          isSelected={selectedIndex === index}
                          onClick={() => openNote(note.id)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Key hints */}
        <div className="flex-none border-t border-border px-4.5 py-2 flex items-center gap-4 text-xs text-text-muted">
          {[
            ["↑↓", "Navigate"],
            ["↵", "Select"],
            ["Esc", view === "root" ? "Close" : "Back"],
          ].map(([key, action]) => (
            <span key={action} className="flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 rounded-md bg-bg-muted">{key}</kbd>
              {action}
            </span>
          ))}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteWarning.text}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!deleteWarning.ready}
              onClick={handleDeleteConfirm}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
