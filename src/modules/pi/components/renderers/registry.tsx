import type { ComponentType } from "react";
import type { PiResultPart, PiToolBlock } from "@/modules/pi/lib/parse";
import type { PiPanelManifest } from "@/modules/pi/lib/manifest";
import { MarkdownRenderer } from "./Markdown";
import { CodeBlockRenderer } from "./CodeBlock";
import { TableCsvRenderer } from "./TableCsv";
import { ImageRenderer } from "./Image";
import { MermaidRenderer } from "./Mermaid";

export type PiPartRendererProps = {
  part: PiResultPart;
  language?: string | null;
};

export type PiPartRenderer = ComponentType<PiPartRendererProps>;

// Per-tool manifests (R6 PiPanelManifest): a tool contributes one entry, no
// core edits. Empty until tools register; phase 2 fills it.
const panels = new Map<string, PiPanelManifest>();

export function registerPiPanel(manifest: PiPanelManifest): () => void {
  panels.set(manifest.toolName, manifest);
  return () => {
    if (panels.get(manifest.toolName) === manifest) {
      panels.delete(manifest.toolName);
    }
  };
}

export function panelForTool(toolName: string): PiPanelManifest | null {
  return panels.get(toolName) ?? null;
}

const TextPartRenderer: PiPartRenderer = ({ part }) => (
  <MarkdownRenderer content={part.text ?? ""} />
);

const partRenderers: Record<string, PiPartRenderer> = {
  text: TextPartRenderer,
  code: CodeBlockRenderer,
  table: TableCsvRenderer,
  csv: TableCsvRenderer,
  image: ImageRenderer,
  mermaid: MermaidRenderer,
};

export function registerPartRenderer(
  type: string,
  renderer: PiPartRenderer,
): () => void {
  partRenderers[type] = renderer;
  return () => {
    if (partRenderers[type] === renderer) delete partRenderers[type];
  };
}

// Graceful fallback for unregistered content types and tools.
export const FallbackPartRenderer: PiPartRenderer = ({ part }) => (
  <div className="my-1 rounded border border-dashed border-border/60 px-2 py-1 text-xs text-muted-foreground">
    no renderer for content type "{part.type}"
  </div>
);

export function rendererForPart(type: string): PiPartRenderer {
  return partRenderers[type] ?? FallbackPartRenderer;
}

export const FallbackToolPanel: ComponentType<{ block: PiToolBlock }> = ({
  block,
}) => (
  <div className="my-1 rounded border border-dashed border-border/60 px-2 py-1 text-xs text-muted-foreground">
    no renderer registered for tool "{block.toolName}"
  </div>
);
