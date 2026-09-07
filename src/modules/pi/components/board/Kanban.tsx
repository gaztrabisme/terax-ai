import {
  stateLabel,
  type BoardSnapshot,
} from "@/modules/pi/lib/board";
import { TicketCard } from "./TicketCard";

type Props = {
  snapshot: BoardSnapshot;
  onOpen: (id: string) => void;
};

// One fixed-width column per state; only this row scrolls horizontally, the
// page itself never does.
export function Kanban({ snapshot, onOpen }: Props) {
  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div className="flex h-full min-h-0 gap-2 p-2">
        {snapshot.states.map((state) => {
          const tickets = snapshot.tickets.filter((t) => t.status === state);
          return (
            <div
              key={state}
              className="flex h-full min-h-0 w-[240px] shrink-0 flex-col rounded-md border border-border/60 bg-card/50"
            >
              <div className="flex shrink-0 items-center justify-between px-2 py-1.5 text-[12px] font-medium text-muted-foreground">
                <span>{stateLabel(state)}</span>
                <span>{tickets.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {tickets.length === 0 ? (
                  <div className="text-[12px] text-muted-foreground/60">
                    No tickets
                  </div>
                ) : (
                  tickets.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      onOpen={onOpen}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
