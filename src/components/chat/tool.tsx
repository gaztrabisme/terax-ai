"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ToolsIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps, ReactNode } from "react";
import { memo } from "react";
import type { ToolPart } from "./types";

const STATUS_DOT: Record<ToolPart["state"], string> = {
  running: "bg-amber-500",
  done: "bg-transparent border border-muted-foreground/40",
  error: "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  running: "running",
  done: "done",
  error: "error",
};

// Generic summary for the collapsed header: pull the first identifying
// string field out of the tool input, whatever the tool schema is.
function deriveSummary(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  for (const key of ["path", "command", "pattern", "query", "url", "task"]) {
    const v = i[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: string;
  errorText?: string;
};

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const summary = deriveSummary(input);
  const isError = state === "error";
  const open = defaultOpen ?? isError;
  const showInputBody = Boolean(input);
  const showOutputBody = typeof output === "string";
  const hasDetails = showInputBody || showOutputBody || Boolean(errorText);

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={ToolsIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{toolName}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="shrink-0 text-xs font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent className={cn("terax-collapsible-content")}>
          <div className="ml-3 mt-1 space-y-2 border-l border-border/60 pb-1 pl-3">
            {showInputBody ? <ToolInput input={input} /> : null}
            {showOutputBody || errorText ? (
              <ToolOutput output={showOutputBody ? output : undefined} errorText={errorText} />
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// Only a state transition or a change of the derived summary should trigger
// a re-render — not every streamed input token.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  return deriveSummary(a.input) === deriveSummary(b.input);
});

export function ToolInput({ input }: { input: unknown }) {
  if (input == null) return null;
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">Input</div>
      <CodeBlockMini
        code={typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        language="json"
      />
    </div>
  );
}

function ToolOutput({
  output,
  errorText,
}: {
  output?: string;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium text-destructive">Error</div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-destructive">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else {
    body = <div className="text-[12px]">{String(output)}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">
        Output
      </div>
      {body}
    </div>
  );
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Tool input/output is debug-grade detail — JSON arrives pre-formatted and
  // file content is shown in the editor diff. Highlighting here is not worth
  // the parser hop.
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
      {code}
    </pre>
  );
}

// Compatibility export — the previous API exposed this subcomponent.
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
