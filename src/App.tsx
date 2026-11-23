import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { NotesProvider, useNotes } from "./context/NotesContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { listen } from "@tauri-apps/api/event";
import { GitProvider } from "./context/GitContext";
import { VaultProvider } from "./context/VaultContext";
import { TooltipProvider, Toaster } from "./components/ui";
import { Sidebar } from "./components/layout/Sidebar";
import { SidebarResizeHandle } from "./components/layout/SidebarResizeHandle";
import { SIDEBAR_DEFAULT_PX } from "./lib/sidebar";
import { Editor } from "./components/editor/Editor";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { FolderPicker } from "./components/layout/FolderPicker";
import {
  CommandPalette,
  type SubView,
} from "./components/command-palette/CommandPalette";
import { SettingsPage } from "./components/settings";
import {
  SpinnerIcon,
  ClaudeIcon,
  CodexIcon,
  OpenCodeIcon,
  OllamaIcon,
} from "./components/icons";
import { AiEditModal } from "./components/ai/AiEditModal";
import { AiResponseToast } from "./components/ai/AiResponseToast";
import { KeyboardShortcutsModal } from "./components/shortcuts/KeyboardShortcutsModal";
import { MovePageDialog } from "./components/notes/MovePageDialog";
import { PreviewApp } from "./components/preview/PreviewApp";
import {
  check as checkForUpdate,
  type Update,
} from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as aiService from "./services/ai";
import type { AiProvider } from "./services/ai";
import { isMac, isWindows } from "./lib/platform";
import { useNoteNavigation } from "./lib/noteNavigation";
import { TabsProvider, useTabs } from "./context/TabsContext";

// Detect preview mode from URL search params
function getWindowMode(): {
  isPreview: boolean;
  previewFile: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const file = params.get("file");
  return {
    isPreview: mode === "preview" && !!file,
    previewFile: file,
  };
}

type ViewState = "notes" | "settings";

