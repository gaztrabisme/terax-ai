import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  BotIcon,
  CancelCircleIcon,
  ChatQuestionIcon,
  CheckmarkCircle01Icon,
  CircuitBoardIcon,
  FileIcon,
  Loading03Icon,
  PencilEdit01Icon,
  Search01Icon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { PiToolBlock } from "@/modules/pi/lib/parse";
import { boardOp, isBoardTool } from "@/modules/pi/lib/turns";
import { panelForTool } from "../renderers/registry";

/** Icon by tool family; unknown tools fall back to the generic wrench. */
export function toolFamilyIcon(toolName: string) {
  if (/^(bash|sh|shell|zsh|powershell|cmd)$/.test(toolName)) {
    return TerminalIcon;
  }
  if (toolName === "read") return FileIcon;
  if (/^(write|edit|apply_patch|patch)$/.test(toolName)) {
    return PencilEdit01Icon;
  }
  if (/(search|grep|find|glob)/.test(toolName)) return Search01Icon;
  if (toolName.startsWith("board_")) return CircuitBoardIcon;
  if (toolName === "subagent") return BotIcon;
  if (toolName === "ask") return ChatQuestionIcon;
  return ToolsIcon;
}

/** First identifying string of the args, for the collapsed one-line summary. */
export function toolSummary(block: PiToolBlock): string {
  if (isBoardTool(block)) return boardOp(block.toolName);
  const args = block.args;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of [
      "command",
      "path",
      "file",
      "pattern",
      "query",
      "url",
      "task",
      "prompt",
      "message",
    ]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.replace(/\s+/g, " ").slice(0, 160);
      }
    }
  }
  const result = (block.resultText ?? block.partialText ?? "").trim();
  return (result.split("\n")[0] ?? "").replace(/\s+/g, " ").slice(0, 160);
}

function StatusMark({ status }: { status: PiToolBlock["status"] }) {
  if (status === "running") {
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 animate-spin text-blue-500"
        aria-label="running"
      />
    );
  }
  if (status === "error") {
    return (
      <HugeiconsIcon
        icon={CancelCircleIcon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-destructive"
        aria-label="error"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={CheckmarkCircle01Icon}
      size={13}
      strokeWidth={1.75}
      className="shrink-0 text-green-600"
      aria-label="done"
    />
  );
}

export type ToolRowProps = {
  block: PiToolBlock;
  defaultOpen?: boolean;
};

/**
 * One tool step in the turn timeline: icon by family, name, one-line summary
 * and status when folded; args and the result when expanded. Results go
 * through the renderer registry when a panel is registered for the tool,
 * otherwise they stay as plain mono text.
 */
export function ToolStep({ block, defaultOpen = false }: ToolRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = toolFamilyIcon(block.toolName);
  const PanelRenderer = panelForTool(block.toolName)?.renderer;
  return (
    <div
      data-uat="tool-row"
      data-uat-key={block.toolCallId}
      className="rounded-md border border-border/60"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] hover:bg-accent/40"
      >
        <StatusMark status={block.status} />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium">{block.toolName}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground",
            open && "hidden",
          )}
        >
          {toolSummary(block)}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={1.75}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border/60 px-2 py-2">
          {block.args != null ? (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                Args
              </div>
              <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                {JSON.stringify(block.args, null, 2)}
              </pre>
            </div>
          ) : null}
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              Result
            </div>
            {block.resultText !== null ? (
              PanelRenderer ? (
                <PanelRenderer block={block} />
              ) : (
                <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                  {block.resultText}
                </pre>
              )
            ) : (
              <div className="text-xs text-muted-foreground">running...</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Timeline rows render ToolStep; the old name stays as an alias. */
export const ToolRow = ToolStep;
