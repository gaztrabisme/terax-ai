import { BOARD_STATE_ORDER } from "@/modules/pi/components/board/stateOrder";
import { stateLabel, type BoardSnapshot } from "@/modules/pi/lib/board";
import { TicketCard } from "./TicketCard";

type Props = {
  snapshot: BoardSnapshot;
  onOpen: (id: string) => void;
};

/**
 * The panel's half of the one board representation (design.md section 3.2 S4):
 * the same state lanes the full board shows as columns, stacked vertically
 * with a count per lane. A lane header carries the state name and its ticket
 * count; an empty lane is that header alone, a single muted "todo 0" line.
 */
export function LaneList({ snapshot, onOpen }: Props) {
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
      {BOARD_STATE_ORDER.map((state, li) => {
        const tickets = snapshot.tickets.filter((t) => t.status === state);
        return (
          <section
            key={state}
            data-uat="board-columns"
            data-uat-key={state}
            data-uat-index={li}
            aria-label={`${stateLabel(state)} lane`}
          >
            <div className="flex items-center justify-between px-2 py-1 text-[12px] text-muted-foreground">
              <span>{stateLabel(state)}</span>
              <span className="font-mono">{tickets.length}</span>
            </div>
            {tickets.length > 0 ? (
              <div className="space-y-1.5 pb-1">
                {tickets.map((ticket, ti) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    dense
                    uatIndex={ti}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
