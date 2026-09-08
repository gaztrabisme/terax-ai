import { useState } from "react";
import { actionDuration, SESSION_LOG, type ActionRecord } from "@/modules/pi/lib/ledgerStore";
import { SHOW_USAGE_EVENT } from "@/modules/pi/lib/childNavigation";

export function usageFooterId(sessionId: string | null | undefined, turnKey: string): string {
  return `pi-usage-${encodeURIComponent(sessionId ?? "")}-${encodeURIComponent(turnKey)}`;
}

export function ActionFields({ action, footerId }: { action: ActionRecord; footerId?: string }) {
  const duration = actionDuration(action);
  const unreported = (label: string) => footerId ? (
    <a
      href={`#${footerId}`}
      aria-label={`${label}: not separately reported. Show owning turn usage`}
      className="underline underline-offset-2 hover:text-foreground"
      onClick={(event) => {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent(SHOW_USAGE_EVENT, { detail: { footerId } }));
        const footer = document.getElementById(footerId);
        footer?.scrollIntoView({ block: "center", behavior: "smooth" });
        footer?.focus({ preventScroll: true });
      }}
    >
      not separately reported
    </a>
  ) : <span title={`Owning turn unavailable (${SESSION_LOG})`}>not separately reported</span>;
  const fields = [
    ["action-role", "Role", action.role ?? "unknown"],
    ["action-agent", "Agent", action.agentId ?? "unknown"],
    ["action-ticket", "Ticket", action.ticketId ?? "unknown"],
    ["action-tokens", "Tokens", action.usage.input === null && action.usage.output === null
      ? unreported("Tokens")
      : `${action.usage.input ?? "unknown"} in, ${action.usage.output ?? "unknown"} out`],
    ["action-cost", "Cost", action.usage.cost === null
      ? unreported("Cost")
      : `${action.usage.cost} ${action.usage.currency ?? "currency unknown"}`],
    ["action-duration", "Duration", duration === null ? "unknown" : `${(duration / 1000).toFixed(1)} s`],
  ] as const;
  return (
    <dl data-uat="action-row" data-uat-key={action.actionId} className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {fields.map(([id, label, value]) => (
        <div key={id} data-uat={id} aria-label={label} title={action.evidencePath ?? SESSION_LOG} className="min-w-0 break-words">
          <dt className="font-medium">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LedgerActionRow({ action, footerId }: { action: ActionRecord; footerId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        aria-label={`Inspect ${action.kind} ${action.actionId}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent/40"
      >
        <span className="truncate">{action.kind}</span>
        <span className="ml-auto text-muted-foreground">{action.status}</span>
      </button>
      {open && <div className="border-t border-border/60 p-2"><ActionFields action={action} footerId={footerId} /></div>}
    </div>
  );
}
