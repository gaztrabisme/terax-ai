import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  findLeafCwd,
  hasLeaf,
  leafIds,
  nextLeafId,
  type PaneNode,
  removeLeaf,
  type SplitDir,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
} from "@/modules/terminal/lib/panes";
import { disposeSession } from "@/modules/terminal/lib/useTerminalSession";
import { loadWindowState, recordWindowTabs } from "@/modules/state/uiState";
import { loadDraftRecord } from "@/modules/pi/lib/drafts";
import { mintSid, registerStableId } from "./sid";

// Matches the renderer slot pool size — over this we'd evict an active leaf.
export const MAX_PANES_PER_TAB = 4;

/**
 * Stable opaque id (K11c) minted at creation and kept beside the numeric id.
 * Names the tab in `.pi/ui-state.json` and in `.pi/drafts/` filenames.
 */
export type TerminalTab = {
  id: number;
  sid?: string;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
  /** User-set label that overrides the cwd-derived name. Survives cd. */
  customTitle?: string;
};

export type EditorTab = {
  id: number;
  sid?: string;
  kind: "editor";
  title: string;
  path: string;
  cwd?: string;
  dirty: boolean;
  /**
   * True while the tab is in the transient "preview" state — opened by a
   * single-click in the explorer and not yet pinned by the user. A preview tab
   * is replaced by the next single-click rather than accumulating.
   */
  preview: boolean;
};

export type MarkdownTab = {
  id: number;
  sid?: string;
  kind: "markdown";
  title: string;
  path: string;
};

export type PiTab = {
  id: number;
  sid?: string;
  kind: "pi";
  title: string;
  cwd?: string;
  sessionId?: string;
};

/** Full-window kanban for a project's board. One per cwd. */
export type BoardTab = {
  id: number;
  sid?: string;
  kind: "board";
  title: string;
  cwd: string;
};

/** Full-window run graph for a pi session. One per cwd. */
export type RunGraphTab = {
  id: number;
  sid?: string;
  kind: "run-graph";
  title: string;
  cwd?: string;
  /** The pi tab whose session this run graph renders. */
  piTabId: number;
};

export type AgentTranscriptTab = {
  id: number;
  sid?: string;
  kind: "agent-transcript";
  title: string;
  path: string;
};

export type GitDiffTab = {
  id: number;
  sid?: string;
  kind: "git-diff";
  title: string;
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath: string | null;
};

export type GitHistoryTab = {
  id: number;
  sid?: string;
  kind: "git-history";
  title: string;
  repoRoot: string;
};

