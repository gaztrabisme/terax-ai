import { recordProjectOpen } from "@/modules/settings/store";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { ArtifactPane } from "./components/ArtifactPane";
import { BoardView } from "./components/BoardPane";
import { ChatPane } from "./components/ChatPane";
import { ChatView } from "./components/ChatView";
import { ModeStrip } from "./components/ModeStrip";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import {
  isTerminalTarget,
  isModalTarget,
} from "@/modules/shortcuts/lib/eventPriority";
import { awaitingDecisionCount, useBoardData } from "./lib/useBoardData";
import {
  CHAT_VIEWS,
  CLOSED_VIEW,
  MODE_STRIP_WIDTH,
  isNarrowContent,
  panelWidth,
  viewReducer,
  type ChatView as View,
  type ViewEvent,
} from "./lib/viewMachine";
import { RunGraph } from "./components/RunGraph";
import { SessionSearch, scrollToSnippet } from "./components/SessionSearch";
import { viewButtonClass } from "./components/ModeStrip";
import { useChildStore, watchChildTranscripts } from "./lib/childStore";
import { ledgerPath } from "./lib/ledgerStore";
import { activatePiTab, CHILD_NAVIGATION_EVENT, SHOW_USAGE_EVENT, type ChildNavigation } from "./lib/childNavigation";
import { TicketSheet } from "./components/board/TicketSheet";
import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  artifactFileKey,
  artifactIdFor,
  artifactMime,
  detectArtifacts,
  type ArtifactDoc,
  type ArtifactFileRef,
} from "./lib/artifacts";
import { sha256Hex } from "./lib/drafts";
import {
  recordChatView,
  uiStatePath,
  useUiStateStore,
  type UiChatViewRecord,
} from "@/modules/state/uiState";
import type { DraftRecoveryProps } from "@/modules/tabs/RecoverableDrafts";
import { usePiLayout } from "./lib/layoutStore";
import { messageBlocks } from "./lib/parse";
import { usePiStore } from "./lib/piStore";
import { PI_MODULE_PREFS_DEFAULTS } from "./lib/settingsSchema";
import { groupTurns } from "./lib/turns";

type StackProps = DraftRecoveryProps & {
  tabs: Tab[];
  activeId: number;
  onOpenChild: (path: string) => void;
  /**
   * Accepted for call compatibility but unused: board and run graph open as
   * primary-surface tabs from the tab menu only (design.md section 3.1), so
   * the panels carry no Open in tab route (UX-12).
   */
  onOpenBoard?: (cwd: string) => void;
  onOpenRunGraph?: (cwd: string | undefined, piTabId: number) => void;
};

// Keep-alive slot: every pi tab stays mounted while hidden so the RPC
// stream keeps filling the store when the user is on another tab.
export function PiStack({
  tabs,
  activeId,
  onOpenChild,
  onRecoverDraft,
}: StackProps) {
  const pis = tabs.filter((t): t is PiTabData => t.kind === "pi");
  if (pis.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {pis.map((t) => (
        <div
          key={t.id}
          aria-hidden={t.id !== activeId}
          inert={t.id !== activeId}
          className={cn(
            "absolute inset-0",
            t.id !== activeId && "invisible pointer-events-none",
          )}
        >
          <PiTab
            tabId={t.id}
            sid={t.sid}
            cwd={t.cwd}
            active={t.id === activeId}
            openDraftIds={tabs.flatMap((tab) => tab.sid ? [tab.sid] : [])}
            onRecoverDraft={onRecoverDraft}
            onOpenChild={onOpenChild}
          />
        </div>
      ))}
    </div>
  );
}

