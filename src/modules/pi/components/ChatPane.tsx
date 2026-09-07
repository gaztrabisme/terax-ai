import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
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
// session lifecycle beyond the header buttons; PiTab opens the session and
// the layout owns the tab.
export function ChatPane({ tabId, cwd, onOpenChild }: Props) {
  const entry = usePiStore((s) => s.tabs[tabId]);
  const sendPrompt = usePiStore((s) => s.sendPrompt);
  const answerAsk = usePiStore((s) => s.answerAsk);
  const dismissAsk = usePiStore((s) => s.dismissAsk);
  const kill = usePiStore((s) => s.kill);
  const close = usePiStore((s) => s.close);
  const openSession = usePiStore((s) => s.openSession);
  const [sendError, setSendError] = useState<string | null>(null);

  const blocks = entry?.state.blocks ?? [];
  const state = entry?.state;
  const status = state?.status ?? "idle";
  const exited = entry?.exited === true;
  // Stop only while the session is actively working; New session takes over
  // once the run is done, nothing is busy, or the process exited. The two are
  // mutually exclusive, so a done-but-alive session no longer shows both.
  const showStop =
    !exited &&
    (status === "thinking" || status === "tool" || status === "awaiting-ask");
  const showNew = exited || status === "done" || status === "idle";

  // Best-known model for the composer chip: the store's resolved roles win;
  // the last assistant message is the fallback while roles.model is empty.
  const model = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.kind === "message" && block.role === "assistant" && block.model) {
        return block.model;
      }
    }
    return null;
  }, [blocks]);
  const roles = entry?.roles;
  const chipModel = roles?.model || model;

  const submit = (markdown: string) => {
    if (!entry?.session || entry.exited) return;
    setSendError(null);
    sendPrompt(tabId, markdown).catch((e) => {
      setSendError(e instanceof Error ? e.message : String(e));
    });
  };

  const newSession = () => {
    setSendError(null);
    close(tabId);
    void openSession(tabId, { cwd });
  };

  const headerBtn =
    "rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-accent hover:text-foreground";

  return (
    <div
      data-pi-model={chipModel ?? undefined}
      data-pi-smol={roles?.smol || undefined}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            exited
              ? "bg-destructive"
              : status === "awaiting-ask"
                ? "bg-yellow-500"
                : showStop
                  ? "animate-pulse bg-blue-500"
                  : "bg-muted-foreground/40",
          )}
        />
        <span className="font-medium text-foreground">pi</span>
        <span>
          {statusLabel(
            status,
            exited,
            entry?.exitCode ?? null,
          )}
        </span>
        {state?.tokens ? (
          <span>{state.tokens.totalTokens.toLocaleString()} tok</span>
        ) : null}
        <span className="flex-1" />
        {showStop ? (
          <button
            type="button"
            onClick={() => void kill(tabId)}
            className={headerBtn}
          >
            Stop
          </button>
        ) : null}
        {showNew ? (
          <button type="button" onClick={newSession} className={headerBtn}>
            New session
          </button>
        ) : null}
      </div>

      {entry?.error ? (
        <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {entry.error}
        </div>
      ) : null}
      {sendError ? (
        <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {sendError}
        </div>
      ) : null}

      <Transcript
        blocks={blocks}
        onAnswer={(requestId, answers) =>
          void answerAsk(tabId, requestId, answers)
        }
        onDismiss={(requestId) => void dismissAsk(tabId, requestId)}
        cwd={cwd}
        onOpenChild={onOpenChild}
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
