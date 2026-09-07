import { useEffect, useId, useState } from "react";
import type { PiPartRendererProps } from "./registry";

// Lazy boundary: mermaid (~178 kB gzip) only loads when a mermaid block first
// renders, keeping it out of the entry chunk entirely.
export function MermaidRenderer({ part }: PiPartRendererProps) {
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const code = part.text ?? "";

  useEffect(() => {
    if (!code.trim()) return;
    let alive = true;
    void import("mermaid")
      .then(async (mod) => {
        const mermaid = mod.default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const { svg: rendered } = await mermaid.render(
          `pi-mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`,
          code,
        );
        if (alive) setSvg(rendered);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <pre className="my-1 overflow-x-auto rounded bg-accent/40 p-2 font-mono text-xs text-destructive">
        {code}
      </pre>
    );
  }
  if (svg === null) {
    return (
      <pre className="my-1 overflow-x-auto rounded bg-accent/40 p-2 font-mono text-xs text-muted-foreground">
        {code}
      </pre>
    );
  }
  return (
    <div
      className="my-1 overflow-x-auto rounded bg-background p-2"
      // mermaid.render output for trusted diagram sources under strict mode.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
