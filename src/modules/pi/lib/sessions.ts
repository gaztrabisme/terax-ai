import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { PiResolvedPaths } from "./providers";

/** One listed session, newest first from the Rust scan of the cwd's
 *  session directory (Rust twin: sessions.rs PiSessionSummary). */
export type PiSessionSummary = {
  path: string;
  startedAt: string;
  firstPrompt: string;
  /** User prompts: a user message opens the next turn in the fork's
   *  transcript grouping. */
  turns: number;
  /** Sum of assistant usage.totalTokens across the session. */
  tokens: number;
};

/** The first case-insensitive hit in one session's user and assistant text
 *  (Rust twin: sessions.rs PiSessionHit). */
export type PiSessionHit = {
  path: string;
  startedAt: string;
  role: "user" | "assistant";
  /** Up to 160 chars around the hit; "..." marks each cut edge. */
  snippet: string;
};

export function piSessionsList(
  cwd: string,
  agentDir: string,
): Promise<PiSessionSummary[]> {
  return invoke<PiSessionSummary[]>("pi_sessions_list", {
    cwd,
    agentDir,
    workspace: currentWorkspaceEnv(),
  });
}

export function piSessionsSearch(
  cwd: string,
  agentDir: string,
  query: string,
  limit = 20,
): Promise<PiSessionHit[]> {
  return invoke<PiSessionHit[]>("pi_sessions_search", {
    cwd,
    agentDir,
    query,
    limit,
    workspace: currentWorkspaceEnv(),
  });
}

/**
 * The runtime agent dir a pi session for this app actually runs from:
 * pi_paths resolves pref > bundled > checkout the same way pi_open does.
 * Returns null when no runtime dir is seeded yet.
 */
export async function resolveSessionsAgentDir(): Promise<string | null> {
  const p = usePreferencesStore.getState();
  const paths = await invoke<PiResolvedPaths>("pi_paths", {
    prefs: {
      piBin: "",
      agentBin: p.piAgentBin,
      agentDir: p.piAgentDir,
      launcherDir: p.piLauncherDir,
    },
  });
  return paths.runtimeAgentDir.path;
}
