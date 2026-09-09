import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { consumeLaunchPi, getLaunchDir } from "@/lib/launchDir";
import { native } from "@/lib/native";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { cn } from "@/lib/utils";
import { launchEffects, planLaunch, sidebarCollapsedAfter } from "@/app/startup";
import {
  type EditorPaneHandle,
  EditorStack,
  GitDiffStack,
  NewEditorDialog,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import {
  type GitHistorySearchHandle,
  GitHistoryStack,
} from "@/modules/git-history";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { MarkdownStack } from "@/modules/markdown";
import {
  AgentTranscriptStack,
  BoardTabStack,
  PiStack,
  RunGraphTabStack,
} from "@/modules/pi";
import {
  PI_OPEN_CWDS_EVENT,
  PI_OPEN_CWDS_QUERY_EVENT,
} from "@/modules/pi/lib/providers";
import { pickPiSessionFolder } from "@/modules/pi/lib/newSession";
import {
  chooseChatTab,
  INSERT_DRAFT_EVENT,
  SEND_TO_CHAT_EVENT,
  type InsertDraftDetail,
  type SendToChatDetail,
} from "@/modules/pi/lib/sendToChat";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setPiLauncherDir,
  setThemeId as persistThemeId,
} from "@/modules/settings/store";
import {
  type ShortcutHandlers,
  type ShortcutId,
  ShortcutsDialog,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import { SidebarRail, type SidebarViewId } from "@/modules/sidebar";
import { SourceControlPanel, useSourceControl } from "@/modules/source-control";
import { StatusBar } from "@/modules/statusbar";
import { MAX_PANES_PER_TAB, useTabs, useWorkspaceCwd } from "@/modules/tabs";
import { useUat } from "@/modules/uat/bootstrap";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafHasForegroundProcess,
  leafIds,
  respawnSession,
  type TerminalPaneHandle,
  TerminalStack,
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import {
  listCustomThemes,
  saveCustomTheme,
} from "@/modules/theme/customThemes";
import {
  isThemeFilePath,
  onThemeEdit,
  parseThemeFile,
  starterTheme,
  themeFilePath,
  writeThemeFile,
} from "@/modules/theme/themeFiles";
import {
  currentWorkspaceEnv,
  getWslHome,
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

/** True when the path stats as an existing directory (fs_stat errors when
 *  missing or inaccessible). */
async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await invoke<{ kind: string }>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    });
    return stat.kind === "dir";
  } catch {
    return false;
  }
}

/** True when the registry accepts (and records) the folder, the same
 *  authorization the open-folder flow grants on a pick. */
async function pathAuthorized(path: string): Promise<boolean> {
  try {
    await native.workspaceAuthorize(path);
    return true;
  } catch {
    return false;
  }
}

const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "terax.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "terax.sidebar.view";

