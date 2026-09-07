import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { gateDots, type Ticket } from "@/modules/pi/lib/board";

type Props = {
  ticket: Ticket;
  /** Dense form used by the rail list. */
  dense?: boolean;
  onOpen: (id: string) => void;
};

export function TicketCard({ ticket, dense = false, onOpen }: Props) {
  const dots = gateDots(ticket);
  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.id)}
      className={cn(
        "block w-full rounded-md border border-border/60 bg-card text-left transition-colors hover:bg-accent/60",
        dense ? "px-2 py-1.5" : "px-2.5 py-2",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-[12px] text-foreground">
          {ticket.id}
        </span>
        <Badge variant="secondary" className="px-1.5 text-[12px]">
          {ticket.kind}
        </Badge>
        <span className="flex-1" />
        {dots.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {dots.map((dot) => (
              <span
                key={dot.gate}
                title={`${dot.gate}: ${dot.passed ? "pass" : "fail"}`}
                className={cn(
                  "size-1.5 rounded-full",
                  dot.passed ? "bg-emerald-500" : "bg-destructive",
                )}
              />
            ))}
          </span>
        ) : null}
        {ticket.attempt > 0 ? (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            attempt {ticket.attempt}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "text-[14px] leading-snug text-foreground",
          dense ? "line-clamp-1" : "mt-0.5 line-clamp-2",
        )}
      >
        {ticket.title}
      </div>
    </button>
  );
}
