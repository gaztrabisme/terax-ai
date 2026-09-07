import { stateLabel, type BoardSnapshot } from "@/modules/pi/lib/board";
import { cn } from "@/lib/utils";

type Props = {
  snapshot: BoardSnapshot;
  /** Currently filtered state, or null for all rail states. */
  filter: string | null;
  onFilter: (state: string | null) => void;
};

// One row of counts, non-zero states only; clicking a count filters the rail
// list below, clicking it again clears the filter.
export function ColumnStrip({ snapshot, filter, onFilter }: Props) {
  const chips = snapshot.states.filter(
    (state) => (snapshot.counts[state] ?? 0) > 0,
  );
  if (chips.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1.5">
      {chips.map((state) => {
        const active = filter === state;
        return (
          <button
            key={state}
            type="button"
            onClick={() => onFilter(active ? null : state)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[12px] transition-colors",
              active
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {stateLabel(state)}{" "}
            <span className="font-mono">
              {snapshot.counts[state] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
