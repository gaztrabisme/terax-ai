import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { BoardView } from "./components/BoardPane";
import { ChatPane } from "./components/ChatPane";
import { RailPane } from "./components/RailPane";
import { RunGraph } from "./components/RunGraph";
import { useChildStore } from "./lib/childStore";
import { usePiLayout } from "./lib/layoutStore";
import { usePiStore } from "./lib/piStore";
import { watchTranscripts } from "./lib/rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./lib/settingsSchema";

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
            t.id !== activeId && "invisible pointer-events-none",
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
      className="min-h-0 flex-1 gap-0"
    >
      <ResizablePanel id={`pi-chat-${tabId}`} minSize="20%">
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60">
          <ChatPane tabId={tabId} cwd={cwd} onOpenChild={onOpenChild} />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id={`pi-rail-${tabId}`}
        panelRef={railRef}
        defaultSize={layout.railCollapsed ? 0 : `${layout.rail}%`}
        minSize="240px"
        collapsible
        onResize={handleRailResize}
      >
        <ResizablePanelGroup orientation="vertical" className="min-h-0">
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
          <ResizableHandle withHandle />
          <ResizablePanel
            id={`pi-board-${tabId}`}
            panelRef={boardRef}
            defaultSize={layout.boardCollapsed ? 0 : `${100 - layout.graph}%`}
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
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
