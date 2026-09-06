import type { ComponentType, LazyExoticComponent } from "react";
import type { ZodType } from "zod";
import type { PiToolBlock } from "./parse";
import type { PiSettingsSection } from "./settingsSchema";

export type PiResultRendererProps = { block: PiToolBlock };

export type PiNodeBadge = { text: string; tone: "ok" | "warn" | "err" };

export type PiPanelManifest = {
  /** matches toolName on tool_execution_* events */
  toolName: string;
  /** result-content renderer; lazy so heavy deps stay out of the main chunk */
  renderer:
    | LazyExoticComponent<ComponentType<PiResultRendererProps>>
    | ComponentType<PiResultRendererProps>;
  /** schema-driven settings section rendered in the Settings window */
  settingsSchema?: ZodType<PiSettingsSection>;
  settingsDefaults?: PiSettingsSection;
  /** run-graph node badge (phase 2) */
  nodeBadge?: (block: PiToolBlock) => PiNodeBadge | null;
};
