import { cn } from "@/lib/utils";
import { useState } from "react";
import { usePiStore } from "../lib/piStore";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

type Props = {
  tabId: number;
  cwd?: string;
  onOpenChild: (path: string) => void;
};

function statusLabel(
  status: string,
  exited: boolean,
  exitCode: number | null,
): string {
  if (exited) return `exited (${exitCode ?? "signal"})`;
  switch (status) {
    case "idle":
      return "idle";
    case "thinking":
      return "thinking";
    case "tool":
      return "running tool";
    case "awaiting-ask":
      return "waiting for answer";
    case "done":
      return "done";
    default:
      return status;
  }
}

// The chat column of a pi tab: session header, transcript, composer. Owns no
// session lifecycle; PiTab opens and closes the session and the layout.
export function ChatPane({ tabId, cwd, onOpenChild: _onOpenChild }: Props) {
  const entry = usePiStore((s) => s.tabs[tabId]);
  const sendPrompt = usePiStore((s) => s.sendPrompt);
  const answerAsk = usePiStore((s) => s.answerAsk);
  const dismissAsk = usePiStore((s) => s.dismissAsk);
  const kill = usePiStore((s) => s.kill);
  const [sendError, setSendError] = useState<string | null>(null);

  const blocks = entry?.state.blocks ?? [];
  const state = entry?.state;
  const busy = state?.status === "thinking" || state?.status === "tool";

  const submit = (markdown: string) => {
    if (!entry?.session || entry.exited) return;
    setSendError(null);
    sendPrompt(tabId, markdown).catch((e) => {
      setSendError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            entry?.exited
              ? "bg-destructive"
              : state?.status === "awaiting-ask"
                ? "bg-yellow-500"
                : busy
                  ? "animate-pulse bg-blue-500"
                  : "bg-muted-foreground/40",
          )}
        />
        <span className="font-medium text-foreground">pi</span>
        <span>
          {statusLabel(
            state?.status ?? "idle",
            entry?.exited ?? false,
            entry?.exitCode ?? null,
          )}
        </span>
        {state?.sessionId ? (
          <span className="truncate font-mono text-[10px]">
            {state.sessionId.slice(0, 8)}
          </span>
        ) : null}
        {state?.tokens ? (
          <span>{state.tokens.totalTokens.toLocaleString()} tok</span>
        ) : null}
        <span className="flex-1" />
        {!entry?.exited && entry?.session ? (
          <button
            type="button"
            onClick={() => void kill(tabId)}
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
          >
            Kill
          </button>
        ) : null}
      </div>

      {entry?.error ? (
        <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {entry.error}
        </div>
      ) : null}
      {sendError ? (
        <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {sendError}
        </div>
      ) : null}

      <Transcript
        blocks={blocks}
        onAnswer={(requestId, answers) =>
          void answerAsk(tabId, requestId, answers)
        }
        onDismiss={(requestId) => void dismissAsk(tabId, requestId)}
      />

      <Composer
        tabId={tabId}
        cwd={cwd}
        disabled={!entry?.session || entry.exited}
        placeholder={
          entry?.session
            ? "Message pi (markdown, Enter sends)"
            : entry?.exited
              ? "Session exited"
              : "Waiting for pi..."
        }
        onSubmit={submit}
      />
    </div>
  );
}