function AppContent() {
  const {
    notesFolder,
    isLoading,
    createNote,
    duplicateNote,
    notes,
    selectedNoteId,
    selectNote,
    reloadCurrentNote,
    currentNote,
    syncNotesFolder,
    createNoteInFolder,
  } = useNotes();
  const navigation = useNoteNavigation();
  const tabs = useTabs();
  const { interfaceZoom, setInterfaceZoom, reloadSettings } = useTheme();
  const interfaceZoomRef = useRef(interfaceZoom);
  const currentNoteRef = useRef(currentNote);
  useEffect(() => {
    interfaceZoomRef.current = interfaceZoom;
    currentNoteRef.current = currentNote;
  }, [interfaceZoom, currentNote]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteView, setPaletteView] = useState<SubView>();
  // Cmd+T: the note picked in the palette opens in a new tab
  const [paletteNewTab, setPaletteNewTab] = useState(false);
  // Bumped to remount an open palette in the requested sub-view
  const [paletteKey, setPaletteKey] = useState(0);
  const openPaletteIn = useCallback((subView: SubView, newTab = false) => {
    setPaletteView(subView);
    setPaletteNewTab(newTab);
    setPaletteKey((k) => k + 1);
    setPaletteOpen(true);
  }, []);
  const [view, setView] = useState<ViewState>("notes");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aiEditing, setAiEditing] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [aiProvider, setAiProvider] = useState<AiProvider>("claude");
  const editorRef = useRef<TiptapEditor | null>(null);

  // Listen for set-notes-folder event from CLI (aether .)
  // Placed here in AppContent where both NotesContext and ThemeContext are available
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("set-notes-folder", async (event) => {
      await syncNotesFolder(event.payload);
      await reloadSettings();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [syncNotesFolder, reloadSettings]);

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => !prev);
  }, []);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      // Don't enter focus mode without a selected note
      if (!prev && !selectedNoteId) return prev;
      if (prev) {
        // Exiting focus mode — always restore sidebar
        setSidebarVisible(true);
      }
      return !prev;
    });
  }, [selectedNoteId]);

  const toggleSettings = useCallback(() => {
    setView((prev) => (prev === "settings" ? "notes" : "settings"));
  }, []);

  const closeSettings = useCallback(() => {
    setView("notes");
  }, []);

  // Go back to command palette from AI modal
  const handleBackToPalette = useCallback(() => {
    setAiModalOpen(false);
    setPaletteOpen(true);
  }, []);

  // AI Edit handler
  const handleAiEdit = useCallback(
    async (prompt: string, ollamaModel?: string) => {
      if (!currentNote) {
        toast.error("No note selected");
        return;
      }

      setAiEditing(true);

      try {
        let result: aiService.AiExecutionResult;
        if (aiProvider === "codex") {
          result = await aiService.executeCodexEdit(currentNote.path, prompt);
        } else if (aiProvider === "opencode") {
          result = await aiService.executeOpenCodeEdit(
            currentNote.path,
            prompt,
          );
        } else if (aiProvider === "ollama") {
          result = await aiService.executeOllamaEdit(
            currentNote.path,
            prompt,
            ollamaModel || "qwen3:8b",
          );
        } else {
          result = await aiService.executeClaudeEdit(currentNote.path, prompt);
        }

        // Reload the current note from disk
        await reloadCurrentNote();

        // Show results
        if (result.success) {
          // Close modal after success
          setAiModalOpen(false);

          // Show success toast with provider response
          toast(
            <AiResponseToast output={result.output} provider={aiProvider} />,
            {
              duration: Infinity,
              closeButton: true,
              className: "!min-w-[450px] !max-w-[600px]",
            },
          );
        } else {
          toast.error(
            <div className="space-y-1">
              <div className="font-medium">AI Edit Failed</div>
              <div className="text-xs">{result.error || "Unknown error"}</div>
            </div>,
            { duration: Infinity, closeButton: true },
          );
        }
      } catch (error) {
        console.error("[AI] Error:", error);
        toast.error(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      } finally {
        setAiEditing(false);
      }
    },
    [aiProvider, currentNote, reloadCurrentNote],
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const isInEditor = !!target.closest(".ProseMirror");
      const isInInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const isEditorEmpty =
        isInEditor && currentNoteRef.current?.content.trim() === "";

      // Cmd+, - Toggle settings (always works, even in settings)
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        toggleSettings();
        return;
      }

      // Cmd+= or Cmd++ - Zoom in (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setInterfaceZoom((prev) => prev + 0.05);
        const newZoom =
          Math.round(Math.min(interfaceZoomRef.current + 0.05, 1.5) * 20) / 20;
        toast(`Zoom ${Math.round(newZoom * 100)}%`, {
          id: "zoom",
          duration: 1500,
        });
        return;
      }

      // Cmd+- - Zoom out (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        setInterfaceZoom((prev) => prev - 0.05);
        const newZoom =
          Math.round(Math.max(interfaceZoomRef.current - 0.05, 0.7) * 20) / 20;
        toast(`Zoom ${Math.round(newZoom * 100)}%`, {
          id: "zoom",
          duration: 1500,
        });
        return;
      }

      // Cmd+0 - Reset zoom (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setInterfaceZoom(1.0);
        toast("Zoom 100%", { id: "zoom", duration: 1500 });
        return;
      }

      // Cmd+K - Open command menu (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;

      // Cmd+W - Close the tab; the last tab, or Settings, closes the window
      if (mod && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (view === "settings" || !tabs.closeActiveTab()) {
          getCurrentWindow().close().catch(console.error);
        }
        return;
      }

      // Block all other shortcuts when in settings view
      if (view === "settings") {
        return;
      }

      // Tab shortcuts. The command menu keeps Cmd+1-9 for its rows.
      if (!paletteOpen) {
        // Ctrl+Tab / Ctrl+Shift+Tab - Next / previous tab
        if (e.ctrlKey && e.key === "Tab") {
          e.preventDefault();
          tabs.cycleTab(e.shiftKey ? -1 : 1);
          return;
        }

        // Cmd+1-8 - Go to that tab; Cmd+9 - Go to the last tab
        if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
          e.preventDefault();
          tabs.activateIndex(e.key === "9" ? -1 : Number(e.key) - 1);
          return;
        }

        // Cmd+Shift+T - Reopen the last closed tab
        if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
          e.preventDefault();
          tabs.reopenClosedTab();
          return;
        }

        // Cmd+T - Pick a note to open in a new tab
        if (mod && !e.shiftKey && e.key.toLowerCase() === "t") {
          e.preventDefault();
          openPaletteIn("search", true);
          return;
        }
      }

      // Cmd+Shift+Enter - Toggle focus mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Cmd+Shift+M - Toggle markdown source mode
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "m"
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-source-mode"));
        return;
      }

      // Escape exits focus mode when not in editor
      if (e.key === "Escape" && focusMode && !isInEditor) {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Let dialogs handle their own keyboard events (Tab, Enter, etc.)
      if (target.closest("[role='dialog'], [role='alertdialog']")) {
        return;
      }

      // Trap Tab/Shift+Tab in notes view only - prevent focus navigation
      // TipTap handles indentation internally before event bubbles up
      if (e.key === "Tab") {
        e.preventDefault();
        return;
      }

      // Cmd+Shift+P - Print
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("print-note"));
        return;
      }

      // Cmd+/ - Open keyboard shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Cmd/Ctrl+Shift+F - Open the command menu in Search Notes
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        openPaletteIn("search");
        return;
      }

      // Cmd+Shift+O - Recent Notes, on the previous note
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        openPaletteIn("recent");
        return;
      }

      // Cmd+[ / Cmd+] - Back / forward through opened notes
      if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        if (e.key === "[") navigation.goBack?.();
        else navigation.goForward?.();
        return;
      }

      // Cmd+Alt+Up - Go to the parent page
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        if (navigation.parentPageId) void selectNote(navigation.parentPageId);
        return;
      }

      // Cmd+Shift+N - New sub-page of the open note. Checked before Cmd+N,
      // which does not look at Shift.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        if (selectedNoteId) void createNoteInFolder(selectedNoteId);
        return;
      }

      // Cmd+\ - Toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd+N - New note
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        void createNote();
        return;
      }

      // Delete current note (note list focused, or editor on empty note)
      if (
        selectedNoteId &&
        !isInInput &&
        (e.key === "Delete" ||
          (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) &&
        (!isInEditor || isEditorEmpty)
      ) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("request-delete-note", { detail: selectedNoteId }),
        );
        return;
      }

      // Cmd+D - Duplicate current note
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "d" &&
        !isInEditor &&
        !isInInput &&
        selectedNoteId
      ) {
        e.preventDefault();
        void duplicateNote(selectedNoteId);
        return;
      }

      // Cmd+R - Reload current note (pull external changes)
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        void reloadCurrentNote();
        return;
      }

      // Arrow keys for note navigation, in the sidebar tree's order
      // Skip if folder tree view is handling its own navigation
      const isInFolderTree = !!target.closest("[data-folder-tree]");
      if (
        notes.length > 0 &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        ((!isInEditor && !isInInput) || isEditorEmpty) &&
        !isInFolderTree
      ) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("step-note-list", {
            detail: e.key === "ArrowDown" ? 1 : -1,
          }),
        );
        return;
      }

      // Enter to focus editor
      if (e.key === "Enter" && selectedNoteId && !isInEditor && !isInInput) {
        e.preventDefault();
        const editor = document.querySelector(".ProseMirror");
        if (editor instanceof HTMLElement) {
          editor.focus();
        }
        return;
      }

      // Escape to blur editor and go back to note list
      if (e.key === "Escape" && isInEditor) {
        e.preventDefault();
        if (target instanceof HTMLElement) target.blur();
        // Focus the note list for keyboard navigation
        window.dispatchEvent(new CustomEvent("focus-note-list"));
        return;
      }
    };

    // Disable right-click context menu except in editor
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Allow context menu in editor (prose class), inputs, and note list sidebar
      const isInEditor =
        target.closest(".prose") || target.closest(".ProseMirror");
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const isInNoteList = target.closest("[data-note-list]");
      if (!isInEditor && !isInput && !isInNoteList) {
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [
    createNote,
    createNoteInFolder,
    duplicateNote,
    navigation,
    notes,
    openPaletteIn,
    paletteOpen,
    tabs,
    reloadCurrentNote,
    selectedNoteId,
    selectNote,
    toggleSettings,
    toggleSidebar,
    toggleFocusMode,
    focusMode,
    view,
    setInterfaceZoom,
  ]);

  const handleClosePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteView(undefined);
    setPaletteNewTab(false);
    editorRef.current?.commands.focus();
  }, []);

  if (isLoading) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center bg-bg-secondary">
        <div className="text-text-muted/70 text-sm flex items-center gap-1.5 font-medium">
          <SpinnerIcon className="w-4.5 h-4.5 stroke-[1.5] animate-spin" />
          Initializing Aether...
        </div>
      </div>
    );
  }

  if (!notesFolder) {
    return <FolderPicker />;
  }

  return (
    <>
      <div className="h-full min-h-0 flex bg-bg text-text overflow-hidden">
        {view === "settings" ? (
          <SettingsPage onBack={closeSettings} />
        ) : (
          <>
            <div
              data-sidebar
              style={{
                width:
                  !sidebarVisible || focusMode
                    ? 0
                    : `var(--sidebar-width, ${SIDEBAR_DEFAULT_PX}px)`,
              }}
              className={`relative transition-all duration-500 ease-out overflow-hidden ${!sidebarVisible || focusMode ? "opacity-0 -translate-x-4 pointer-events-none" : "opacity-100 translate-x-0"}`}
            >
              <Sidebar onOpenSettings={toggleSettings} />
              {sidebarVisible && !focusMode && <SidebarResizeHandle />}
            </div>
            <Editor
              onToggleSidebar={toggleSidebar}
              sidebarVisible={sidebarVisible}
              focusMode={focusMode}
              onEditorReady={(editor) => {
                editorRef.current = editor;
              }}
            />
          </>
        )}
      </div>

      {/* Shared backdrop for command palette and AI modal */}
      {(paletteOpen || aiModalOpen) && (
        <div
          className="fixed inset-0 bg-text/50 backdrop-blur-sm z-40 animate-fade-in"
          aria-hidden="true"
          onClick={() => {
            if (paletteOpen) handleClosePalette();
            if (aiModalOpen) setAiModalOpen(false);
          }}
        />
      )}

      <MovePageDialog />
      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      <CommandPalette
        key={paletteKey}
        open={paletteOpen}
        initialView={paletteView}
        newTab={paletteNewTab}
        navigation={navigation}
        onClose={handleClosePalette}
        onOpenSettings={toggleSettings}
        onOpenNote={closeSettings}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenAiModal={(provider) => {
          setAiProvider(provider);
          setAiModalOpen(true);
        }}
        focusMode={focusMode}
        onToggleFocusMode={toggleFocusMode}
        editorRef={editorRef}
      />
      <AiEditModal
        open={aiModalOpen}
        provider={aiProvider}
        onBack={handleBackToPalette}
        onExecute={handleAiEdit}
        isExecuting={aiEditing}
      />

      {/* AI Editing Overlay */}
      {aiEditing && (
        <div className="fixed inset-0 bg-bg/50 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="flex items-center gap-2">
            {aiProvider === "codex" ? (
              <CodexIcon className="w-4.5 h-4.5 fill-text-muted animate-spin-slow" />
            ) : aiProvider === "opencode" ? (
              <OpenCodeIcon className="w-4.5 h-4.5 fill-text-muted animate-pulse-gentle" />
            ) : aiProvider === "ollama" ? (
              <OllamaIcon className="w-4.5 h-4.5 fill-text-muted animate-bounce-gentle" />
            ) : (
              <ClaudeIcon className="w-4.5 h-4.5 fill-text-muted animate-spin-slow" />
            )}
            <div className="text-sm font-medium text-text">
              {aiProvider === "codex"
                ? "Codex is editing your note..."
                : aiProvider === "opencode"
                  ? "OpenCode is editing your note..."
                  : aiProvider === "ollama"
                    ? "Ollama is editing your note..."
                    : "Claude is editing your note..."}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Shared update check — used by startup and manual "Check for Updates"
async function showUpdateToast(): Promise<"update" | "no-update" | "error"> {
  try {
    const update = await checkForUpdate();
    if (update) {
      toast(<UpdateToast update={update} toastId="update-toast" />, {
        id: "update-toast",
        duration: Infinity,
        closeButton: true,
      });
      return "update";
    }
    return "no-update";
  } catch (err) {
    // Network errors and 404s (no release published yet) are not real failures
    const msg = String(err);
    if (
      msg.includes("404") ||
      msg.includes("network") ||
      msg.includes("Could not fetch")
    ) {
      return "no-update";
    }
    console.error("Update check failed:", err);
    return "error";
  }
}

export { showUpdateToast };

function UpdateToast({
  update,
  toastId,
}: {
  update: Update;
  toastId: string | number;
}) {
  const [installing, setInstalling] = useState(false);

  const handleUpdate = async () => {
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      toast.dismiss(toastId);
      toast.success("Update installed! Restart Aether to apply.", {
        duration: Infinity,
        closeButton: true,
      });
    } catch (err) {
      console.error("Update failed:", err);
      toast.error("Update failed. Please try again later.");
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-sm">
        Update Available: v{update.version}
      </div>
      {update.body && (
        <div className="text-xs text-text-muted line-clamp-3">
          {update.body}
        </div>
      )}
      <button
        onClick={handleUpdate}
        disabled={installing}
        className="self-start mt-1 text-xs font-medium px-3 py-1.5 rounded-md bg-text text-bg hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {installing ? "Installing..." : "Update Now"}
      </button>
    </div>
  );
}

function App() {
  const { isPreview, previewFile } = useMemo(() => getWindowMode(), []);

  // Cmd/Ctrl+W closes the preview window. Folder mode closes tabs first.
  useEffect(() => {
    if (!isPreview) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        getCurrentWindow().close().catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreview]);

  // Add platform class for OS-specific styling (e.g., keyboard shortcuts)
  useEffect(() => {
    const os = isMac ? "mac" : isWindows ? "windows" : "linux";
    document.documentElement.classList.add(`platform-${os}`);
  }, []);

  // Check for app updates on startup (folder mode only)
  useEffect(() => {
    if (isPreview) return undefined;
    const timer = setTimeout(() => showUpdateToast(), 3000);
    return () => clearTimeout(timer);
  }, [isPreview]);

  // Preview mode: lightweight editor without sidebar, search, git
  if (isPreview && previewFile) {
    return (
      <ThemeProvider>
        <Toaster />
        <TooltipProvider>
          <PreviewApp filePath={decodeURIComponent(previewFile)} />
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  // Folder mode: full app with sidebar, search, git, etc.
  return (
    <ThemeProvider>
      <Toaster />
      <TooltipProvider>
        <NotesProvider>
          <GitProvider>
            <VaultProvider>
              <TabsProvider>
                <AppContent />
              </TabsProvider>
            </VaultProvider>
          </GitProvider>
        </NotesProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
