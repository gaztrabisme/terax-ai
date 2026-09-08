import {
  FileCodeIcon,
  FolderTreeIcon,
  LayoutTwoColumnIcon,
  SearchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, type RefObject } from "react";
import { cn } from "@/lib/utils";
import {
  CHAT_VIEWS,
  MODE_STRIP_WIDTH,
  type ChatView,
} from "../lib/viewMachine";

export const VIEW_LABELS: Record<ChatView, string> = {
  board: "Board",
  graph: "Graph",
  sessions: "Sessions",
  artifact: "Artifact",
};

const VIEW_BUTTONS = {
  board: { id: "board-button", icon: LayoutTwoColumnIcon },
  graph: { id: "graph-button", icon: FolderTreeIcon },
  sessions: { id: "sessions-button", icon: SearchIcon },
  artifact: { id: "artifact-button", icon: FileCodeIcon },
};

export const viewButtonClass =
  "flex size-8 shrink-0 items-center justify-center rounded text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function ModeStrip({
  view,
  hasArtifact,
  boardCount,
  graphCount,
  buttons,
  onToggle,
}: {
  view: ChatView | null;
  hasArtifact: boolean;
  boardCount: number;
  graphCount: number;
  buttons: RefObject<Partial<Record<ChatView, HTMLButtonElement>>>;
  onToggle: (view: ChatView) => void;
}) {
  const badgeId = useId();
  return (
    <div
      data-uat="mode-strip"
      role="toolbar"
      aria-label="Chat views"
      aria-orientation="vertical"
      className="flex shrink-0 flex-col items-center border-l border-border/60 text-xs font-medium"
      style={{ width: MODE_STRIP_WIDTH }}
    >
      {CHAT_VIEWS.filter((name) => name !== "artifact" || hasArtifact).map(
        (name) => {
          const count =
            name === "board" ? boardCount : name === "graph" ? graphCount : 0;
          return (
            <button
              key={name}
              title={VIEW_LABELS[name]}
              ref={(button) => {
                if (button) buttons.current[name] = button;
                else delete buttons.current[name];
              }}
              type="button"
              data-uat={VIEW_BUTTONS[name].id}
              aria-label={VIEW_LABELS[name]}
              aria-pressed={view === name}
              aria-describedby={count > 0 ? `${badgeId}-${name}` : undefined}
              onClick={() => onToggle(name)}
              className={cn(
                viewButtonClass,
                "relative my-1",
                view === name && "bg-muted text-foreground",
              )}
            >
              <HugeiconsIcon
                icon={VIEW_BUTTONS[name].icon}
                size={16}
                strokeWidth={1.75}
              />
              {count > 0 && (
                <span
                  id={`${badgeId}-${name}`}
                  className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground"
                  aria-label={`${count} ${name === "board" ? "tickets awaiting a human decision" : "running children"}`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        },
      )}
    </div>
  );
}
