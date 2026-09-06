import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { Transcript } from "./components/Transcript";
import { usePiStore } from "./lib/piStore";

type StackProps = {
  tabs: Tab[];
  activeId: number;
};

// Keep-alive slot: every pi tab stays mounted while hidden so the RPC
// stream keeps filling the store when the user is on another tab.
export function PiStack({ tabs, activeId }: StackProps) {
  const pis = tabs.filter((t): t is PiTabData => t.kind === "pi");
  if (pis.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {pis.map((t) => (
        <div
          key={t.id}
          aria-hidden={t.id !== activeId}
          className={cn(
            "absolute inset-0",
            t.id !== activeId && "invisible pointer-events-none",
          )}
        >
          <PiTab tabId={t.id} cwd={t.cwd} />
        </div>
      ))}
    </div>
  );
}

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

export function PiTab({ tabId, cwd }: { tabId: number; cwd?: string }) {
  const entry = usePiStore((s) => s.tabs[tabId]);
  const openSession = usePiStore((s) => s.openSession);
  const sendPrompt = usePiStore((s) => s.sendPrompt);
  const kill = usePiStore((s) => s.kill);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    void openSession(tabId, { cwd });
    return () => {
      usePiStore.getState().close(tabId);
    };
  }, [tabId, cwd, openSession]);

  const submit = (markdown: string) => {
    if (!entry?.session || entry.exited) return;
    setSendError(null);
    sendPrompt(tabId, markdown).catch((e) => {
      setSendError(e instanceof Error ? e.message : String(e));
    });
  };

  const state = entry?.state;
  const busy = state?.status === "thinking" || state?.status === "tool";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
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

      <Transcript tabId={tabId} />

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
