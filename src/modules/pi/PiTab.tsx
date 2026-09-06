import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { useEffect, useRef, useState } from "react";
import { BoardPane } from "./components/BoardPane";
import { Composer } from "./components/Composer";
import { RunGraph } from "./components/RunGraph";
import { Transcript } from "./components/Transcript";
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

function statusLabel(
  status: string,
  exited: boolean,
  exitCode: number | null,
): string {
  if (exited) return `exited (${exitCode ?? "signal"})`;
  switch (status) {
    case "idle":
      return "idle";
    case "thinking":
      return "thinking";
    case "tool":
      return "running tool";
    case "awaiting-ask":
      return "waiting for answer";
    case "done":
      return "done";
    default:
      return status;
  }
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
  const sendPrompt = usePiStore((s) => s.sendPrompt);
  const answerAsk = usePiStore((s) => s.answerAsk);
  const dismissAsk = usePiStore((s) => s.dismissAsk);
  const kill = usePiStore((s) => s.kill);
  const [sendError, setSendError] = useState<string | null>(null);
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

  const submit = (markdown: string) => {
    if (!entry?.session || entry.exited) return;
    setSendError(null);
    sendPrompt(tabId, markdown).catch((e) => {
      setSendError(e instanceof Error ? e.message : String(e));
    });
  };

  const state = entry?.state;
  const busy = state?.status === "thinking" || state?.status === "tool";

  return (
    <div className="flex h-full min-h-0 gap-2">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              entry?.exited
                ? "bg-destructive"
                : state?.status === "awaiting-ask"
                  ? "bg-yellow-500"
                  : busy
                    ? "animate-pulse bg-blue-500"
                    : "bg-muted-foreground/40",
            )}
          />
          <span className="font-medium text-foreground">pi</span>
          <span>
            {statusLabel(
              state?.status ?? "idle",
              entry?.exited ?? false,
              entry?.exitCode ?? null,
            )}
          </span>
          {state?.sessionId ? (
            <span className="truncate font-mono text-[10px]">
              {state.sessionId.slice(0, 8)}
            </span>
          ) : null}
          {state?.tokens ? (
            <span>{state.tokens.totalTokens.toLocaleString()} tok</span>
          ) : null}
          <span className="flex-1" />
          {!entry?.exited && entry?.session ? (
            <button
              type="button"
              onClick={() => void kill(tabId)}
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            >
              Kill
            </button>
          ) : null}
        </div>

        {entry?.error ? (
          <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {entry.error}
          </div>
        ) : null}
        {sendError ? (
          <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {sendError}
          </div>
        ) : null}

        <Transcript
          blocks={blocks}
          onAnswer={(requestId, answers) =>
            void answerAsk(tabId, requestId, answers)
          }
          onDismiss={(requestId) => void dismissAsk(tabId, requestId)}
        />

        <Composer
          tabId={tabId}
          cwd={cwd}
          disabled={!entry?.session || entry.exited}
          placeholder={
            entry?.session
              ? "Message pi (markdown, Enter sends)"
              : entry?.exited
                ? "Session exited"
                : "Waiting for pi..."
          }
          onSubmit={submit}
        />
      </div>

      <div className="flex h-full min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
        <div className="min-h-0 flex-1">
          <RunGraph tabId={tabId} onOpenChild={onOpenChild} />
        </div>
        <div className="h-56 shrink-0">
          <BoardPane cwd={cwd} refreshKey={boardTick} />
        </div>
      </div>
    </div>
  );
}
