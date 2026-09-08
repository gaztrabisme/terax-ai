import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowUp01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type RailPaneProps = {
  title: string;
  /** Whether the pane is currently collapsed (its panel has zero size). */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Opens the pane as a full tab; omit to hide the button. */
  onExpand?: () => void;
  children: ReactNode;
};

/** Canonical UAT ids for the current rail panes, keyed by pane title. The
 *  artifact pane has no open-as-tab button, so it names no open-tab id. */
const RAIL_UAT_IDS: Record<
  string,
  { pane: string; openTab?: string; expand?: string }
> = {
  "Run graph": {
    pane: "graph-pane",
    openTab: "graph-open-tab",
    expand: "graph-expand-current",
  },
  Board: {
    pane: "board-pane",
    openTab: "board-open-tab",
    expand: "board-expand-current",
  },
  Sessions: {
    pane: "sessions-pane",
    openTab: "sessions-open-tab",
    expand: "sessions-expand-current",
  },
  Artifact: { pane: "artifact-pane" },
};

/**
 * Chrome around a rail pane: a 28px header with the pane title, a collapse
 * toggle and an "open as tab" expand button. The body fills the rest.
 */
export function RailPane({
  title,
  collapsed,
  onToggleCollapse,
  onExpand,
  children,
}: RailPaneProps) {
  const uatIds = RAIL_UAT_IDS[title];
  return (
    <div
      data-uat={uatIds?.pane}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card"
    >
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border/60 ps-2 pe-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {title}
        </span>
        {onExpand && (
          <button
            type="button"
            title={`Open ${title} in tab`}
            aria-label={`Open ${title} in tab`}
            data-uat={uatIds?.openTab}
            onClick={onExpand}
            className={cn(
              "rounded p-0.5 text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={ArrowExpand01Icon} size={12} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          data-uat={uatIds?.expand}
          onClick={onToggleCollapse}
          className={cn(
            "rounded p-0.5 text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
          )}
        >
          <HugeiconsIcon
            icon={collapsed ? ArrowDown01Icon : ArrowUp01Icon}
            size={12}
            strokeWidth={2}
          />
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
