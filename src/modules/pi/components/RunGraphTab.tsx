import { cn } from "@/lib/utils";
import type { RunGraphTab as RunGraphTabData, Tab } from "@/modules/tabs";
import { RunGraph } from "./RunGraph";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenChild: (path: string) => void;
};

// Keep-alive slot, mirroring PiStack: run-graph tabs stay mounted while hidden.
export function RunGraphTabStack({ tabs, activeId, onOpenChild }: Props) {
  const graphs = tabs.filter(
    (t): t is RunGraphTabData => t.kind === "run-graph",
  );
  if (graphs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {graphs.map((t) => (
        <div
          key={t.id}
          aria-hidden={t.id !== activeId}
          className={cn(
            "absolute inset-0",
            t.id !== activeId &&
              "invisible pointer-events-none [&_.react-flow__node]:invisible!",
          )}
        >
          <RunGraph tabId={t.piTabId} onOpenChild={onOpenChild} />
        </div>
      ))}
    </div>
  );
}
