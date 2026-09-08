import { invoke } from "@tauri-apps/api/core";
import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { Skeleton } from "@/components/ui/skeleton";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  boardListCommand,
  ensureAgentBin,
  parseBoard,
  railTickets,
  type BoardSnapshot,
} from "../lib/board";
import { ColumnStrip } from "./board/ColumnStrip";
import { Kanban } from "./board/Kanban";
import { TicketCard } from "./board/TicketCard";
import { TicketSheet } from "./board/TicketSheet";

type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

type Props = {
  cwd?: string;
  /** Bumped by the parent after any board_ tool execution. */
  refreshKey?: number;
  /** "rail" is the compact pane, "full" the kanban tab. */
  mode?: BoardViewMode;
  /** Overrides the configured board CLI path. */
  boardBin?: string;
  /** Overrides the harness agent path used for keystone actions. */
  agentBin?: string;
};

export type BoardViewMode = "rail" | "full";

// Both rail and full mode share BoardView and therefore this poll cadence.
export const POLL_MS = 10000;

export function BoardView({
  cwd,
  refreshKey = 0,
  mode = "rail",
  boardBin = PI_MODULE_PREFS_DEFAULTS.boardBin,
  agentBin,
}: Props) {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const refresh = useCallback(() => {
    if (!cwd) return;
    const seq = ++loadSeq.current;
    ensureAgentBin(agentBin)
      .then((bin) =>
        invoke<CommandOutput>("shell_run_command", {
          command: boardListCommand(boardBin, cwd, bin),
          cwd,
          timeoutSecs: 15,
          workspace: currentWorkspaceEnv(),
        }),
      )
      .then((out) => {
        if (seq !== loadSeq.current) return;
        if (out.exit_code !== 0 && out.stdout.trim() === "") {
          setError(out.stderr.trim() || `board exited ${out.exit_code}`);
          return;
        }
        try {
          setSnapshot(parseBoard(out.stdout));
          setError(null);
        } catch {
          setError(
            out.stderr.trim() || "board printed unparseable output",
          );
        }
      })
      .catch((e: unknown) => {
        if (seq === loadSeq.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
  }, [cwd, boardBin, agentBin]);

  // Refresh on mount, on refreshKey bumps, and every 10s while the document
  // is visible; the interval is cleared on unmount or when the deps change.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, refreshKey]);

  const tickets = snapshot
    ? railTickets(
        snapshot,
        snapshot.states.includes(filter ?? "") ? filter : null,
      )
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border/60">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-[12px] font-medium uppercase text-muted-foreground">
        <span>board</span>
        <span className="flex-1" />
        {error ? (
          <span className="normal-case text-destructive">offline</span>
        ) : null}
      </div>

      {error ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div className="text-[14px] text-destructive">Board offline</div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-muted-foreground">
            {error}
          </pre>
        </div>
      ) : !snapshot ? (
        <div className="min-h-0 flex-1 space-y-1.5 px-2 pb-2">
          <Skeleton className="h-5 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-3/4 rounded-md" />
        </div>
      ) : snapshot.tickets.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-start px-2 pb-2 text-[14px] text-muted-foreground">
          No tickets yet
        </div>
      ) : mode === "full" ? (
        <Kanban snapshot={snapshot} onOpen={setSelectedId} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ColumnStrip snapshot={snapshot} filter={filter} onFilter={setFilter} />
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
            {tickets.length === 0 ? (
              <div className="text-[12px] text-muted-foreground">
                No tickets
              </div>
            ) : (
              tickets.map((ticket, ti) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  dense
                  uatIndex={ti}
                  onOpen={setSelectedId}
                />
              ))
            )}
          </div>
        </div>
      )}

      <TicketSheet
        cwd={cwd}
        boardBin={boardBin}
        agentBin={agentBin}
        ticketId={selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onRefresh={refresh}
      />
    </div>
  );
}
