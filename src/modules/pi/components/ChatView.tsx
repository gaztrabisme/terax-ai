import {
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import {
  maxPanelWidth,
  MIN_PANEL_WIDTH,
  panelWidth,
  type ChatView as View,
  type ViewMode,
} from "../lib/viewMachine";
import { VIEW_LABELS, viewButtonClass } from "./ModeStrip";

const VIEW_IDS = {
  board: { panel: "board-panel", fullscreen: "board-fullscreen" },
  graph: { panel: "graph-panel", fullscreen: "graph-fullscreen" },
  sessions: {
    popover: "sessions-popover",
    panel: "sessions-panel",
    fullscreen: "sessions-fullscreen",
  },
  artifact: { panel: "artifact-panel", fullscreen: "artifact-fullscreen" },
};

export function ChatView({
  view,
  mode,
  width,
  contentWidth,
  popoverTop,
  viewRef,
  onClose,
  onBack,
  onFullscreen,
  onExpand,
  onOpenTab,
  onWidthCommit,
  children,
}: {
  view: View;
  mode: ViewMode;
  width: number;
  contentWidth: number;
  popoverTop: number;
  viewRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onBack: () => void;
  onFullscreen: () => void;
  onExpand: () => void;
  onOpenTab?: () => void;
  onWidthCommit: (width: number) => void;
  children: ReactNode;
}) {
  const title = VIEW_LABELS[view];
  const drag = useRef<{ x: number; start: number; width: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const visibleWidth = panelWidth(preview ?? width, contentWidth);
  return (
    <section
      ref={viewRef}
      data-uat={
        mode === "popover" ? VIEW_IDS.sessions.popover : VIEW_IDS[view][mode]
      }
      data-uat-key={view}
      data-mode={mode}
      aria-label={title}
      tabIndex={-1}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col bg-card text-xs font-medium outline-none",
        mode === "panel" && "shrink-0 border-l border-border/60",
        mode === "fullscreen" && "flex-1",
        mode === "popover" &&
          "absolute right-12 z-30 rounded-lg border border-border/60 shadow-lg",
      )}
      style={
        mode === "popover"
          ? { width: 360, top: popoverTop, bottom: 8 }
          : mode === "panel"
            ? { width: visibleWidth }
            : undefined
      }
    >
      {mode === "panel" && (
        <div
          data-uat="panel-resize"
          data-uat-key={view}
          role="separator"
          aria-label={`Resize ${title} panel`}
          aria-orientation="vertical"
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={Math.round(maxPanelWidth(contentWidth))}
          aria-valuenow={Math.round(visibleWidth)}
          tabIndex={0}
          className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            onWidthCommit(
              panelWidth(
                visibleWidth + (e.key === "ArrowLeft" ? 16 : -16),
                contentWidth,
              ),
            );
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              x: e.clientX,
              start: visibleWidth,
              width: visibleWidth,
            };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            drag.current.width = panelWidth(
              drag.current.start + drag.current.x - e.clientX,
              contentWidth,
            );
            setPreview(drag.current.width);
          }}
          onPointerUp={() => {
            if (drag.current) onWidthCommit(drag.current.width);
            drag.current = null;
            setPreview(null);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setPreview(null);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setPreview(null);
          }}
        />
      )}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-2 text-xs font-medium">
        {mode === "fullscreen" && (
          <button
            type="button"
            data-uat="view-back"
            data-uat-key={view}
            aria-label="Back"
            title="Back"
            onClick={onBack}
            className={viewButtonClass}
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              size={16}
              strokeWidth={1.75}
            />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {onOpenTab && (
          <button
            type="button"
            aria-label={`Open ${title} in tab`}
            title={`Open ${title} in tab`}
            onClick={onOpenTab}
            className={cn(viewButtonClass, "w-auto px-2")}
          >
            Open in tab
          </button>
        )}
        {mode === "popover" && (
          <button
            type="button"
            data-uat="sessions-expand"
            aria-label="Expand Sessions"
            title="Expand Sessions"
            onClick={onExpand}
            className={viewButtonClass}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={16}
              strokeWidth={1.75}
            />
          </button>
        )}
        {mode !== "fullscreen" && (
          <button
            type="button"
            data-uat="view-fullscreen"
            data-uat-key={view}
            aria-label={`Full screen ${title}`}
            title={`Full screen ${title}`}
            onClick={onFullscreen}
            className={viewButtonClass}
          >
            <HugeiconsIcon
              icon={ArrowExpand01Icon}
              size={16}
              strokeWidth={1.75}
            />
          </button>
        )}
        <button
          type="button"
          data-uat="view-close"
          data-uat-key={view}
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
          onClick={onClose}
          className={viewButtonClass}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.75} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden font-normal">
        {children}
      </div>
    </section>
  );
}
