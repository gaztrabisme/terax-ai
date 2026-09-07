import {
  DEFAULT_PREFERENCES,
} from "@/modules/settings/store";
import { z } from "zod";

/** Mirrors the PiRuntimePrefs thinking levels in providers.ts. */
export const piThinkingSchema = z.enum([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/**
 * Terax-side pi module preferences. Defaults derive from the global
 * preferences store so the Settings "Pi" tab and the pi tabs edit one source
 * of truth; pi-side runtime config lives in the agent dir.
 */
export const piModulePrefsSchema = z.object({
  launchMode: z.enum(["auto", "launcher", "direct"]).default("auto"),
  draftDir: z.string().default(".pi/drafts"),
  /** Dir holding bin/efficient-pi (or bin/pi); a leading $HOME/ expands Rust-side from HOME. */
  launcherDir: z.string().default(DEFAULT_PREFERENCES.piLauncherDir),
  /** pi agent dir; empty lets the launcher's PI_CODING_AGENT_DIR default apply. */
  defaultAgentDir: z.string().default(DEFAULT_PREFERENCES.piAgentDir),
  /** Path to the efficient-pi board CLI (same one board.mjs uses); a leading $HOME/ expands in the shell. */
  boardBin: z.string().default(DEFAULT_PREFERENCES.piBoardBin),
  /** Harness agent binary for human keystone board actions; expands in the shell. */
  agentBin: z.string().default(DEFAULT_PREFERENCES.piAgentBin),
  provider: z.string().default(DEFAULT_PREFERENCES.piProvider),
  model: z.string().default(DEFAULT_PREFERENCES.piModel),
  thinking: piThinkingSchema.default(DEFAULT_PREFERENCES.piThinking),
  /** Subagent model as provider/model with an optional :thinking suffix. */
  smol: z.string().default(DEFAULT_PREFERENCES.piSmol),
});

export type PiSettingsSection = z.infer<typeof piModulePrefsSchema>;

export const PI_MODULE_PREFS_DEFAULTS: PiSettingsSection =
  piModulePrefsSchema.parse({});