export type GitCommitFileDiffTab = {
  id: number;
  sid?: string;
  kind: "git-commit-file";
  title: string;
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | MarkdownTab
  | PiTab
  | BoardTab
  | RunGraphTab
  | AgentTranscriptTab
  | GitDiffTab
  | GitHistoryTab
  | GitCommitFileDiffTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  /** Empty string resets a terminal tab to its cwd-derived name. */
  customTitle: string;
}>;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function useTabs(initial?: Partial<TerminalTab>) {
  const [tabs, setTabsState] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    const sid = mintSid();
    registerStableId(tabId, sid);
    return [
      {
        id: tabId,
        sid,
        kind: "terminal",
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveId] = useState(1);
  const nextIdRef = useRef(3);
  const tabsRef = useRef(tabs);

  const setTabs = useCallback((update: Tab[] | ((current: Tab[]) => Tab[])) => {
    const next = typeof update === "function" ? update(tabsRef.current) : update;
    tabsRef.current = next;
    setTabsState(next);
  }, []);

  const newTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    const sid = mintSid();
    registerStableId(tabId, sid);
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        sid,
        kind: "terminal",
        title: "shell",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  const newPrivateTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    const sid = mintSid();
    registerStableId(tabId, sid);
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        sid,
        kind: "terminal",
        title: "private",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
        private: true,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  /**
   * Opens a file in an editor tab.
   *
   * - `pin = true` (default) — opens or activates a **persistent** tab.
   *   If the path is currently in the preview slot it is promoted in-place.
   *   Use this for programmatic opens (AI diff, New File dialog, etc.).
   * - `pin = false` — VSCode-style **preview** tab. A single shared slot is
   *   reused: if a persistent tab for the path already exists it is activated;
   *   otherwise the current preview slot is replaced with the new path.
   */
  const openFileTab = useCallback((path: string, pin = true) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const project = curr.find((tab) =>
        (tab.kind === "pi" || tab.kind === "board" || tab.kind === "run-graph") && tab.cwd,
      );
      const cwd = project && "cwd" in project ? project.cwd : undefined;
      if (pin) {
        // Persistent open: find any existing editor tab, pin it if needed.
        const existing = curr.find(
          (t) => t.kind === "editor" && t.path === path,
        );
        if (existing) {
          targetId = existing.id;
          if ((existing as EditorTab).preview) {
            return curr.map((t) =>
              t.id === existing.id ? { ...t, preview: false } : t,
            );
          }
          return curr;
        }
        const id = nextIdRef.current++;
        const sid = mintSid();
        registerStableId(id, sid);
        targetId = id;
        return [
          ...curr,
          {
            id,
            sid,
            kind: "editor",
            title: basename(path),
            path,
            cwd,
            dirty: false,
            preview: false,
          } satisfies EditorTab,
        ];
      } else {
        // Preview open: persistent tab for this path takes priority.
        const persistent = curr.find(
          (t) =>
            t.kind === "editor" && t.path === path && !(t as EditorTab).preview,
        );
        if (persistent) {
          targetId = persistent.id;
          return curr;
        }
        // Reuse the slot if it already shows the same path.
        const existingPreview = curr.find(
          (t) =>
            t.kind === "editor" && t.path === path && (t as EditorTab).preview,
        );
        if (existingPreview) {
          targetId = existingPreview.id;
          return curr;
        }
        // Replace the current preview slot, or append a new one.
        const previewIdx = curr.findIndex(
          (t) => t.kind === "editor" && (t as EditorTab).preview,
        );
        const id = nextIdRef.current++;
        const sid = mintSid();
        registerStableId(id, sid);
        targetId = id;
        const tab: EditorTab = {
          id,
          sid,
          kind: "editor",
          title: basename(path),
          path,
          cwd,
          dirty: false,
          preview: true,
        };
        if (previewIdx === -1) return [...curr, tab];
        const next = [...curr];
        next[previewIdx] = tab;
        return next;
      }
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId as number | null;
  }, []);

  /**
   * Promotes a preview tab to a persistent one. Called on double-click of the
   * tab title in the tab bar. Dirty edits also auto-promote (see `updateTab`).
   */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "editor" ? { ...t, preview: false } : t,
      ),
    );
  }, []);

  const newMarkdownTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find(
        (t) => t.kind === "markdown" && t.path === path,
      );
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      const sid = mintSid();
      registerStableId(id, sid);
      targetId = id;
      return [
        ...curr,
        { id, sid, kind: "markdown", title: basename(path), path },
      ];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const openAgentTranscriptTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find(
        (t) => t.kind === "agent-transcript" && t.path === path,
      );
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      const sid = mintSid();
      registerStableId(id, sid);
      targetId = id;
      return [
        ...curr,
        { id, sid, kind: "agent-transcript", title: basename(path), path },
      ];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newPiTab = useCallback((cwd?: string) => {
    const id = nextIdRef.current++;
    const sid = mintSid();
    registerStableId(id, sid);
    setTabs((t) => [...t, { id, sid, kind: "pi", title: "pi", cwd }]);
    setActiveId(id);
    return id;
  }, []);

  const projectRestores = useRef(new Map<string, Promise<void>>());
  const restoreProjectTabs = useCallback((cwd: string): Promise<void> => {
    const pending = projectRestores.current.get(cwd);
    if (pending) return pending;
    const restore = (async () => {
      const windowState = await loadWindowState(cwd);
      const records = (windowState?.tabs ?? []).filter((tab) =>
        (tab.kind === "pi" || tab.kind === "editor") && (!tab.cwd || tab.cwd === cwd),
      );
      const sids = new Set<string>();
      for (const tab of records) {
        if (!/^[a-zA-Z0-9_-]+$/.test(tab.id) || sids.has(tab.id) || (tab.kind === "editor" && !tab.path)) {
          throw new Error(`Tab recovery failed for ${tab.path ?? tab.id} in ${cwd}/.pi/ui-state.json`);
        }
        sids.add(tab.id);
      }
      const restored: Tab[] = records
        .filter((tab) => !tabsRef.current.some((open) => open.sid === tab.id))
        .map((tab): Tab => {
          const id = nextIdRef.current++;
          registerStableId(id, tab.id);
          return tab.kind === "pi"
            ? { id, sid: tab.id, kind: "pi", title: "pi", cwd, sessionId: tab.sessionId }
            : { id, sid: tab.id, kind: "editor", title: basename(tab.path!), path: tab.path!, cwd, dirty: false, preview: false };
        });
      const next = [...tabsRef.current, ...restored];
      let chat = next.find((tab) => tab.kind === "pi" && tab.cwd === cwd && tab.sid === windowState?.activeTabId)
        ?? next.find((tab) => tab.kind === "pi" && tab.cwd === cwd);
      if (!chat) {
        const id = nextIdRef.current++;
        const sid = mintSid();
        registerStableId(id, sid);
        chat = { id, sid, kind: "pi", title: "pi", cwd };
        next.push(chat);
      }
      tabsRef.current = next;
      setTabs(next);
      setActiveId(chat.id);
    })().catch((error) => {
      projectRestores.current.delete(cwd);
      throw error;
    });
    projectRestores.current.set(cwd, restore);
    return restore;
  }, []);

  const recoverDraft = useCallback(async (cwd: string, sid: string): Promise<void> => {
    const record = await loadDraftRecord(cwd, sid);
    if (!record) throw new Error(`${cwd}/.pi/drafts/${sid}.md: Draft is missing`);
    const existing = tabsRef.current.find((tab) => tab.sid === sid);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = nextIdRef.current++;
    registerStableId(id, sid);
    const tab: Tab = record.kind === "chat"
      ? { id, sid, kind: "pi", title: "pi", cwd }
      : { id, sid, kind: "editor", title: basename(record.meta.path), path: record.meta.path, cwd, dirty: false, preview: false };
    const next = [...tabsRef.current, tab];
    tabsRef.current = next;
    setTabs(next);
    setActiveId(id);
  }, []);

  const returnToChat = useCallback((cwd?: string) => {
    const chat = tabsRef.current.find((tab) => tab.kind === "pi" && (!cwd || tab.cwd === cwd));
    if (chat) setActiveId(chat.id);
    else newPiTab(cwd);
  }, [newPiTab]);

  /** Open (or reuse + activate) the project's board tab. One per cwd. */
  const openBoardTab = useCallback((cwd: string) => {
    const curr = tabsRef.current;
    const existing = curr.find((t) => t.kind === "board" && t.cwd === cwd);
    if (existing) {
      setActiveId(existing.id);
      return existing.id;
    }
    const id = nextIdRef.current++;
    const sid = mintSid();
    registerStableId(id, sid);
    const nextTabs = [
      ...curr,
      { id, sid, kind: "board", title: "Board", cwd } satisfies BoardTab,
    ];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveId(id);
    return id;
  }, []);

  /**
   * Open (or reuse + activate) the run-graph tab for a cwd. One per cwd;
   * re-point it at the requesting pi session when it changes.
   */
  const openRunGraphTab = useCallback(
    (cwd: string | undefined, piTabId: number) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t): t is RunGraphTab => t.kind === "run-graph" && t.cwd === cwd,
      );
      if (existing) {
        const nextTabs =
          existing.piTabId === piTabId
            ? curr
            : curr.map((t) => (t.id === existing.id ? { ...t, piTabId } : t));
        tabsRef.current = nextTabs;
        if (nextTabs !== curr) setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const sid = mintSid();
      registerStableId(id, sid);
      const nextTabs = [
        ...curr,
        {
          id,
          sid,
          kind: "run-graph",
          title: "Run graph",
          cwd,
          piTabId,
        } satisfies RunGraphTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openGitDiffTab = useCallback(
    (input: {
      path: string;
      repoRoot: string;
      mode: "-" | "+";
      originalPath?: string | null;
      title?: string;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-diff" &&
          t.repoRoot === input.repoRoot &&
          t.path === input.path &&
          t.mode === input.mode,
      );
      const computedTitle =
        input.title ?? `${basename(input.path)} (${input.mode})`;
      const originalPath = input.originalPath ?? null;

      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? { ...t, title: computedTitle, originalPath }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }

      const id = nextIdRef.current++;
      const sid = mintSid();
      registerStableId(id, sid);
      const nextTabs = [
        ...curr,
        {
          id,
          sid,
          kind: "git-diff",
          title: computedTitle,
          path: input.path,
          repoRoot: input.repoRoot,
          mode: input.mode,
          originalPath,
        } satisfies GitDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) => t.kind === "git-history" && t.repoRoot === input.repoRoot,
      );
      const title = input.branch ? `History · ${input.branch}` : "Git History";
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id ? { ...t, title } : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const sid = mintSid();
      registerStableId(id, sid);
      const nextTabs = [
        ...curr,
        {
          id,
          sid,
          kind: "git-history",
          title,
          repoRoot: input.repoRoot,
        } satisfies GitHistoryTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-commit-file" &&
          t.repoRoot === input.repoRoot &&
          t.sha === input.sha &&
          t.path === input.path,
      );
      const title = `${basename(input.path)} @ ${input.shortSha}`;
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                title,
                subject: input.subject,
                originalPath: input.originalPath,
              }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const sid = mintSid();
      registerStableId(id, sid);
      const nextTabs = [
        ...curr,
        {
          id,
          sid,
          kind: "git-commit-file",
          title,
          repoRoot: input.repoRoot,
          sha: input.sha,
          shortSha: input.shortSha,
          subject: input.subject,
          path: input.path,
          originalPath: input.originalPath,
        } satisfies GitCommitFileDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTab = useCallback((id: number) => {
    let toDispose: number[] = [];
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const target = curr[idx];
      if (target && target.kind === "terminal") {
        toDispose = leafIds(target.paneTree);
      }
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) =>
        id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  const updateTab = useCallback((id: number, patch: TabPatch) => {
    setTabs((t) =>
      t.map((x) => {
        if (x.id !== id) return x;
        if (x.kind === "terminal") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.cwd !== undefined && { cwd: patch.cwd }),
            ...(patch.customTitle !== undefined && {
              customTitle:
                patch.customTitle === "" ? undefined : patch.customTitle,
            }),
          };
        }
        if (x.kind === "markdown") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
          };
        }
        // editor tab: auto-promote from preview the moment the file becomes dirty.
        const autoPin =
          patch.dirty === true && (x as EditorTab).preview
            ? { preview: false }
            : {};
        return {
          ...x,
          ...autoPin,
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.dirty !== undefined && { dirty: patch.dirty }),
          ...(patch.path !== undefined && { path: patch.path }),
        };
      }),
    );
  }, []);

  const selectByIndex = useCallback(
    (idx: number) => {
      const t = tabs[idx];
      if (t) setActiveId(t.id);
    },
    [tabs],
  );

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active.
   * Bails out without setTabs when nothing actually changed — shell integration
   * re-emits OSC 7 on every prompt, including empty Enters, so this fires at
   * keystroke rate. Always-setTabs there cascades a paneTree re-render across
   * every open tab. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        const isActive = t.activeLeafId === leafId;
        const cwdChanged = isActive && t.cwd !== cwd;
        if (paneTree === t.paneTree && !cwdChanged) return t;
        changed = true;
        return { ...t, paneTree, ...(cwdChanged && { cwd }) };
      });
      return changed ? next : curr;
    });
  }, []);

  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        if (t.activeLeafId === leafId) return t;
        const cwd = findLeafCwd(t.paneTree, leafId);
        return {
          ...t,
          activeLeafId: leafId,
          ...(cwd !== undefined && { cwd }),
        };
      }),
    );
  }, []);

  const focusNextPaneInTab = useCallback((tabId: number, delta: 1 | -1) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
        if (next === t.activeLeafId) return t;
        const cwd = findLeafCwd(t.paneTree, next);
        return { ...t, activeLeafId: next, ...(cwd !== undefined && { cwd }) };
      }),
    );
  }, []);

  /** Split the active leaf of `tabId` along `dir`. Returns the new leaf id. */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            t.cwd,
          );
          return { ...t, paneTree, activeLeafId: leafId };
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    let didRemove = false;
    setTabs((curr) => {
      const tab = curr.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tab.id);
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) =>
          active === tab.id ? next[Math.max(0, idx - 1)].id : active,
        );
        didRemove = true;
        return next;
      }
      const remaining = leafIds(newTree);
      let newActive = tab.activeLeafId;
      if (tab.activeLeafId === leafId) {
        const sib = siblingLeafOf(tab.paneTree, leafId);
        newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      didRemove = true;
      return curr.map((x) =>
        x.id === tab.id
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (didRemove) disposeSession(leafId);
  }, []);

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    let removedLeaf: number | null = null;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (!t || t.kind !== "terminal") return curr;
      const target = t.activeLeafId;
      const newTree = removeLeaf(t.paneTree, target);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tabId);
        const next = curr.filter((x) => x.id !== tabId);
        setActiveId((active) =>
          active === tabId ? next[Math.max(0, idx - 1)].id : active,
        );
        closedTab = true;
        removedLeaf = target;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      removedLeaf = target;
      return curr.map((x) =>
        x.id === tabId
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (removedLeaf !== null) disposeSession(removedLeaf);
    return closedTab;
  }, []);

  // Mirror the open tabs after loading the project's saved window. The project is
  // the first project-scoped cwd in tab order: pi, board and run-graph tabs
  // carry it, while a terminal's cwd is a shell location, not the project.
  const projectCwd = useMemo(() => {
    for (const t of tabs) {
      if (t.kind === "pi" || t.kind === "board" || t.kind === "run-graph") {
        if (typeof t.cwd === "string" && t.cwd.length > 0) return t.cwd;
      }
    }
    return null;
  }, [tabs]);

  useEffect(() => {
    if (!projectCwd) return;
    const activeSid =
      tabs.find((t) => t.id === activeId)?.sid ?? tabs[0]?.sid;
    if (!activeSid) return;
    let alive = true;
    void loadWindowState(projectCwd).then(() => {
      if (!alive) return;
      recordWindowTabs(
        projectCwd,
        tabs.map((t) => ({
          id: t.sid ?? String(t.id),
          kind: t.kind,
          ...(t.kind === "pi" && t.sessionId && { sessionId: t.sessionId }),
          ...("cwd" in t && t.cwd !== undefined && { cwd: t.cwd }),
          ...(t.kind !== "terminal" &&
            t.kind !== "board" &&
            "path" in t && { path: t.path }),
        })),
        activeSid,
      );
    }).catch(() => {
      // The state store keeps its path-bearing error visible in the shell.
    });
    return () => {
      alive = false;
    };
  }, [tabs, activeId, projectCwd]);

  const resetWorkspace = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    const sid = mintSid();
    registerStableId(tabId, sid);
    let toDispose: number[] = [];
    setTabs((curr) => {
      toDispose = curr.flatMap((t) =>
        t.kind === "terminal" ? leafIds(t.paneTree) : [],
      );
      return [
        {
          id: tabId,
          sid,
          kind: "terminal",
          title: "shell",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ];
    });
    setActiveId(tabId);
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  return {
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
  };
}
