import { MarkdownRenderer } from "../renderers/Markdown";
import type { PiMessageBlock } from "@/modules/pi/lib/parse";
import { ThinkingFold } from "./ThinkingFold";

export function AssistantBlock({ block }: { block: PiMessageBlock }) {
  const thinking = block.parts
    .filter((p) => p.type === "thinking")
    .map((p) => p.thinking)
    .join("");
  // toolCall parts are rendered as ToolRows from the execution events.
  const text = block.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  return (
    <div>
      <ThinkingFold thinking={thinking} />
      {text ? <MarkdownRenderer content={text} /> : null}
    </div>
  );
}
