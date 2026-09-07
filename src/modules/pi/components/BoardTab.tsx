import { cn } from "@/lib/utils";
import type { BoardTab as BoardTabData, Tab } from "@/modules/tabs";
import { BoardView } from "./BoardPane";

// Keep-alive slot, mirroring PiStack: board tabs stay mounted while hidden.
export function BoardTabStack({
  tabs,
  activeId,
}: {
  tabs: Tab[];
  activeId: number;
}) {
  const boards = tabs.filter((t): t is BoardTabData => t.kind === "board");
  if (boards.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {boards.map((t) => (
        <div
          key={t.id}
          aria-hidden={t.id !== activeId}
          className={cn(
            "absolute inset-0",
            t.id !== activeId && "invisible pointer-events-none",
          )}
        >
          <BoardView cwd={t.cwd} mode="full" />
        </div>
      ))}
    </div>
  );
}
