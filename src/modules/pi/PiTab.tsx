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
import type { PiSessionHit } from "./lib/sessions";
import { useChildStore } from "./lib/childStore";
import { detectArtifacts, type ArtifactDoc } from "./lib/artifacts";
import { usePiLayout } from "./lib/layoutStore";
import { messageBlocks } from "./lib/parse";
import { usePiStore } from "./lib/piStore";
import { watchTranscripts } from "./lib/rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./lib/settingsSchema";
import { groupTurns } from "./lib/turns";

type StackProps = {
  tabs: Tab[];
  activeId: number;
  onOpenChild: (path: string) => void;
  onOpenBoard?: (cwd: string) => void;
  onOpenRunGraph?: (cwd: string | undefined, piTabId: number) => void;
};

// Keep-alive slot: every pi tab stays mounted while hidden so the RPC
// stream keeps filling the store when the user is on another tab.
export function PiStack({
  tabs,
  activeId,
  onOpenChild,
  onOpenBoard,
  onOpenRunGraph,
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
            cwd={t.cwd}
            active={t.id === activeId}
            onOpenChild={onOpenChild}
            onOpenBoard={onOpenBoard}
            onOpenRunGraph={onOpenRunGraph}
          />
        </div>
      ))}
    </div>
  );
}

export function PiTab({
  tabId,
  cwd,
  active,
  onOpenChild,
  onOpenBoard,
  onOpenRunGraph,
  launcherDir = PI_MODULE_PREFS_DEFAULTS.launcherDir,
}: {
  tabId: number;
  cwd?: string;
  /** Whether this tab is the visible one; only it mounts the run graph. */
  active: boolean;
  onOpenChild: (path: string) => void;
  onOpenBoard?: (cwd: string) => void;
  onOpenRunGraph?: (cwd: string | undefined, piTabId: number) => void;
  launcherDir?: string;
}) {
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
  const [viewState, dispatch] = useReducer(viewReducer, CLOSED_VIEW);
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
  const [pendingHit, setPendingHit] = useState<PiSessionHit | null>(null);

  const transition = (event: ViewEvent) => {
    const next = viewReducer(viewState, event);
    if (next === viewState) return;
    focusAfterTransition.current = next.view ? "view" : viewState.view;
    dispatch(event);
  };
  const toggle = (view: View) => transition({ type: "toggle", view, narrow });

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
      "pi.toggleArtifact": () => {
        if (selectedArtifact) toggle("artifact");
      },
    },
    {
      enabled: active,
      isDisabled: (id, event) =>
        isTerminalTarget(event.target) ||
        (id === "pi.toggleArtifact" && !selectedArtifact),
    },
  );

  useEffect(() => {
    void openSession(tabId, { cwd, launcherDir });
    return () => {
      usePiStore.getState().close(tabId);
    };
  }, [tabId, cwd, launcherDir, openSession]);

  // Tail the parent's agent-hub dir; every child line lands in the per-file
  // child store, feeding the run graph and transcript tabs.
  useEffect(() => {
    if (!cwd) return;
    let watch: { close: () => Promise<void> } | null = null;
    let released = false;
    void watchTranscripts(cwd, (line) => {
      if (!released) useChildStore.getState().applyLine(line.file, line.line);
    })
      .then((w) => {
        if (released) void w.close();
        else watch = w;
      })
      .catch(() => {});
    return () => {
      released = true;
      void watch?.close();
    };
  }, [cwd]);

  const blocks = entry?.state.blocks ?? [];
  useEffect(() => {
    const id = entry?.state.sessionId;
    if (
      active &&
      pendingHit &&
      id &&
      pendingHit.path.endsWith(`_${id}.jsonl`) &&
      scrollToSnippet(pendingHit.snippet, tabId)
    ) {
      transition({ type: "dismiss-popover" });
      setPendingHit(null);
    }
  }, [active, pendingHit, entry?.state, tabId, viewState]);

  // Artifact documents over the finished answers, in session order; the
  // pane shows the latest by default, the transcript's chip picks an older
  // one. Streaming answers wait until the turn is done.
  const artifacts: ArtifactDoc[] = useMemo(() => {
    const docs: ArtifactDoc[] = [];
    for (const turn of groupTurns(messageBlocks(blocks))) {
      if (turn.status !== "done") continue;
      detectArtifacts(turn.answer).forEach((item, n) => {
        docs.push({
          kind: item.kind,
          title: item.title,
          source: item.source,
          turn: turn.index,
          n,
        });
      });
    }
    return docs;
  }, [blocks]);

  const selectedArtifact = useMemo(() => {
    if (artifactSel) {
      const hit = artifacts.find(
        (doc) => doc.turn === artifactSel.turn && doc.n === artifactSel.n,
      );
      if (hit) return hit;
    }
    return artifacts[artifacts.length - 1] ?? null;
  }, [artifacts, artifactSel]);

  useEffect(() => {
    if (!active) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ turn?: unknown; n?: unknown }>)
        .detail;
      if (
        !artifacts.some(
          (doc) => doc.turn === detail?.turn && doc.n === detail?.n,
        )
      )
        return;
      setArtifactSel({ turn: detail.turn as number, n: detail.n as number });
      transition({ type: "open", view: "artifact", narrow });
    };
    window.addEventListener("pi:open-artifact", handler);
    return () => window.removeEventListener("pi:open-artifact", handler);
  }, [active, artifacts, narrow, viewState]);

  useEffect(() => {
    if (
      !selectedArtifact &&
      (viewState.view === "artifact" ||
        viewState.narrowRestoreView === "artifact")
    ) {
      dispatch({ type: "close" });
      if (active) buttons.current.sessions?.focus();
    }
  }, [active, selectedArtifact, viewState]);

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
  return (
    <div
      ref={rootRef}
      data-uat="pi-tab"
      data-uat-key={String(tabId)}
      aria-hidden={!active}
      inert={!active}
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60"
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
      <div
        data-pi-chat={tabId}
        hidden={fullscreen}
        inert={fullscreen}
        className={cn("min-h-0 min-w-0 flex-1", fullscreen && "hidden")}
      >
        <ChatPane tabId={tabId} cwd={cwd} onOpenChild={onOpenChild} />
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
          onOpenTab={
            view === "board" && cwd && onOpenBoard
              ? () => onOpenBoard(cwd)
              : view === "graph" && onOpenRunGraph
                ? () => onOpenRunGraph(cwd, tabId)
                : undefined
          }
          onWidthCommit={(widthCss) =>
            update({ views: { [view]: { widthCss } } })
          }
        >
          {view === "board" && (
            <BoardView
              cwd={cwd}
              data={boardData}
              framed
              active={active}
              mode={viewState.mode === "fullscreen" ? "full" : "rail"}
            />
          )}
          {view === "graph" && active && (
            <RunGraph tabId={tabId} onOpenChild={onOpenChild} />
          )}
          {view === "artifact" && (
            <ArtifactPane doc={selectedArtifact} cwd={cwd} />
          )}
          {view === "sessions" && (
            <SessionSearch
              tabId={tabId}
              cwd={cwd}
              query={cwd ? layout.sessionsQuery : undefined}
              onQueryChange={(sessionsQuery) => update({ sessionsQuery })}
              inputRef={searchRef}
              onActivate={(hit) => {
                if (
                  !entry?.state.sessionId ||
                  !hit.path.endsWith(`_${entry.state.sessionId}.jsonl`)
                ) {
                  setPendingHit(hit);
                } else {
                  transition({ type: "dismiss-popover" });
                }
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
  );
}
