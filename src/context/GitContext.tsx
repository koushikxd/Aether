import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import * as gitService from "../services/git";
import * as notesService from "../services/notes";
import { errorMessage } from "../services/export";
import type { ConflictFile, GitStatus } from "../services/git";
import { MergeEditor, type ResolvedFile } from "../components/git/MergeEditor";
import { useNotesData } from "./NotesContext";

interface GitContextValue {
  // State
  status: GitStatus | null;
  isLoading: boolean;
  isCommitting: boolean;
  isPushing: boolean;
  isPulling: boolean;
  isSyncing: boolean;
  isAddingRemote: boolean;
  gitAvailable: boolean;
  gitEnabled: boolean;
  isUpdatingGitEnabled: boolean;
  lastError: string | null;

  // Actions
  setGitEnabled: (enabled: boolean) => Promise<boolean>;
  refreshStatus: () => Promise<void>;
  initRepo: () => Promise<boolean>;
  commit: (message: string) => Promise<boolean>;
  push: () => Promise<boolean>;
  pull: () => Promise<string | false>;
  sync: () => Promise<
    { ok: true; message: string } | { ok: false; error: string }
  >;
  addRemote: (url: string) => Promise<boolean>;
  setRemoteUrl: (url: string) => Promise<boolean>;
  removeRemote: () => Promise<boolean>;
  pushWithUpstream: () => Promise<boolean>;
  clearError: () => void;
}

const GitContext = createContext<GitContextValue | null>(null);

