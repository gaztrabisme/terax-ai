import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useBoardData, type BoardData } from "../lib/useBoardData";
export { POLL_MS } from "../lib/useBoardData";
import { Kanban } from "./board/Kanban";
import { LaneList } from "./board/LaneList";
import { TicketSheet } from "./board/TicketSheet";

type Props = {
  data?: BoardData;
  framed?: boolean;
  active?: boolean;
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

export function BoardView({
  data,
  framed = false,
  active = true,
  cwd,
  refreshKey = 0,
  mode = "rail",
  boardBin = PI_MODULE_PREFS_DEFAULTS.boardBin,
  agentBin,
}: Props) {
  const ownData = useBoardData({
    cwd,
    refreshKey,
    boardBin,
    agentBin,
    enabled: !data,
  });
  const { snapshot, error, failedCommand, refresh } = data ?? ownData;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A failed poll keeps the previous snapshot on screen, marked stale, instead
  // of dropping the content (design.md section 3.5 row "Board/graph refresh
  // fails").
  const stale = Boolean(error && snapshot);

  const errorLine = error ? (
    <>
      <span
        data-uat="board-error"
        title={error}
        className="min-w-0 truncate normal-case text-destructive"
      >
        Refresh failed: {failedCommand ?? "unknown command"} &middot; log:
        .pi/logs/board.jsonl
      </span>
      {stale ? (
        <span className="shrink-0 normal-case text-muted-foreground">stale</span>
      ) : null}
    </>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!framed && (
        <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-[12px] font-medium uppercase text-muted-foreground">
          <span>board</span>
          <span className="flex-1" />
          {errorLine}
        </div>
      )}
      {framed && errorLine ? (
        <div className="flex shrink-0 items-center gap-2 px-2 pt-2 text-[12px]">
          {errorLine}
        </div>
      ) : null}

      {error && !snapshot ? (
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
      ) : mode === "full" ? (
        <Kanban snapshot={snapshot} onOpen={setSelectedId} />
      ) : (
        <LaneList snapshot={snapshot} onOpen={setSelectedId} />
      )}

      <TicketSheet
        cwd={cwd}
        boardBin={boardBin}
        agentBin={agentBin}
        ticketId={active ? selectedId : null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onRefresh={refresh}
      />
    </div>
  );
}
