import { useEffect, useRef } from "react";
import type { PiAskAnswer, PiBlock } from "@/modules/pi/lib/parse";
import { AssistantBlock } from "./blocks/AssistantBlock";
import { KeystoneCard } from "./blocks/KeystoneCard";
import { ToolRow } from "./blocks/ToolRow";
import { UserBlock } from "./blocks/UserBlock";

type Props = {
  blocks: PiBlock[];
  onAnswer: (requestId: string, answers: PiAskAnswer[]) => void;
  onDismiss: (requestId: string) => void;
  emptyHint?: string;
};

// Source-agnostic: the parent feed comes from piStore, a child transcript
// from the child store. Callers wire their own store reads.
export function Transcript({
  blocks,
  onAnswer,
  onDismiss,
  emptyHint = "Session starting...",
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs"
    >
      {blocks.length === 0 ? (
        <div className="text-muted-foreground">{emptyHint}</div>
      ) : null}
      {blocks.map((block) => {
        if (block.kind === "message") {
          if (block.role === "user") {
            const text = block.parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
            return <UserBlock key={block.id} text={text} />;
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
            onAnswer={(answers) => onAnswer(block.requestId, answers)}
            onDismiss={() => onDismiss(block.requestId)}
          />
        );
      })}
    </div>
  );
}
