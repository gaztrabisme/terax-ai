import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { useEffect, useRef, useState } from "react";
import { BoardView } from "./components/BoardPane";
import { ChatPane } from "./components/ChatPane";
import { RunGraph } from "./components/RunGraph";
import { useChildStore } from "./lib/childStore";
import { usePiStore } from "./lib/piStore";
import { watchTranscripts } from "./lib/rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./lib/settingsSchema";

type StackProps = {
  tabs: Tab[];
  activeId: number;
  onOpenChild: (path: string) => void;
};

// Keep-alive slot: every pi tab stays mounted while hidden so the RPC
// stream keeps filling the store when the user is on another tab.
export function PiStack({ tabs, activeId, onOpenChild }: StackProps) {
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
          <PiTab tabId={t.id} cwd={t.cwd} onOpenChild={onOpenChild} />
        </div>
      ))}
    </div>
  );
}

export function PiTab({
  tabId,
  cwd,
  onOpenChild,
  launcherDir = PI_MODULE_PREFS_DEFAULTS.launcherDir,
}: {
  tabId: number;
  cwd?: string;
  onOpenChild: (path: string) => void;
  launcherDir?: string;
}) {
  const entry = usePiStore((s) => s.tabs[tabId]);
  const openSession = usePiStore((s) => s.openSession);
  const [boardTick, setBoardTick] = useState(0);
  const seenBoardTool = useRef(false);

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
    <div className="flex h-full min-h-0 gap-2">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60">
        <ChatPane tabId={tabId} cwd={cwd} onOpenChild={onOpenChild} />
      </div>

      <div className="flex h-full min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
        <div className="min-h-0 flex-1">
          <RunGraph tabId={tabId} onOpenChild={onOpenChild} />
        </div>
        <div className="h-56 shrink-0">
          <BoardView cwd={cwd} refreshKey={boardTick} mode="rail" />
        </div>
      </div>
    </div>
  );
}
