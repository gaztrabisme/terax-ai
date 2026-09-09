import { useLayoutEffect, useRef, useState } from "react";
import { BOARD_STATE_ORDER } from "@/modules/pi/components/board/stateOrder";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleStates, setVisibleStates] = useState<number>(BOARD_STATE_ORDER.length);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setVisibleStates(
      element.scrollWidth > element.clientWidth
        ? Math.max(1, Math.floor((element.clientWidth - 8) / 248))
        : BOARD_STATE_ORDER.length,
    );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const overflowing = visibleStates < BOARD_STATE_ORDER.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {overflowing ? (
        <p role="status" className="shrink-0 border-b border-border/60 px-2 py-1 text-xs text-muted-foreground">
          {visibleStates} of {BOARD_STATE_ORDER.length} states visible. Scroll horizontally to see all states.
        </p>
      ) : null}
      <div ref={scrollRef} role="region" aria-label="Board states" tabIndex={overflowing ? 0 : undefined} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-h-0 gap-2 p-2">
          {BOARD_STATE_ORDER.map((state, ci) => {
            const tickets = snapshot.tickets.filter((t) => t.status === state);
            return (
              <div
                key={state}
                data-uat="board-columns"
                data-uat-key={state}
                data-uat-index={ci}
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
                    tickets.map((ticket, ti) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        uatIndex={ti}
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
    </div>
  );
}
