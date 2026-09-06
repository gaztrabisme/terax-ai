import { cn } from "@/lib/utils";
import type { AgentTranscriptTab, Tab } from "@/modules/tabs";
import type { PiAskAnswer } from "@/modules/pi/lib/parse";
import { useChildStore } from "@/modules/pi/lib/childStore";
import { Transcript } from "./Transcript";

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
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">pi child</span>
        <span className="truncate font-mono text-[10px]">{path}</span>
      </div>
      <Transcript
        blocks={state?.blocks ?? []}
        emptyHint="Waiting for transcript lines..."
        onAnswer={(_requestId: string, _answers: PiAskAnswer[]) => {}}
        onDismiss={(_requestId: string) => {}}
      />
    </div>
  );
}
