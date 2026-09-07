import { useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { ArtifactPane } from "./components/ArtifactPane";
import { BoardView } from "./components/BoardPane";
import { ChatPane } from "./components/ChatPane";
import { RailPane } from "./components/RailPane";
import { RunGraph } from "./components/RunGraph";
import { SessionSearch } from "./components/SessionSearch";
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
          className={cn(
            "absolute inset-0",
            t.id !== activeId &&
              "invisible pointer-events-none [&_.react-flow__node]:invisible!",
          )}
        >
          <PiTab
            tabId={t.id}
            cwd={t.cwd}
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
  onOpenChild,
  onOpenBoard,
  onOpenRunGraph,
  launcherDir = PI_MODULE_PREFS_DEFAULTS.launcherDir,
}: {
  tabId: number;
  cwd?: string;
  onOpenChild: (path: string) => void;
  onOpenBoard?: (cwd: string) => void;
  onOpenRunGraph?: (cwd: string | undefined, piTabId: number) => void;
  launcherDir?: string;
}) {
  const entry = usePiStore((s) => s.tabs[tabId]);
  const openSession = usePiStore((s) => s.openSession);
  const [boardTick, setBoardTick] = useState(0);
  const seenBoardTool = useRef(false);

  // Layout persists per cwd, so the same project restores the same geometry.
  const { layout, update } = usePiLayout(cwd);
  const railRef = useRef<PanelImperativeHandle | null>(null);
  const graphRef = useRef<PanelImperativeHandle | null>(null);
  const boardRef = useRef<PanelImperativeHandle | null>(null);
  const artifactRef = useRef<PanelImperativeHandle | null>(null);
  const sessionsRef = useRef<PanelImperativeHandle | null>(null);

  // Sessions pane collapse is local state, not the persisted layout: the
  // pane starts closed so the rail keeps today's geometry.
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);

  // Which artifact the pane shows; null means "the latest one".
  const [artifactSel, setArtifactSel] = useState<{
    turn: number;
    n: number;
  } | null>(null);

  const handleRailResize = (
    size: PanelSize,
    _id: string | number | undefined,
    prev: PanelSize | undefined,
  ) => {
    if (prev === undefined) return; // initial mount event
    if (size.inPixels <= 0) update({ railCollapsed: true });
    else
      update({
        rail: Math.round(size.asPercentage * 10) / 10,
        railCollapsed: false,
      });
  };

  const handleGraphResize = (
    size: PanelSize,
    _id: string | number | undefined,
    prev: PanelSize | undefined,
  ) => {
    if (prev === undefined) return;
    if (size.inPixels <= 0) update({ graphCollapsed: true });
    else
      update({
        graph: Math.round(size.asPercentage * 10) / 10,
        graphCollapsed: false,
      });
  };

  const handleBoardResize = (
    size: PanelSize,
    _id: string | number | undefined,
    prev: PanelSize | undefined,
  ) => {
    if (prev === undefined) return;
    update({ boardCollapsed: size.inPixels <= 0 });
  };

  const handleArtifactResize = (
    size: PanelSize,
    _id: string | number | undefined,
    prev: PanelSize | undefined,
  ) => {
    if (prev === undefined) return;
    if (size.inPixels <= 0) update({ artifactCollapsed: true });
    else
      update({
        artifact: Math.round(size.asPercentage * 10) / 10,
        artifactCollapsed: false,
      });
  };

  const toggleGraph = () => {
    const panel = graphRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  const toggleBoard = () => {
    const panel = boardRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  const toggleArtifact = () => {
    const panel = artifactRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  const toggleSessions = () => {
    const panel = sessionsRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  const handleSessionsResize = (
    size: PanelSize,
    _id: string | number | undefined,
    prev: PanelSize | undefined,
  ) => {
    if (prev === undefined) return;
    setSessionsCollapsed(size.inPixels <= 0);
  };

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

  // The transcript's "Open artifact" chip selects in the pane and expands it
  // (DOM CustomEvent in the same window, the same bridge as pi:open-file).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ turn?: unknown; n?: unknown }>).detail;
      if (
        !detail ||
        typeof detail.turn !== "number" ||
        typeof detail.n !== "number"
      ) {
        return;
      }
      setArtifactSel({ turn: detail.turn, n: detail.n });
      if (artifactRef.current?.isCollapsed()) artifactRef.current.expand();
    };
    window.addEventListener("pi:open-artifact", handler);
    return () => window.removeEventListener("pi:open-artifact", handler);
  }, []);

  // Any board_ tool execution may have mutated the board: refresh the pane.
  useEffect(() => {
    const last = blocks[blocks.length - 1];
    if (
      last?.kind === "tool" &&
      last.status === "done" &&
      last.toolName.startsWith("board_") &&
      !seenBoardTool.current
    ) {
      seenBoardTool.current = true;
      setBoardTick((t) => t + 1);
    }
    if (!last || last.kind !== "tool" || last.toolName.startsWith("board_")) {
      seenBoardTool.current = false;
    }
  }, [blocks]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1 gap-2"
    >
      <ResizablePanel id={`pi-chat-${tabId}`} minSize="20%">
        <div
          data-pi-chat={tabId}
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60"
        >
          <ChatPane tabId={tabId} cwd={cwd} onOpenChild={onOpenChild} />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle className="bg-transparent" />
      <ResizablePanel
        id={`pi-rail-${tabId}`}
        panelRef={railRef}
        defaultSize={layout.railCollapsed ? 0 : `${layout.rail}%`}
        minSize="240px"
        collapsible
        onResize={handleRailResize}
      >
        <ResizablePanelGroup orientation="vertical" className="min-h-0 gap-2">
          <ResizablePanel
            id={`pi-graph-${tabId}`}
            panelRef={graphRef}
            defaultSize={layout.graphCollapsed ? 0 : `${layout.graph}%`}
            minSize="48px"
            collapsible
            onResize={handleGraphResize}
          >
            <RailPane
              title="Run graph"
              collapsed={layout.graphCollapsed}
              onToggleCollapse={toggleGraph}
              onExpand={
                onOpenRunGraph ? () => onOpenRunGraph(cwd, tabId) : undefined
              }
            >
              <RunGraph tabId={tabId} onOpenChild={onOpenChild} />
            </RailPane>
          </ResizablePanel>
          <ResizableHandle withHandle className="bg-transparent" />
          <ResizablePanel
            id={`pi-board-${tabId}`}
            panelRef={boardRef}
            defaultSize={
              layout.boardCollapsed
                ? 0
                : `${Math.max(0, 100 - layout.graph - layout.artifact)}%`
            }
            minSize="48px"
            collapsible
            onResize={handleBoardResize}
          >
            <RailPane
              title="Board"
              collapsed={layout.boardCollapsed}
              onToggleCollapse={toggleBoard}
              onExpand={onOpenBoard && cwd ? () => onOpenBoard(cwd) : undefined}
            >
              <BoardView cwd={cwd} refreshKey={boardTick} mode="rail" />
            </RailPane>
          </ResizablePanel>
          <ResizableHandle withHandle className="bg-transparent" />
          <ResizablePanel
            id={`pi-artifact-${tabId}`}
            panelRef={artifactRef}
            defaultSize={layout.artifactCollapsed ? 0 : `${layout.artifact}%`}
            minSize="48px"
            collapsible
            onResize={handleArtifactResize}
          >
            <RailPane
              title="Artifact"
              collapsed={layout.artifactCollapsed}
              onToggleCollapse={toggleArtifact}
            >
              <ArtifactPane doc={selectedArtifact} cwd={cwd} />
            </RailPane>
          </ResizablePanel>
          <ResizableHandle withHandle className="bg-transparent" />
          <ResizablePanel
            id={`pi-sessions-${tabId}`}
            panelRef={sessionsRef}
            defaultSize="18%"
            minSize="48px"
            collapsible
            onResize={handleSessionsResize}
          >
            <RailPane
              title="Sessions"
              collapsed={sessionsCollapsed}
              onToggleCollapse={toggleSessions}
            >
              <SessionSearch tabId={tabId} cwd={cwd} />
            </RailPane>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
