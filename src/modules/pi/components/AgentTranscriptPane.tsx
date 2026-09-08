import { cn } from "@/lib/utils";
import type { AgentTranscriptTab, Tab } from "@/modules/tabs";
import type { PiAskAnswer } from "@/modules/pi/lib/parse";
import { useChildStore } from "@/modules/pi/lib/childStore";
import { loadChildTranscript } from "@/modules/pi/lib/childStore";
import { useLedgerStore } from "@/modules/pi/lib/ledgerStore";
import { usePiStore } from "@/modules/pi/lib/piStore";
import { findChildOwner, navigateChild } from "@/modules/pi/lib/childNavigation";
import { useEffect } from "react";
import { ErrorCard, Transcript } from "./Transcript";

type StackProps = {
  tabs: Tab[];
  activeId: number;
};

// Keep-alive slot: child transcripts stay mounted while hidden.
export function AgentTranscriptStack({ tabs, activeId }: StackProps) {
  const agentTabs = tabs.filter(
    (t): t is AgentTranscriptTab => t.kind === "agent-transcript",
  );
  if (agentTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {agentTabs.map((t) => (
        <div
          key={t.id}
          aria-hidden={t.id !== activeId}
          inert={t.id !== activeId}
          data-uat="child-tab"
          data-uat-key={String(t.id)}
          className={cn(
            "absolute inset-0",
            t.id !== activeId && "invisible pointer-events-none",
          )}
        >
          <AgentTranscriptPane path={t.path} />
        </div>
      ))}
    </div>
  );
}

// A child runs inside the parent pi process: there is no RPC handle to answer
// its ask cards from here, so interactions stay local to the transcript view.
export function AgentTranscriptPane({ path }: { path: string }) {
  const state = useChildStore((s) => s.children[path]);
  const recordedOwner = useChildStore((s) => s.owners[path]);
  const error = useChildStore((s) => s.errors[path]);
  const tabs = usePiStore((s) => s.tabs);
  const sessions = useLedgerStore((s) => s.sessions);
  const owner = findChildOwner(path, tabs, sessions, recordedOwner);
  useEffect(() => { void loadChildTranscript(path); }, [path]);
  const button = "shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-accent hover:text-foreground disabled:opacity-50";
  return (
    <div
      data-uat="child-transcript"
      data-uat-key={path}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">pi child</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{path}</span>
        <button type="button" data-uat="child-return-chat" aria-label="Return to chat" disabled={!owner} title={owner ? undefined : "Owning chat tab unavailable"} className={button} onClick={() => { if (owner) navigateChild(owner, false); }}>Return to chat</button>
        <button type="button" data-uat="child-open-ticket" aria-label="Open ticket" disabled={!owner?.ticketId} title={owner?.ticketId ? undefined : "The delegation record has no ticketId"} className={button} onClick={() => { if (owner?.ticketId) navigateChild(owner, true); }}>Open ticket</button>
      </div>
      {error ? <ErrorCard block={{ kind: "error", text: error, at: 0 }} /> : null}
      <Transcript
        blocks={state?.blocks ?? []}
        cwd={owner?.cwd}
        sessionId={state?.sessionId}
        inFlight={!!state && ["thinking", "tool", "awaiting-ask"].includes(state.status)}
        emptyHint="Waiting for transcript lines..."
        onAnswer={(_requestId: string, _answers: PiAskAnswer[]) => {}}
        onDismiss={(_requestId: string) => {}}
      />
    </div>
  );
}
