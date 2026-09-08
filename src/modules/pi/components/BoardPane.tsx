import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { railTickets } from "../lib/board";
import { useBoardData, type BoardData } from "../lib/useBoardData";
export { POLL_MS } from "../lib/useBoardData";
import { ColumnStrip } from "./board/ColumnStrip";
import { Kanban } from "./board/Kanban";
import { TicketCard } from "./board/TicketCard";
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
  const { snapshot, error, refresh } = data ?? ownData;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const tickets = snapshot
    ? railTickets(
        snapshot,
        snapshot.states.includes(filter ?? "") ? filter : null,
      )
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!framed && (
        <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-[12px] font-medium uppercase text-muted-foreground">
          <span>board</span>
          <span className="flex-1" />
          {error ? (
            <span className="normal-case text-destructive">offline</span>
          ) : null}
        </div>
      )}

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
          <ColumnStrip
            snapshot={snapshot}
            filter={filter}
            onFilter={setFilter}
          />
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
        ticketId={active ? selectedId : null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onRefresh={refresh}
      />
    </div>
  );
}
