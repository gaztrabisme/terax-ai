import { z } from "zod";

/**
 * Terax-side pi module preferences. pi-side config lives in the agent dir and
 * is surfaced later; this schema is what a Settings section would edit.
 */
export const piModulePrefsSchema = z.object({
  launchMode: z.enum(["auto", "launcher", "direct"]).default("auto"),
  draftDir: z.string().default(".pi/drafts"),
  defaultAgentDir: z.string().default(""),
  /** Absolute path to the efficient-pi board CLI (same one board.mjs uses). */
  boardBin: z
    .string()
    .default("/Users/GaryT/Documents/Work/Lab/efficient-pi/bin/board"),
});

export type PiSettingsSection = z.infer<typeof piModulePrefsSchema>;

export const PI_MODULE_PREFS_DEFAULTS: PiSettingsSection =
  piModulePrefsSchema.parse({});