export function GitProvider({ children }: { children: ReactNode }) {
  const { notesFolder } = useNotesData();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isAddingRemote, setIsAddingRemote] = useState(false);
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitEnabled, setGitEnabledState] = useState(false);
  const [isUpdatingGitEnabled, setIsUpdatingGitEnabled] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // Files of an unfinished merge; the merge editor is open while non-empty
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);

  // Reset git visibility when the notes folder is cleared
  const [prevNotesFolder, setPrevNotesFolder] = useState(notesFolder);
  if (notesFolder !== prevNotesFolder) {
    setPrevNotesFolder(notesFolder);
    setConflicts([]);
    if (!notesFolder) {
      setGitEnabledState(false);
      setIsUpdatingGitEnabled(false);
    }
  }

  // Clear git-specific UI state when disabled
  const [prevGitEnabled, setPrevGitEnabled] = useState(gitEnabled);
  if (gitEnabled !== prevGitEnabled) {
    setPrevGitEnabled(gitEnabled);
    if (!gitEnabled) {
      setStatus(null);
      setIsLoading(false);
      setLastError(null);
    }
  }

  // Use refs to avoid dependency cycles
  const hasLoadedRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const settingsReadRequestIdRef = useRef(0);
  const gitToggleRequestIdRef = useRef(0);
  const notesFolderRef = useRef(notesFolder);
  const gitEnabledRef = useRef(gitEnabled);
  // Layout effect so async staleness checks see the new values as soon as they commit
  useLayoutEffect(() => {
    notesFolderRef.current = notesFolder;
    gitEnabledRef.current = gitEnabled;
  }, [notesFolder, gitEnabled]);

  const refreshStatus = useCallback(async () => {
    if (!notesFolder || !gitEnabled) return;

    // Prevent concurrent refreshes from piling up
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    const requestId = ++refreshRequestIdRef.current;
    const folderAtStart = notesFolder;
    const isStale = () =>
      requestId !== refreshRequestIdRef.current ||
      !gitEnabledRef.current ||
      notesFolderRef.current !== folderAtStart;

    // Only show loading spinner on the very first load
    const isInitialLoad = !hasLoadedRef.current;
    if (isInitialLoad) {
      setIsLoading(true);
    }

    try {
      const newStatus = await gitService.getGitStatus();

      if (isStale()) return;

      hasLoadedRef.current = true;
      setStatus(newStatus);
      if (newStatus.error) {
        setLastError(newStatus.error);
      }
    } catch (err) {
      if (isStale()) return;

      setLastError(
        err instanceof Error ? err.message : "Failed to get git status",
      );
    } finally {
      refreshInFlightRef.current = false;
      if (isInitialLoad) {
        setIsLoading(false);
      }
    }
  }, [notesFolder, gitEnabled]);

  const setGitEnabled = useCallback(
    async (enabled: boolean) => {
      if (!notesFolder) return false;
      if (enabled === gitEnabled) return true;

      const requestId = ++gitToggleRequestIdRef.current;
      settingsReadRequestIdRef.current += 1;
      const folderAtStart = notesFolder;
      const isStale = () =>
        requestId !== gitToggleRequestIdRef.current ||
        notesFolderRef.current !== folderAtStart;
      const previous = gitEnabled;
      setGitEnabledState(enabled);
      setIsUpdatingGitEnabled(true);

      try {
        if (isStale()) return true;

        await notesService.updateGitEnabled(enabled, folderAtStart);

        if (isStale()) return true;

        return true;
      } catch (err) {
        if (isStale()) return true;

        setGitEnabledState(previous);
        setLastError(
          err instanceof Error ? err.message : "Failed to update git setting",
        );
        return false;
      } finally {
        if (requestId === gitToggleRequestIdRef.current) {
          setIsUpdatingGitEnabled(false);
        }
      }
    },
    [notesFolder, gitEnabled],
  );

  const initRepo = useCallback(async () => {
    try {
      await gitService.initGitRepo();
      await refreshStatus();
      return true;
    } catch (err) {
      setLastError(
        err instanceof Error ? err.message : "Failed to initialize git",
      );
      return false;
    }
  }, [refreshStatus]);

  const commit = useCallback(
    async (message: string) => {
      setIsCommitting(true);
      try {
        const result = await gitService.gitCommit(message);
        if (result.error) {
          setLastError(result.error);
          return false;
        }
        await refreshStatus();
        return true;
      } catch (err) {
        setLastError(err instanceof Error ? err.message : "Failed to commit");
        return false;
      } finally {
        setIsCommitting(false);
      }
    },
    [refreshStatus],
  );

  const push = useCallback(async () => {
    setIsPushing(true);
    try {
      const result = await gitService.gitPush();
      if (result.error) {
        setLastError(result.error);
        return false;
      }
      await refreshStatus();
      return true;
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Failed to push");
      return false;
    } finally {
      setIsPushing(false);
    }
  }, [refreshStatus]);

  // A pull that conflicts fails and leaves the repo mid-merge
  const openConflicts = useCallback(async () => {
    const files = await gitService.getConflicts();
    setConflicts(files);
    return files.length > 0;
  }, []);

  const pushIfAhead = useCallback(async () => {
    const freshStatus = await gitService.getGitStatus();
    if (!(freshStatus.aheadCount > 0 && freshStatus.hasUpstream)) {
      return { pushed: false, error: null };
    }
    const result = await gitService.gitPush();
    if (result.error) setLastError(result.error);
    return { pushed: !result.error, error: result.error };
  }, []);

  const pull = useCallback(async (): Promise<string | false> => {
    setIsPulling(true);
    try {
      const result = await gitService.gitPull();
      if (result.error) {
        if (await openConflicts()) return "Resolve conflicts to finish pulling";
        setLastError(result.error);
        return false;
      }
      await refreshStatus();
      return result.message || "Pulled latest changes";
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Failed to pull");
      return false;
    } finally {
      setIsPulling(false);
    }
  }, [refreshStatus, openConflicts]);

  const sync = useCallback(async (): Promise<
    { ok: true; message: string } | { ok: false; error: string }
  > => {
    setIsSyncing(true);
    try {
      // Step 1: Pull from remote
      const pullResult = await gitService.gitPull();
      if (pullResult.error) {
        // The merge editor continues the sync once the merge is done
        if (await openConflicts()) {
          return { ok: true, message: "Resolve conflicts to finish syncing" };
        }
        setLastError(pullResult.error);
        return { ok: false, error: pullResult.error };
      }
      const didPull = pullResult.message !== "Already up to date";

      // Step 2: Push if ahead
      const { pushed: didPush, error: pushError } = await pushIfAhead();
      await refreshStatus();
      if (pushError) {
        if (didPull)
          return {
            ok: false,
            error: `Pulled changes, but push failed: ${pushError}`,
          };
        return { ok: false, error: pushError };
      }

      if (didPull && didPush)
        return { ok: true, message: "Synced — pulled and pushed" };
      if (didPull) return { ok: true, message: "Pulled latest changes" };
      if (didPush) return { ok: true, message: "Pushed to remote" };
      return { ok: true, message: "Already up to date" };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Failed to sync";
      setLastError(error);
      return { ok: false, error };
    } finally {
      setIsSyncing(false);
    }
  }, [refreshStatus, openConflicts, pushIfAhead]);

  const finishMerge = useCallback(
    async (resolved: ResolvedFile[]): Promise<string | null> => {
      try {
        // One at a time: each call stages into the same git index
        for (const { path, resolution } of resolved) {
          await gitService.resolveConflict(path, resolution);
        }
        const result = await gitService.finishMerge();
        if (result.error) return result.error;
      } catch (err) {
        return errorMessage(err, "Failed to finish the merge");
      }
      setConflicts([]);

      // Continue the sync that hit the conflicts
      setIsSyncing(true);
      try {
        const { pushed, error } = await pushIfAhead();
        await refreshStatus();
        if (error) toast.error(`Merged, but push failed: ${error}`);
        else toast.success(pushed ? "Merged and pushed" : "Merged");
      } catch (err) {
        toast.error(errorMessage(err, "Merged, but push failed"));
      } finally {
        setIsSyncing(false);
      }
      return null;
    },
    [pushIfAhead, refreshStatus],
  );

  const abortMerge = useCallback(async (): Promise<string | null> => {
    try {
      const result = await gitService.abortMerge();
      if (result.error) return result.error;
    } catch (err) {
      return errorMessage(err, "Failed to cancel the merge");
    }
    setConflicts([]);
    await refreshStatus();
    return null;
  }, [refreshStatus]);

  const addRemote = useCallback(
    async (url: string) => {
      setIsAddingRemote(true);
      try {
        const result = await gitService.addRemote(url);
        if (result.error) {
          setLastError(result.error);
          return false;
        }
        await refreshStatus();
        return true;
      } catch (err) {
        setLastError(
          err instanceof Error ? err.message : "Failed to add remote",
        );
        return false;
      } finally {
        setIsAddingRemote(false);
      }
    },
    [refreshStatus],
  );

  const setRemoteUrl = useCallback(
    async (url: string) => {
      setIsAddingRemote(true);
      try {
        const result = await gitService.setRemoteUrl(url);
        if (result.error) {
          setLastError(result.error);
          return false;
        }
        await refreshStatus();
        return true;
      } catch (err) {
        setLastError(
          err instanceof Error ? err.message : "Failed to update remote",
        );
        return false;
      } finally {
        setIsAddingRemote(false);
      }
    },
    [refreshStatus],
  );

  const removeRemote = useCallback(async () => {
    setIsAddingRemote(true);
    try {
      const result = await gitService.removeRemote();
      if (result.error) {
        setLastError(result.error);
        return false;
      }
      await refreshStatus();
      return true;
    } catch (err) {
      setLastError(
        err instanceof Error ? err.message : "Failed to remove remote",
      );
      return false;
    } finally {
      setIsAddingRemote(false);
    }
  }, [refreshStatus]);

  const pushWithUpstream = useCallback(async () => {
    setIsPushing(true);
    try {
      const result = await gitService.pushWithUpstream();
      if (result.error) {
        setLastError(result.error);
        return false;
      }
      await refreshStatus();
      return true;
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Failed to push");
      return false;
    } finally {
      setIsPushing(false);
    }
  }, [refreshStatus]);

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  // Check git availability on mount
  useEffect(() => {
    void gitService.isGitAvailable().then(setGitAvailable);
  }, []);

  // Load per-folder git visibility setting
  // If explicitly set in settings, use that. Otherwise auto-detect: enable if the folder is a git repo.
  useEffect(() => {
    if (!notesFolder) {
      settingsReadRequestIdRef.current += 1;
      return undefined;
    }

    let cancelled = false;
    const requestId = ++settingsReadRequestIdRef.current;

    void (async () => {
      try {
        const settings = await notesService.getSettings();
        if (cancelled || requestId !== settingsReadRequestIdRef.current) return;

        if (settings.gitEnabled === true || settings.gitEnabled === false) {
          setGitEnabledState(settings.gitEnabled);
          return;
        }

        // Not explicitly set — auto-detect by checking if folder is a git repo
        const gitStatus = await gitService.getGitStatus();
        if (cancelled || requestId !== settingsReadRequestIdRef.current) return;
        setGitEnabledState(gitStatus.isRepo);
      } catch {
        if (cancelled || requestId !== settingsReadRequestIdRef.current) return;
        setGitEnabledState(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [notesFolder]);

  // Invalidate in-flight refreshes when disabled (UI state is cleared during render above)
  useEffect(() => {
    if (gitEnabled) return;

    refreshRequestIdRef.current += 1;
    hasLoadedRef.current = false;
    refreshInFlightRef.current = false;
  }, [gitEnabled]);

  // Keep stable refs so listeners/timers don't need to re-register
  const refreshStatusRef = useRef(refreshStatus);
  const isSyncingRef = useRef(false);
  useLayoutEffect(() => {
    refreshStatusRef.current = refreshStatus;
    isSyncingRef.current = isSyncing;
  }, [refreshStatus, isSyncing]);

  // Refresh status when folder changes
  useEffect(() => {
    if (notesFolder && gitAvailable && gitEnabled) {
      // oxlint-disable-next-line react/set-state-in-effect -- refreshStatus syncs from git; its only sync setState is the first-load spinner
      void refreshStatus();
    }
  }, [notesFolder, gitAvailable, gitEnabled, refreshStatus]);

  // The repo can already be mid-merge when the folder opens
  useEffect(() => {
    if (!notesFolder || !gitAvailable || !gitEnabled || !status?.isRepo) {
      return undefined;
    }
    let cancelled = false;
    void gitService.getConflicts().then(
      (files) => {
        if (!cancelled) setConflicts(files);
      },
      (err: unknown) => {
        if (!cancelled) {
          setLastError(errorMessage(err, "Failed to read merge conflicts"));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [notesFolder, gitAvailable, gitEnabled, status?.isRepo]);

  // Poll remote for changes periodically (every 60s) when a remote is configured
  // Fetch is separated from status to keep status checks fast and offline-friendly
  // Uses recursive setTimeout to prevent overlapping runs on slow networks
  useEffect(() => {
    if (!notesFolder || !gitAvailable || !gitEnabled || !status?.hasRemote) {
      return undefined;
    }

    let cancelled = false;
    let timer: number;

    const poll = async () => {
      if (!isSyncingRef.current) {
        await gitService.gitFetch().catch(() => {});
        await refreshStatusRef.current();
      }
      if (!cancelled) {
        timer = window.setTimeout(poll, 60_000);
      }
    };

    timer = window.setTimeout(poll, 60_000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [notesFolder, gitAvailable, gitEnabled, status?.hasRemote]);

  // Refresh status on file changes (debounced via existing file watcher)
  // Uses a ref so the listener is registered only once
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let debounceTimer: number | undefined;

    void listen("file-change", () => {
      if (!gitEnabledRef.current) return;

      // Debounce git status refresh to avoid excessive calls
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        void refreshStatusRef.current();
      }, 1000);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const value = useMemo<GitContextValue>(
    () => ({
      status,
      isLoading,
      isCommitting,
      isPushing,
      isPulling,
      isSyncing,
      isAddingRemote,
      gitAvailable,
      gitEnabled,
      isUpdatingGitEnabled,
      lastError,
      setGitEnabled,
      refreshStatus,
      initRepo,
      commit,
      push,
      pull,
      sync,
      addRemote,
      setRemoteUrl,
      removeRemote,
      pushWithUpstream,
      clearError,
    }),
    [
      status,
      isLoading,
      isCommitting,
      isPushing,
      isPulling,
      isSyncing,
      isAddingRemote,
      gitAvailable,
      gitEnabled,
      isUpdatingGitEnabled,
      lastError,
      setGitEnabled,
      refreshStatus,
      initRepo,
      commit,
      push,
      pull,
      sync,
      addRemote,
      setRemoteUrl,
      removeRemote,
      pushWithUpstream,
      clearError,
    ],
  );

  return (
    <GitContext.Provider value={value}>
      {children}
      {conflicts.length > 0 && (
        <MergeEditor
          files={conflicts}
          onFinish={finishMerge}
          onCancel={abortMerge}
        />
      )}
    </GitContext.Provider>
  );
}

export function useGit() {
  const context = useContext(GitContext);
  if (!context) {
    throw new Error("useGit must be used within a GitProvider");
  }
  return context;
}
