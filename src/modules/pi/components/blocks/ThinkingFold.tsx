import { useState } from "react";

export function ThinkingFold({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  const trimmed = thinking.trim();
  if (!trimmed) return null;
  const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
  return (
    <div className="mb-1 text-[11px] italic text-muted-foreground/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded hover:text-foreground"
      >
        {open ? "thinking" : `thinking: ${preview}`}
      </button>
      {open ? <div className="whitespace-pre-wrap">{trimmed}</div> : null}
    </div>
  );
}