function clampSidebarWidth(width: number): number {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readSidebarView(): SidebarViewId {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    if (stored === "explorer" || stored === "source-control") return stored;
  } catch {
    // ignore
  }
  return "explorer";
}

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newMarkdownTab,
    newPiTab,
    restoreProjectTabs,
    recoverDraft,
    returnToChat,
    openBoardTab,
    openRunGraphTab,
    openAgentTranscriptTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // UX-04 dock recovery: useTabs seeds a terminal tab from the launch
  // directory (the home directory on a no-argument launch) before any
  // project can be resolved. That shell stays hidden, and therefore never
  // spawns, until the startup decision says a terminal-first launch really
  // happened; a dock recovery closes it instead of showing it.
  const initialShellTabIdRef = useRef<number | null>(tabs[0]?.id ?? null);
  const [initialShellHidden, setInitialShellHidden] = useState(true);

  const visibleTabs = useMemo(() => {
    const shellId = initialShellTabIdRef.current;
    if (!initialShellHidden || shellId === null) return tabs;
    return tabs.filter((t) => t.id !== shellId);
  }, [tabs, initialShellHidden]);

  const activeTerminalTab = useMemo(() => {
    const t = visibleTabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [visibleTabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const [sidebarView, setSidebarViewState] =
    useState<SidebarViewId>(readSidebarView);
  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // storage may fail in private mode
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) {
      // Expand to the remembered width; the panel mounts collapsed, so
      // expand() would fall back to minSize instead of the saved width.
      p.resize(`${sidebarWidthRef.current}px`);
    } else {
      p.collapse();
    }
  }, []);
  const sidebarIsCollapsed = useCallback(() => {
    const p = sidebarRef.current;
    return !p || p.getSize().asPercentage <= 0;
  }, []);
  const collapseSidebar = useCallback(() => {
    sidebarRef.current?.collapse();
  }, []);
  // Design 3.1 startup transition: every new app process, chat launch and
  // reopened chat tab starts with the sidebar collapsed, before the first
  // content paint (the layout effect runs synchronously before it). The
  // saved width key only sizes the next expansion; no saved visibility flag
  // is read at startup or in the background, and switching between
  // still-open tabs keeps whatever visibility the user last chose.
  useLayoutEffect(() => {
    sidebarRef.current?.collapse();
  }, []);
  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, sidebarView],
  );
  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [persistSidebarView, sidebarView]);

  const [home, setHome] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  useUat(tabs, activeId, launchCwdResolved ? launchCwd : null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv) => {
      if (
        env.kind === workspaceEnv.kind &&
        (env.kind === "local" ||
          (workspaceEnv.kind === "wsl" && env.distro === workspaceEnv.distro))
      ) {
        return;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        window.alert(
          "Save or close unsaved editor tabs before switching workspace.",
        );
        return;
      }

      let nextHome: string | null = null;
      try {
        if (env.kind === "wsl") {
          nextHome = await getWslHome(env.distro);
        } else {
          nextHome = (await homeDir()).replace(/\\/g, "/");
        }
      } catch (e) {
        window.alert(String(e));
        return;
      }

      for (const id of liveLeavesRef.current) disposeSession(id);
      searchAddons.current.clear();
      terminalRefs.current.clear();
      editorRefs.current.clear();
      setActiveSearchAddon(null);
      setActiveEditorHandle(null);
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      setHome(nextHome);
      setLaunchCwd(nextHome);
      if (nextHome) {
        try {
          await native.workspaceAuthorize(nextHome);
        } catch {
          // Non-fatal — git panel will surface "not authorized" if needed.
        }
      }
      resetWorkspace(nextHome ?? undefined);
    },
    [workspaceEnv, setWorkspaceEnv, resetWorkspace],
  );
  // Every chat tab opens through here: tab creation is the sidebar's
  // collapse event, per the launch transition in design.md 3.1.
  const openChatTab = useCallback(
    (cwd?: string) => {
      const id = newPiTab(cwd);
      if (!sidebarCollapsedAfter("chat-open", sidebarIsCollapsed())) {
        collapseSidebar();
      }
      return id;
    },
    [newPiTab, sidebarIsCollapsed, collapseSidebar],
  );

  // UX-04 dock recovery: a launch with no project argument resolves the
  // recorded last project before any primary tab shows. When it exists and
  // is authorized, the chat tab opens on it and the pre-seeded home shell
  // is closed without ever being shown; when it is missing or unauthorized,
  // the folder picker stands with the missing path, still with no home
  // terminal behind it. An explicit --pi project wins exactly as before,
  // and a positional dir without --pi stays a plain terminal-first launch.
  const [startupPick, setStartupPick] = useState<{
    missingPath: string | null;
  } | null>(null);
  const [tabRecoveryError, setTabRecoveryError] = useState<{ cwd: string; message: string } | null>(null);
  const openProjectTabs = useCallback(async (cwd: string) => {
    try {
      await restoreProjectTabs(cwd);
      setTabRecoveryError(null);
    } catch (error) {
      setTabRecoveryError({ cwd, message: String(error) });
    }
  }, [restoreProjectTabs]);
  useEffect(() => {
    let alive = true;
    let decided = false;
    native
      .workspaceCurrentDir()
      .then(async (cwd) => {
        if (!alive) return;
        setLaunchCwd(cwd);
        const piFlag = await consumeLaunchPi();
        const explicitDir = await invoke<string | null>(
          "get_launch_dir_arg",
        ).catch(() => null);
        if (!alive) return;
        let lastProject: string | null = null;
        let lastProjectExists = false;
        let lastProjectAuthorized = false;
        if (!piFlag && !explicitDir) {
          const prefs = usePreferencesStore.getState();
          if (!prefs.hydrated) await prefs.init();
          if (!alive) return;
          lastProject = usePreferencesStore.getState().lastProject;
          lastProjectExists = lastProject
            ? await dirExists(lastProject)
            : false;
          lastProjectAuthorized =
            lastProjectExists && lastProject
              ? await pathAuthorized(lastProject)
              : false;
        }
        if (!alive) return;
        const plan = planLaunch({
          piFlag,
          explicitDir: explicitDir ?? null,
          fallbackDir: cwd,
          lastProject,
          lastProjectExists,
          lastProjectAuthorized,
        });
        decided = true;
        for (const effect of launchEffects(plan)) {
          switch (effect.kind) {
            case "open-chat":
              await openProjectTabs(effect.project);
              break;
            case "close-initial-shell": {
              const shellId = initialShellTabIdRef.current;
              if (shellId !== null) closeTab(shellId);
              break;
            }
            case "reveal-initial-shell":
              setInitialShellHidden(false);
              break;
            case "show-picker":
              setStartupPick({ missingPath: effect.missingPath });
              break;
          }
        }
      })
      .catch(() => setLaunchCwd(null))
      .finally(() => {
        setLaunchCwdResolved(true);
        // A failed decision must never leave the seeded shell invisible.
        if (!decided) setInitialShellHidden(false);
      });
    return () => {
      alive = false;
    };
  }, [openProjectTabs, closeTab]);

  // The picker side of dock recovery: the existing open-folder flow, whose
  // pick authorizes the folder the same way a --pi argument path is. The
  // chosen project replaces the still-hidden home shell rather than
  // stacking beside it.
  const pickStartupProject = useCallback(async () => {
    const picked = await pickPiSessionFolder();
    if (picked.status === "cancelled") return;
    if (picked.status === "unauthorized") {
      toast(picked.error);
      return;
    }
    setStartupPick(null);
    await openProjectTabs(picked.dir);
    setInitialShellHidden(false);
    const shellId = initialShellTabIdRef.current;
    if (shellId !== null) closeTab(shellId);
  }, [openProjectTabs, closeTab]);

  // The launcher passes --launcher-dir <checkout> next to --pi. An empty
  // launcherDir pref adopts the passed path (one log line); a stored value
  // wins, so a different passed path is logged and ignored.
  useEffect(() => {
    let alive = true;
    void invoke<string | null>("get_launch_launcher_dir")
      .then(async (dir) => {
        if (!alive || !dir) return;
        const prefs = usePreferencesStore.getState();
        if (!prefs.hydrated) await prefs.init();
        if (!alive) return;
        const current = usePreferencesStore.getState().piLauncherDir;
        if (!current.trim()) {
          await setPiLauncherDir(dir);
          console.log(`pi launcher dir set from --launcher-dir: ${dir}`);
        } else if (current !== dir) {
          console.log(
            `pi launcher dir pref ${current} overrides --launcher-dir ${dir}`,
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Mirror the open pi tabs' cwds (most recently active first) to the other
  // windows: the settings check panel reports the effective roles for the
  // project the active tab runs in. Tab state lives in this window only, so
  // a fresh settings window pulls the current list with the query event.
  const piCwdsOrderRef = useRef<string[]>([]);
  const piCwdsEmittedRef = useRef<string[]>([]);
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (active?.kind === "pi" && active.cwd) {
      const rest = piCwdsOrderRef.current.filter((c) => c !== active.cwd);
      piCwdsOrderRef.current = [active.cwd, ...rest];
    }
    const open = tabs.flatMap((t) =>
      t.kind === "pi" && t.cwd ? [t.cwd] : [],
    );
    const openSet = new Set(open);
    const ordered = [
      ...piCwdsOrderRef.current.filter((c) => openSet.has(c)),
      ...open.filter((c) => !piCwdsOrderRef.current.includes(c)),
    ];
    piCwdsOrderRef.current = ordered;
    const emitted = piCwdsEmittedRef.current;
    const changed =
      emitted.length !== ordered.length ||
      emitted.some((c, i) => c !== ordered[i]);
    if (changed) {
      piCwdsEmittedRef.current = ordered;
      void emit(PI_OPEN_CWDS_EVENT, { cwds: ordered }).catch(() => {});
    }
  }, [tabs, activeId]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen(PI_OPEN_CWDS_QUERY_EVENT, () => {
      if (!alive) return;
      void emit(PI_OPEN_CWDS_EVENT, {
        cwds: piCwdsOrderRef.current,
      }).catch(() => {});
    }).then((un) => {
      if (!alive) un();
      else unlisten = un;
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  // Hydrate the cross-window preference store (theme, editor, terminal prefs).
  const initPrefs = usePreferencesStore((s) => s.init);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  const activeTab = visibleTabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isEditorTab = activeTab?.kind === "editor";
  const isMarkdownTab = activeTab?.kind === "markdown";
  const isPiTab = activeTab?.kind === "pi";
  const isBoardTab = activeTab?.kind === "board";
  const isRunGraphTab = activeTab?.kind === "run-graph";
  const isAgentTranscriptTab = activeTab?.kind === "agent-transcript";
  const isGitDiffTab =
    activeTab?.kind === "git-diff" || activeTab?.kind === "git-commit-file";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source === "editor") return;
          const normalizedPath = event.payload.path.replace(/\\/g, "/");
          const currentTabs = tabsRef.current;
          for (const t of currentTabs) {
            if (t.kind !== "editor") continue;
            if (t.path.replace(/\\/g, "/") === normalizedPath) {
              editorRefs.current.get(t.id)?.reload();
            }
          }
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  // pi module bridge: a pane asks the shell to open a file (DOM CustomEvent,
  // same window). Always an editor tab — even markdown — never the read-only
  // markdown preview.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (typeof path !== "string" || path.length === 0) return;
      openFileTab(path, true);
    };
    window.addEventListener("pi:open-file", handler);
    return () => window.removeEventListener("pi:open-file", handler);
  }, [openFileTab]);

  // Send to chat (K8): a terminal block hands its quotation to the shell
  // through pi:send-to-chat; this picks the target chat tab (active pi tab,
  // else a pi tab on the terminal's cwd, else the first pi tab, else a fresh
  // pi session that is retried once mounted), switches to it and forwards
  // pi:insert-draft with the tab id. The composer appends to its draft and
  // never sends.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SendToChatDetail>).detail;
      if (!detail || typeof detail.text !== "string") return;
      if (typeof detail.source?.terminalId !== "number") return;
      const current = tabsRef.current;
      let termCwd: string | null | undefined = null;
      for (const t of current) {
        if (t.kind === "terminal" && hasLeaf(t.paneTree, detail.source.terminalId)) {
          termCwd =
            findLeafCwd(t.paneTree, detail.source.terminalId) ?? t.cwd ?? null;
          break;
        }
      }
      const targetId = chooseChatTab(current, activeId, termCwd);
      if (targetId === null) {
        const tabId = openChatTab(termCwd ?? undefined);
        const forward = (attempt: number) => {
          window.setTimeout(() => {
            const mounted = tabsRef.current.some(
              (t) => t.id === tabId && t.kind === "pi",
            );
            if (!mounted) {
              if (attempt < 5) forward(attempt + 1);
              return;
            }
            window.dispatchEvent(
              new CustomEvent<InsertDraftDetail>(INSERT_DRAFT_EVENT, {
                detail: { ...detail, tabId },
              }),
            );
          }, 80);
        };
        forward(0);
        return;
      }
      setActiveId(targetId);
      window.dispatchEvent(
        new CustomEvent<InsertDraftDetail>(INSERT_DRAFT_EVENT, {
          detail: { ...detail, tabId: targetId },
        }),
      );
    };
    window.addEventListener(SEND_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(SEND_TO_CHAT_EVENT, handler);
  }, [activeId, openChatTab, setActiveId]);

  // pi module bridge: run a command in a fresh terminal tab (Tauri event,
  // may originate from the backend or another window). Waits for the pty to
  // be ready, then writes the command into it.
  useEffect(() => {
    type OpenTerminalPayload = { cwd: string; command: string; hint?: string };
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<OpenTerminalPayload>("pi:open-terminal", (event) => {
      const { cwd, command, hint } = event.payload;
      if (
        typeof cwd !== "string" ||
        cwd.length === 0 ||
        typeof command !== "string" ||
        command.length === 0
      ) {
        return;
      }
      if (typeof hint === "string" && hint.length > 0) toast(hint);
      const tabId = newTab(cwd);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const leafId = tab.activeLeafId;
        void whenSessionReady(leafId).then(() => {
          writeToSession(leafId, `${command}\n`);
        });
      }, 0);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [newTab]);

  const editorWatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) if (t.kind === "editor") want.add(parentDir(t.path));
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
      for (const t of tabsRef.current) {
        if (t.kind !== "editor") continue;
        if (changed.has(t.path.replace(/\\/g, "/"))) {
          editorRefs.current.get(t.id)?.reload();
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Theme editing: a custom theme is materialized to a real file and edited in
  // the code editor. Saving it re-ingests into the runtime store + applies live.
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source !== "editor") return;
          if (!isThemeFilePath(event.payload.path)) return;
          void (async () => {
            try {
              const res = await invoke<{ kind: string; content?: string }>(
                "fs_read_file",
                { path: event.payload.path, workspace: currentWorkspaceEnv() },
              );
              if (res.kind !== "text" || typeof res.content !== "string")
                return;
              const parsed = parseThemeFile(res.content);
              if (!parsed.ok) {
                console.warn("[terax] theme not applied:", parsed.error);
                return;
              }
              await saveCustomTheme(parsed.theme);
            } catch (e) {
              console.warn("[terax] theme ingest failed:", e);
            }
          })();
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    void onThemeEdit(async (req) => {
      const theme =
        req.action === "create"
          ? starterTheme()
          : (await listCustomThemes()).find((t) => t.id === req.id);
      if (!theme) return;
      if (req.action === "create") await saveCustomTheme(theme);
      const path = await themeFilePath(theme.id);
      const open = tabsRef.current.some(
        (t) => t.kind === "editor" && t.path === path,
      );
      if (!open) await writeThemeFile(theme);
      void persistThemeId(theme.id);
      openFileTab(path);
      void getCurrentWebviewWindow().setFocus();
    }).then((fn) => {
      if (alive) unsub = fn;
      else fn();
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [openFileTab]);

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  );

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      closeTab(id);
    },
    [closeTab],
  );

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  const handleClose = useCallback(
    async (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      if (t?.kind === "terminal") {
        const leaves = leafIds(t.paneTree);
        const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
        if (checks.some(Boolean)) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIdx].id);
    },
    [tabs, activeId, setActiveId],
  );

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewPiTab = useCallback(() => {
    openChatTab(inheritedCwdForNewTab());
  }, [openChatTab, inheritedCwdForNewTab]);

  const openNewPiSession = useCallback(async () => {
    // Seed the picker from the active tab's cwd; only a picked folder opens a
    // session (the same newPiTab the --pi launch path uses). The pick also
    // authorizes the folder so the board's shell commands can run under it.
    const picked = await pickPiSessionFolder(
      activeTab && "cwd" in activeTab ? activeTab.cwd : inheritedCwdForNewTab(),
    );
    if (picked.status === "cancelled") return;
    if (picked.status === "unauthorized") {
      toast(picked.error);
      return;
    }
    openChatTab(picked.dir);
  }, [activeTab, inheritedCwdForNewTab, openChatTab]);

  const openChildTranscript = useCallback(
    (path: string) => {
      openAgentTranscriptTab(path);
    },
    [openAgentTranscriptTab],
  );

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Explorer defaults to preview (pin=false); explicit actions like
      // context-menu "Open" pass pin=true for a persistent tab.
      openFileTab(path, pin ?? false);
    },
    [openFileTab],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = (() => {
    if (activeTab?.kind === "terminal") {
      return activeTerminalLeafCwd ?? explorerRoot ?? workspaceFallbackPath;
    }
    if (activeTab?.kind === "editor") return dirname(activeTab.path);
    if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
    if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
    if (activeTab?.kind === "git-history") return activeTab.repoRoot;
    return explorerRoot ?? workspaceFallbackPath;
  })();
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some(
        (t) =>
          t.kind === "git-diff" ||
          t.kind === "git-history" ||
          t.kind === "git-commit-file",
      ),
    [tabs],
  );
  const sourceControlActive = hasOpenGitTab || sidebarView === "source-control";
  // Stable per-session path so switching tabs / cd-ing in a shell does NOT
  // re-fire git IPC for the badge. The active panel resolves the current
  // context path on its own when the user actually opens git.
  const badgeContextPath = workspaceFallbackPath;
  const sourceControlPath = sourceControlActive
    ? sourceControlContextPath
    : badgeContextPath;
  const sourceControl = useSourceControl(sourceControlPath, true);

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControl.status?.branch,
    sourceControlContextPath,
  ]);

  const openMarkdownPreview = useCallback(
    (path: string) => {
      newMarkdownTab(path);
    },
    [newMarkdownTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "tab.new": openNewTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newEditor": () => setNewEditorOpen(true),
      "pi.new": () => void openNewPiSession(),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => cycleTab(1),
      "tab.prev": () => cycleTab(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "search.focus": () => searchInlineRef.current?.focus(),
      "shortcuts.open": () => setShortcutsOpen((v) => !v),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
    }),
    [
      activeId,
      cycleTab,
      handleCloseTabOrPane,
      openNewPiSession,
      openNewTab,
      openNewPrivateTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      toggleSourceControl,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (id === "editor.undo" || id === "editor.redo") {
        return activeTab?.kind !== "editor";
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      return false;
    },
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(id, h);
      else editorRefs.current.delete(id);
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      const isLast =
        leafIds(tab.paneTree).length === 1 &&
        all.filter((t) => t.kind === "terminal").length === 1;
      if (isLast) {
        void respawnSession(leafId, tab.cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const workspaceSurface = (
    <div className="relative h-full min-h-0">
      {tabRecoveryError && (
        <div role="alert" className="absolute inset-x-3 top-2 z-50 rounded border border-destructive bg-background p-3 text-sm text-destructive">
          Draft recovery failed: {tabRecoveryError.message}
          <button type="button" className="ml-3 underline" onClick={() => void openProjectTabs(tabRecoveryError.cwd)}>
            Retry recovery
          </button>
        </div>
      )}
      {startupPick && (
        <div
          data-uat="startup-project-picker"
          role="status"
          className="absolute inset-0 z-10 grid place-items-center bg-background/80 p-4"
        >
          <div className="flex max-w-md flex-col gap-3 rounded-lg border border-border/60 bg-card p-4 text-sm shadow-md">
            <span className="font-medium">
              {startupPick.missingPath
                ? `Project not found: ${startupPick.missingPath}`
                : "No project to reopen"}
            </span>
            <span className="text-xs text-muted-foreground">
              Choose a folder to open a pi session in.
            </span>
            <button
              type="button"
              onClick={() => void pickStartupProject()}
              className="self-start rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
            >
              Choose folder
            </button>
          </div>
        </div>
      )}
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isTerminalTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerTerminalHandle}
          onSearchReady={handleSearchReady}
          onCwd={handleTerminalCwd}
          onExit={handleLeafExit}
          onFocusLeaf={handleFocusLeaf}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isEditorTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isEditorTab}
      >
        <EditorStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={handleEditorDirty}
          onCloseTab={disposeTab}
          onReturnToChat={returnToChat}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isMarkdownTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isPiTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isPiTab}
      >
        <PiStack
          tabs={tabs}
          activeId={activeId}
          onOpenChild={openChildTranscript}
          onOpenBoard={openBoardTab}
          onOpenRunGraph={openRunGraphTab}
          onRecoverDraft={recoverDraft}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isBoardTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isBoardTab}
      >
        <BoardTabStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isRunGraphTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isRunGraphTab}
      >
        <RunGraphTabStack
          tabs={tabs}
          activeId={activeId}
          onOpenChild={openChildTranscript}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isAgentTranscriptTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isAgentTranscriptTab}
      >
        <AgentTranscriptStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={openCommitFileDiffTab}
          onSearchHandle={setGitHistoryHandle}
        />
      </div>
    </div>
  );

  // The status bar breadcrumb reports the primary surface's directory. A
  // terminal tab follows its focused pane; a chat tab reports the project
  // path recorded on its tab (design.md 3.2 S1), never a bare "no directory"
  // while a project is open.
  const activeCwd =
    activeTerminalLeafCwd ??
    (activeTab?.kind === "pi" ? (activeTab.cwd ?? null) : null);

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              tabs={tabs}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={openNewTab}
              onNewPrivate={openNewPrivateTab}
              onNewEditor={() => setNewEditorOpen(true)}
              onNewPi={openNewPiTab}
              onNewPiSession={() => void openNewPiSession()}
              onNewGitGraph={openGitGraphFromContext}
              onClose={handleClose}
              onPin={pinTab}
              onRename={handleRenameTab}
              onToggleSidebar={toggleSidebar}
              onSplit={splitActivePaneInActiveTab}
              canSplit={
                activeTerminalTab !== null &&
                leafIds(activeTerminalTab.paneTree).length < MAX_PANES_PER_TAB
              }
              onOpenSettings={() => void openSettingsWindow()}
              searchTarget={searchTarget}
              searchRef={searchInlineRef}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={`${sidebarWidthRef.current}px`}
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                }}
              >
                <div
                  data-uat="sidebar"
                  className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card"
                >
                  <div className="min-h-0 flex-1">
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onOpenMarkdownPreview={openMarkdownPreview}
                      />
                    ) : (
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                      />
                    )}
                  </div>
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    changedCount={sourceControl.changedCount}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    {workspaceSurface}
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              onCd={sendCd}
              onWorkspaceChange={switchWorkspace}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
            />
          )}

          <Toaster position="bottom-right" />

          <ShortcutsDialog
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <AlertDialog
            open={pendingCloseTab !== null}
            onOpenChange={(open) => !open && cancelClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {tabs.find((t) => t.id === pendingCloseTab)?.title
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseTab)?.title
                      }" has unsaved changes. Close anyway?`
                    : "This file has unsaved changes. Close anyway?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingTerminalCloseTab !== null}
            onOpenChange={(open) => !open && setPendingTerminalCloseTab(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close Terminal?</AlertDialogTitle>
                <AlertDialogDescription>
                  A process is running. Closing this tab will terminate it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  onClick={() => setPendingTerminalCloseTab(null)}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (pendingTerminalCloseTab !== null)
                      disposeTab(pendingTerminalCloseTab);
                    setPendingTerminalCloseTab(null);
                  }}
                >
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingDeleteTabs !== null}
            onOpenChange={(open) => !open && cancelDeleteClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDeleteTabs?.length === 1
                    ? (() => {
                        const title = tabs.find(
                          (t) => t.id === pendingDeleteTabs[0],
                        )?.title;
                        return title
                          ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                          : "This file has unsaved changes. The file has been deleted. Close anyway?";
                      })()
                    : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelDeleteClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmDeleteClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return shell;
}
