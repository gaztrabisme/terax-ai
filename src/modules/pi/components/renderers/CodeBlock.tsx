import { useState } from "react";
import type { PiPartRendererProps } from "./registry";

export function CodeBlockRenderer({ part, language }: PiPartRendererProps) {
  const [copied, setCopied] = useState(false);
  const code = part.text ?? "";
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="group relative my-1 overflow-x-auto rounded bg-accent/40">
      <div className="flex items-center justify-between px-2 pt-1 text-[10px] text-muted-foreground">
        <span>{language ?? "code"}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-1 hover:bg-accent hover:text-foreground"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="p-2 pt-0.5 font-mono text-[11px]">{code}</pre>
    </div>
  );
}
