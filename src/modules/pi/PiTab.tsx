import { cn } from "@/lib/utils";
import type { PiTab as PiTabData, Tab } from "@/modules/tabs";
import { useEffect, useRef, useState } from "react";
import { effectiveQuestionId } from "./lib/parse";
import type { PiAskBlock, PiBlock } from "./lib/parse";
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
  const answerAsk = usePiStore((s) => s.answerAsk);
  const dismissAsk = usePiStore((s) => s.dismissAsk);
  const kill = usePiStore((s) => s.kill);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void openSession(tabId, { cwd });
    return () => {
      usePiStore.getState().close(tabId);
    };
  }, [tabId, cwd, openSession]);

  const blocks = entry?.state.blocks ?? [];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !entry?.session || entry.exited) return;
    setSendError(null);
    setDraft("");
    sendPrompt(tabId, text).catch((e) => {
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

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs"
      >
        {entry?.error ? (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
            {entry.error}
          </div>
        ) : null}
        {sendError ? (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
            {sendError}
          </div>
        ) : null}
        {blocks.length === 0 && !entry?.error ? (
          <div className="text-muted-foreground">
            Session starting in {cwd ?? "workspace"}...
          </div>
        ) : null}
        {blocks.map((block) => (
          <BlockRow
            key={
              block.kind === "message"
                ? block.id
                : block.kind === "tool"
                  ? block.toolCallId
                  : block.requestId
            }
            block={block}
            onAnswer={(answers) =>
              void answerAsk(tabId, (block as PiAskBlock).requestId, answers)
            }
            onDismiss={() =>
              void dismissAsk(tabId, (block as PiAskBlock).requestId)
            }
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-border/60 p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              e.stopPropagation();
            }}
            disabled={!entry?.session || entry.exited}
            placeholder={
              entry?.session
                ? "Send a prompt to pi"
                : entry?.exited
                  ? "Session exited"
                  : "Waiting for pi..."
            }
            className="min-h-16 flex-1 resize-y rounded-md border border-border/60 bg-background p-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!entry?.session || entry.exited || !draft.trim()}
            className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function BlockRow({
  block,
  onAnswer,
  onDismiss,
}: {
  block: PiBlock;
  onAnswer: (answers: { questionId: string; selected: string[] }[]) => void;
  onDismiss: () => void;
}) {
  if (block.kind === "message") {
    const text = block.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    const thinking = block.parts
      .filter((p) => p.type === "thinking")
      .map((p) => p.thinking)
      .join("");
    if (block.role === "user") {
      return (
        <div className="rounded-md bg-accent/50 px-2 py-1.5">
          <div className="mb-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            you
          </div>
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
      );
    }
    return (
      <div>
        {thinking ? (
          <div className="mb-1 whitespace-pre-wrap italic text-muted-foreground/70">
            {thinking.trim()}
          </div>
        ) : null}
        <div className="whitespace-pre-wrap">{text}</div>
      </div>
    );
  }
  if (block.kind === "tool") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1 font-mono text-[11px]">
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
        <span className="truncate text-muted-foreground">
          {block.resultText?.trim() ?? block.partialText?.trim() ?? ""}
        </span>
      </div>
    );
  }
  return <AskCard block={block} onAnswer={onAnswer} onDismiss={onDismiss} />;
}

function AskCard({
  block,
  onAnswer,
  onDismiss,
}: {
  block: PiAskBlock;
  onAnswer: (answers: { questionId: string; selected: string[] }[]) => void;
  onDismiss: () => void;
}) {
  if (block.state !== "pending") {
    return (
      <div className="rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
        ask {block.state}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2">
      {block.questions.map((q, qi) => {
        const questionId = effectiveQuestionId(q, qi);
        return (
          <div key={questionId}>
            <div className="text-[11px] font-medium">
              {q.header ? `${q.header}: ` : ""}
              {q.question}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() =>
                    onAnswer([{ questionId, selected: [opt.label] }])
                  }
                  className={cn(
                    "rounded border border-border/60 px-2 py-0.5 hover:bg-accent hover:text-foreground",
                    q.recommended ===
                      q.options.findIndex((o) => o.label === opt.label) &&
                      "border-yellow-500/60 font-medium",
                  )}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={onDismiss}
                className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
