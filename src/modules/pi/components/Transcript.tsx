import { useEffect, useRef } from "react";
import type { PiAskAnswer } from "@/modules/pi/lib/parse";
import { usePiStore } from "@/modules/pi/lib/piStore";
import { AssistantBlock } from "./blocks/AssistantBlock";
import { KeystoneCard } from "./blocks/KeystoneCard";
import { ToolRow } from "./blocks/ToolRow";
import { UserBlock } from "./blocks/UserBlock";

export function Transcript({ tabId }: { tabId: number }) {
  const state = usePiStore((s) => s.tabs[tabId]?.state);
  const answerAsk = usePiStore((s) => s.answerAsk);
  const dismissAsk = usePiStore((s) => s.dismissAsk);
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocks = state?.blocks ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length]);

  // No fork path exists on the store yet; UserBlock renders its disabled
  // re-run with a tooltip until one lands.
  type WithFork = { fork?: (tabId: number, text: string) => Promise<void> };
  const fork = (usePiStore.getState() as unknown as WithFork).fork;

  const answer = (requestId: string) => (answers: PiAskAnswer[]) =>
    void answerAsk(tabId, requestId, answers);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs"
    >
      {blocks.length === 0 ? (
        <div className="text-muted-foreground">Session starting...</div>
      ) : null}
      {blocks.map((block) => {
        if (block.kind === "message") {
          if (block.role === "user") {
            const text = block.parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
            return (
              <UserBlock
                key={block.id}
                text={text}
                onRerun={
                  fork ? (t) => void fork(tabId, t).catch(() => {}) : undefined
                }
              />
            );
          }
          return <AssistantBlock key={block.id} block={block} />;
        }
        if (block.kind === "tool") {
          return <ToolRow key={block.toolCallId} block={block} />;
        }
        return (
          <KeystoneCard
            key={block.requestId}
            block={block}
            onAnswer={answer(block.requestId)}
            onDismiss={() => void dismissAsk(tabId, block.requestId)}
          />
        );
      })}
    </div>
  );
}