export function PiTab({
  tabId,
  sid,
  cwd,
  active,
  onOpenChild,
  openDraftIds,
  onRecoverDraft,
  launcherDir = PI_MODULE_PREFS_DEFAULTS.launcherDir,
}: DraftRecoveryProps & {
  tabId: number;
  /** Stable tab id; the restore record is keyed by it. */
  sid?: string;
  cwd?: string;
  /** Whether this tab is the visible one; only it mounts the run graph. */
  active: boolean;
  onOpenChild: (path: string) => void;
  launcherDir?: string;
}) {
  /** Stable restore key: the recorded sid, else the numeric tab id. */
  const tabKey = sid ?? String(tabId);
  const entry = usePiStore((s) => s.tabs[tabId]);
  const openSession = usePiStore((s) => s.openSession);
  const [boardTick, setBoardTick] = useState(0);
  const seenBoardTools = useRef(new Set<string>());
  const boardData = useBoardData({
    cwd,
    refreshKey: boardTick,
    enabled: active,
  });
  const runningChildren = useChildStore(
    (s) =>
      Object.values(s.children).filter((child) =>
        ["thinking", "tool", "awaiting-ask"].includes(child.status),
      ).length,
  );
  const { layout, update } = usePiLayout(cwd);
  // K11b: the ui-state file is the persistence owner; a failed write stands
  // until Retry flushes it (no saved state while the banner shows).
  const storageError = useUiStateStore((s) => s.error);
  const retryStorage = useUiStateStore((s) => s.retry);
  // F9 restore offer: recorded view of this tab plus how the previous
  // process exited. The offer consults cleanAtLoad (what the file said at
  // load), not the live doc, which runs interrupted until the quit path.
  const uiDoc = useUiStateStore((s) => (cwd ? s.docs[cwd] : undefined));
  const cleanExitAtLoad = useUiStateStore((s) =>
    cwd ? (s.cleanAtLoad[cwd] ?? false) : false,
  );
  const recordedView: UiChatViewRecord | null =
    cwd && uiDoc ? (uiDoc.chatViews[tabKey] ?? null) : null;
  const [offerDismissed, setOfferDismissed] = useState(false);
  const [pendingRestore, setPendingRestore] =
    useState<UiChatViewRecord | null>(null);
  const [viewState, dispatch] = useReducer(viewReducer, CLOSED_VIEW);
  const layoutOffer = Boolean(
    cwd &&
      uiDoc &&
      recordedView &&
      (CHAT_VIEWS as readonly string[]).includes(recordedView.view) &&
      !offerDismissed &&
      !viewState.view &&
      !cleanExitAtLoad,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  const buttons = useRef<Partial<Record<View, HTMLButtonElement>>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const focusAfterTransition = useRef<"view" | View | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const narrow = contentWidth !== null && isNarrowContent(contentWidth);
  const [artifactSel, setArtifactSel] = useState<{
    turn: number;
    n: number;
  } | null>(null);
  const [childTicketId, setChildTicketId] = useState<string | null>(null);

  const transition = (event: ViewEvent) => {
    const next = viewReducer(viewState, event);
    if (next === viewState) return;
    focusAfterTransition.current = next.view ? "view" : viewState.view;
    dispatch(event);
  };
  const toggle = (view: View) => transition({ type: "toggle", view, narrow });

  // F9: restore the recorded view at its recorded mode (width comes from the
  // view's saved width); "open" then a fullscreen step when it ran one.
  const restoreLayout = () => {
    if (!cwd || !recordedView) return;
    setOfferDismissed(true);
    setPendingRestore(recordedView);
    transition({ type: "open", view: recordedView.view as View, narrow });
  };
  useEffect(() => {
    if (!pendingRestore) return;
    if (viewState.view === pendingRestore.view) {
      if (
        pendingRestore.mode === "fullscreen" &&
        viewState.mode !== "fullscreen"
      ) {
        transition({ type: "fullscreen" });
      }
      setPendingRestore(null);
      return;
    }
    if (viewState.view) setPendingRestore(null);
  }, [viewState, pendingRestore]);

  // F9: every view transition records this tab's open view and mode, so an
  // interrupted exit can offer the working layout back. A closed tab's
  // entry is removed, so views still start closed by default. The initial
  // closed state records nothing: mounting must not wipe the record the
  // offer is about to read.
  const lastRecordedView = useRef("");
  useEffect(() => {
    if (!cwd) return;
    const current = viewState.view
      ? `${viewState.view}:${viewState.mode}`
      : "";
    if (lastRecordedView.current === current) return;
    lastRecordedView.current = current;
    recordChatView(
      cwd,
      tabKey,
      viewState.view ? { view: viewState.view, mode: viewState.mode } : null,
    );
  }, [cwd, tabKey, viewState]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<ChildNavigation>).detail;
      if (detail?.tabId !== tabId) return;
      setChildTicketId(detail.ticketId);
      if (detail.ticketId) {
        if (viewState.view !== "board") transition({ type: "toggle", view: "board", narrow });
      } else transition({ type: "close" });
    };
    const showUsage = (event: Event) => {
      const id = (event as CustomEvent<{ footerId: string }>).detail?.footerId;
      const footer = id ? document.getElementById(id) : null;
      if (!footer || !rootRef.current?.contains(footer)) return;
      activatePiTab(tabId);
      transition({ type: "close" });
      requestAnimationFrame(() => {
        footer.scrollIntoView({ block: "center", behavior: "smooth" });
        footer.focus({ preventScroll: true });
      });
    };
    window.addEventListener(CHILD_NAVIGATION_EVENT, navigate);
    window.addEventListener(SHOW_USAGE_EVENT, showUsage);
    return () => {
      window.removeEventListener(CHILD_NAVIGATION_EVENT, navigate);
      window.removeEventListener(SHOW_USAGE_EVENT, showUsage);
    };
  }, [tabId, viewState, narrow]);

  useLayoutEffect(() => {
    if (!active || !rootRef.current) return;
    const root = rootRef.current;
    const measure = (width: number) => {
      if (width <= 0) return;
      const available = Math.max(0, width - MODE_STRIP_WIDTH);
      setContentWidth(available);
      dispatch({ type: "resize", narrow: isNarrowContent(available) });
    };
    measure(root.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        if (entry.target === root) measure(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [active]);

  const previousView = useRef(viewState);
  useLayoutEffect(() => {
    if (!active) return;
    const previous = previousView.current;
    const changed = previous !== viewState;
    previousView.current = viewState;
    let target: HTMLElement | null | undefined;
    if (
      focusAfterTransition.current &&
      focusAfterTransition.current !== "view"
    ) {
      target = buttons.current[focusAfterTransition.current];
    } else if (
      viewState.view &&
      (changed || focusAfterTransition.current === "view")
    ) {
      target =
        viewState.view === "sessions"
          ? searchRef.current
          : viewRef.current?.querySelector<HTMLElement>("button");
    } else if (!viewState.view && previous.view) {
      target = buttons.current[previous.view];
    } else if (lastFocus.current?.isConnected) {
      target = lastFocus.current;
    }
    target?.focus({ preventScroll: true });
    focusAfterTransition.current = null;
  }, [active, viewState]);

  useEffect(() => {
    if (!active || viewState.mode !== "popover" || !viewState.view) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || isModalTarget(target)) return;
      if (
        viewRef.current?.contains(target) ||
        target.closest('[data-uat="mode-strip"]')
      )
        return;
      transition({ type: "dismiss-popover" });
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [active, viewState]);

  useGlobalShortcuts(
    {
      "pi.toggleBoard": () => toggle("board"),
      "pi.toggleGraph": () => toggle("graph"),
      "pi.sessions": () => {
        transition({ type: "open", view: "sessions", narrow });
      },
      "pi.toggleArtifact": () => toggle("artifact"),
    },
    {
      enabled: active,
      isDisabled: (_id, event) => isTerminalTarget(event.target),
    },
  );

  useEffect(() => {
    void openSession(tabId, { cwd, launcherDir });
    if (cwd) void recordProjectOpen(cwd);
    return () => {
      usePiStore.getState().close(tabId);
    };
  }, [tabId, cwd, launcherDir, openSession]);

  // Tail the parent's agent-hub dir; every child line lands in the per-file
  // child store, feeding the run graph and transcript tabs.
  useEffect(() => {
    if (!cwd) return;
    return watchChildTranscripts(cwd, () => {
      const state = usePiStore.getState().tabs[tabId]?.state;
      return state?.sessionId && ["thinking", "tool", "awaiting-ask"].includes(state.status)
        ? ledgerPath(cwd, state.sessionId) : null;
    });
  }, [cwd, tabId]);

  const blocks = entry?.state.blocks ?? [];


  // Artifact documents over the finished answers, in session order; the
  // pane shows the latest by default, the transcript's chip picks an older
  // one. Streaming answers wait until the turn is done.
  const artifacts: ArtifactDoc[] = useMemo(() => {
    const docs: ArtifactDoc[] = [];
    const sessionId = entry?.state.sessionId ?? null;
    for (const turn of groupTurns(messageBlocks(blocks))) {
      if (turn.status !== "done") continue;
      detectArtifacts(turn.answer).forEach((item, n) => {
        docs.push({
          kind: item.kind,
          title: item.title,
          source: item.source,
          turn: turn.index,
          n,
          turnKey: turn.key,
          sessionId,
          mime: artifactMime(item.kind),
        });
      });
    }
    return docs;
  }, [blocks, entry?.state.sessionId]);

  // K13 file-first: detection alone opens nothing. Each detected document
  // is written through pi_write_artifact (idempotent on an unchanged hash),
  // and only a completed file under .pi/artifacts unlocks the viewer
  // controls. The strip remains available before a file exists.
  const [artifactPreparing, setArtifactPreparing] = useState(false);
  const [artifactFiles, setArtifactFiles] = useState<
    Record<string, ArtifactFileRef>
  >({});
  const artifactFilesRef = useRef<Record<string, ArtifactFileRef>>({});
  const writtenHashesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    setArtifactPreparing(false);
    if (!cwd) return;
    let alive = true;
    void (async () => {
      for (const doc of artifacts) {
        if (!alive) return;
        const key = artifactFileKey(doc.turnKey ?? "", doc.n ?? 0);
        const hash = await sha256Hex(doc.source);
        if (!alive) return;
        if (writtenHashesRef.current[key] === hash) continue;
        if (artifactFilesRef.current[key]?.sha256 === hash) {
          writtenHashesRef.current[key] = hash;
          continue;
        }
        try {
          setArtifactPreparing(true);
          const res = await invoke<{
            path: string;
            sha256: string;
            reused: boolean;
          }>("pi_write_artifact", {
            cwd,
            artifactId: await artifactIdFor(
              doc.sessionId ?? null,
              doc.turnKey ?? "",
              doc.n ?? 0,
            ),
            sessionId: doc.sessionId ?? "",
            turnId: doc.turnKey ?? "",
            mime: doc.mime ?? "text/html",
            content: doc.source,
            workspace: currentWorkspaceEnv(),
          });
          if (!alive) return;
          writtenHashesRef.current[key] = res.sha256;
          artifactFilesRef.current = {
            ...artifactFilesRef.current,
            [key]: { path: res.path, sha256: res.sha256 },
          };
          setArtifactFiles(artifactFilesRef.current);
        } catch {
          // No file, no control: a later transcript change retries the write.
        }
      }
    })().catch(() => {}).finally(() => {
      if (alive) setArtifactPreparing(false);
    });
    return () => {
      alive = false;
    };
  }, [cwd, artifacts]);

  // The viewer's authoritative input is an existing file: only file-backed
  // documents reach the viewer and the open events.
  const fileArtifacts: ArtifactDoc[] = useMemo(
    () =>
      (artifacts
        .map((doc): ArtifactDoc | null => {
          const file = artifactFiles[artifactFileKey(doc.turnKey ?? "", doc.n ?? 0)];
          return file
            ? {
                ...doc,
                path: `${(cwd ?? "").replace(/[\\/]+$/, "")}/${file.path}`,
                sha256: file.sha256,
              }
            : null;
        })
        .filter((doc): doc is ArtifactDoc => doc !== null)),
    [artifacts, artifactFiles, cwd],
  );

  const selectedArtifact = useMemo(() => {
    if (artifactSel) {
      const hit = fileArtifacts.find(
        (doc) => doc.turn === artifactSel.turn && doc.n === artifactSel.n,
      );
      if (hit) return hit;
    }
    return fileArtifacts[fileArtifacts.length - 1] ?? null;
  }, [fileArtifacts, artifactSel]);

  useEffect(() => {
    if (!active) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ turn?: unknown; n?: unknown }>)
        .detail;
      if (
        !fileArtifacts.some(
          (doc) => doc.turn === detail?.turn && doc.n === detail?.n,
        )
      )
        return;
      setArtifactSel({ turn: detail.turn as number, n: detail.n as number });
      transition({ type: "open", view: "artifact", narrow });
    };
    window.addEventListener("pi:open-artifact", handler);
    return () => window.removeEventListener("pi:open-artifact", handler);
  }, [active, fileArtifacts, narrow, viewState]);


  useEffect(() => {
    let changed = false;
    for (const block of blocks) {
      if (
        block.kind === "tool" &&
        block.status === "done" &&
        block.toolName.startsWith("board_") &&
        !seenBoardTools.current.has(block.toolCallId)
      ) {
        seenBoardTools.current.add(block.toolCallId);
        changed = true;
      }
    }
    if (changed) setBoardTick((tick) => tick + 1);
    if (!blocks.length) seenBoardTools.current.clear();
  }, [blocks]);

  const view = viewState.view;
  const fullscreen = view !== null && viewState.mode === "fullscreen";
  const storageBanner =
    cwd && storageError && storageError.path === uiStatePath(cwd) ? (
      <div
        data-uat="storage-error"
        role="status"
        className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
      >
        <span className="min-w-0 flex-1 break-all">
          Storage error: {storageError.path}
        </span>
        <div className="flex min-w-max shrink-0 flex-nowrap gap-2 whitespace-nowrap">
        <button
          type="button"
          data-uat="storage-retry"
          aria-label="Retry save"
          title="Retry save"
          onClick={() => void retryStorage()}
          className={viewButtonClass}
        >
          Retry save
        </button>
        </div>
      </div>
    ) : null;
  return (
    <div
      ref={rootRef}
      data-uat="pi-tab"
      data-uat-key={String(tabId)}
      aria-hidden={!active}
      inert={!active}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60"
      onFocusCapture={(event) => {
        lastFocus.current = event.target;
      }}
      onKeyDown={(event) => {
        if (
          !active ||
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing
        )
          return;
        if (isModalTarget(event.target) || isTerminalTarget(event.target))
          return;
        if (!view && !viewState.narrowRestoreView) return;
        event.preventDefault();
        event.stopPropagation();
        transition({ type: view ? "escape" : "close", narrow });
      }}
    >
      {storageBanner}
      {layoutOffer && recordedView ? (
        <div
          data-uat="layout-offer"
          role="status"
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-secondary/60 px-2 py-1 text-xs font-medium"
        >
          <span className="min-w-0 flex-1 break-all">
            Last session ended unexpectedly.
          </span>
          <div className="flex min-w-max shrink-0 flex-nowrap gap-2 whitespace-nowrap">
          <button
            type="button"
            data-uat="layout-restore"
            aria-label="Restore working layout"
            title="Restore working layout"
            onClick={restoreLayout}
            className={viewButtonClass}
          >
            Restore working layout
          </button>
          <button
            type="button"
            data-uat="layout-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setOfferDismissed(true)}
            className={viewButtonClass}
          >
            Dismiss
          </button>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          data-pi-chat={tabId}
          hidden={fullscreen}
          inert={fullscreen}
          className={cn("min-h-0 min-w-0 flex-1", fullscreen && "hidden")}
        >
          <ChatPane
            tabId={tabId}
            cwd={cwd}
            onOpenChild={onOpenChild}
            artifactFiles={artifactFiles}
            openDraftIds={openDraftIds}
            onRecoverDraft={onRecoverDraft}
          />
        </div>
        {view && (
          <ChatView
            key={view}
            view={view}
            mode={viewState.mode}
            width={panelWidth(layout.views[view].widthCss, contentWidth ?? 800)}
            contentWidth={contentWidth ?? 800}
            popoverTop={buttons.current.sessions?.offsetTop ?? 80}
            viewRef={viewRef}
            onClose={() => transition({ type: "close" })}
            onBack={() => transition({ type: "back", narrow })}
            onFullscreen={() => transition({ type: "fullscreen" })}
            onExpand={() => transition({ type: "expand", narrow })}
            onWidthCommit={(widthCss) =>
              update({ views: { [view]: { widthCss } } })
            }
          >
            {view === "board" && (
              <>
              <BoardView
                key={childTicketId ?? "board"}
                cwd={cwd}
                data={boardData}
                framed
                active={active}
                mode={viewState.mode === "fullscreen" ? "full" : "rail"}
              />
              <TicketSheet
                cwd={cwd}
                boardBin={PI_MODULE_PREFS_DEFAULTS.boardBin}
                ticketId={active ? childTicketId : null}
                sessionId={entry?.state.sessionId ?? null}
                onOpenChild={onOpenChild}
                onOpenChange={(open) => {
                  if (!open) setChildTicketId(null);
                }}
                onRefresh={() => setBoardTick((tick) => tick + 1)}
              />
              </>
            )}
            {view === "graph" && active && (
              <RunGraph tabId={tabId} onOpenChild={onOpenChild} />
            )}
            {view === "artifact" && (
              <ArtifactPane doc={selectedArtifact} cwd={cwd} preparing={artifactPreparing} />
            )}
            {view === "sessions" && (
              <SessionSearch
                tabId={tabId}
                cwd={cwd}
                query={cwd ? layout.sessionsQuery : undefined}
                onQueryChange={(sessionsQuery) => update({ sessionsQuery })}
                inputRef={searchRef}
                onActivate={(hit) => {
                  transition({ type: "hit-activated" });
                  requestAnimationFrame(() => scrollToSnippet(hit.snippet, tabId));
                }}
              />
            )}
          </ChatView>
        )}
        <ModeStrip
          view={view}
          hasArtifact={selectedArtifact !== null}
          boardCount={awaitingDecisionCount(boardData.snapshot)}
          graphCount={runningChildren}
          buttons={buttons}
          onToggle={toggle}
        />
      </div>
    </div>
  );
}
