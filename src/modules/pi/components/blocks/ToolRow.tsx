import { cn } from "@/lib/utils";
import { useState } from "react";
import type { PiToolBlock } from "@/modules/pi/lib/parse";
import { panelForTool, rendererForPart } from "../renderers/registry";

type Props = {
  block: PiToolBlock;
  defaultOpen?: boolean;
};

// Per-call token usage does not exist on pi's tool events (R2 trap 2b), so
// the folded row shows a chars/4 estimate of the visible result text.
export function tokenEstimate(text: string | null): number {
  return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
}

export function ToolRow({ block, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const visible = block.resultText ?? block.partialText ?? "";
  const panel = panelForTool(block.toolName);
  const PanelRenderer = panel?.renderer;
  const PartRenderer = rendererForPart("text");
  return (
    <div className="rounded-md border border-border/60 font-mono text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-accent/40"
      >
        <span
          className={cn(
            block.status === "running" && "text-blue-500",
            block.status === "done" && "text-green-600",
            block.status === "error" && "text-destructive",
          )}
        >
          {block.status === "running"
            ? "..."
            : block.status === "done"
              ? "ok"
              : "err"}
        </span>
        <span className="font-medium">{block.toolName}</span>
        <span className="flex-1 truncate text-muted-foreground">
          {open ? "" : visible.trim().replace(/\s+/g, " ").slice(0, 120)}
        </span>
        <span className="shrink-0 text-muted-foreground">
          ~{tokenEstimate(visible)} tok
        </span>
        <span className="shrink-0 text-muted-foreground">
          {open ? "-" : "+"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-2 py-1.5">
          <div className="mb-1 text-[10px] text-muted-foreground">
            args: {JSON.stringify(block.args)}
          </div>
          {block.resultText !== null ? (
            <>
              <pre className="overflow-x-auto whitespace-pre-wrap">
                {block.resultText}
              </pre>
              {PanelRenderer ? (
                <PanelRenderer block={block} />
              ) : (
                <PartRenderer part={{ type: "text", text: block.resultText }} />
              )}
            </>
          ) : (
            <div className="text-muted-foreground">running...</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
