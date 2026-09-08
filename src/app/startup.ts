// K14 dock recovery: the pure decision behind a no-argument app start
// (design.md section 3.4, the paragraph on <app-config> and project
// references, and row R1.3). Preferences carry recentProjects and lastProject
// so a dock launch needs no project argument; a missing or unauthorized last
// project shows the folder picker, never another project's conversation.

export type StartupPrefs = {
  /** The project the app closed on; null when no session ever ran. */
  lastProject: string | null;
};

export type StartupDecision =
  /** Open the recovered project (it exists and is authorized). */
  | { action: "open"; path: string }
  /** No project to recover, or the recorded one is missing or unauthorized:
   *  show the picker and name the missing path when there is one. */
  | { action: "picker"; missingPath: string | null };

/**
 * Decides what a launch with no project argument opens. A blank lastProject
 * counts as absent; a recorded path must both exist and be authorized before
 * it reopens, so a stale entry can never put another project's conversation
 * on screen. Pure over its inputs: callers resolve exists/authorized first
 * and pass the answers as predicates.
 */
export function chooseStartupProject(
  prefs: StartupPrefs,
  exists: (path: string) => boolean,
  authorized: (path: string) => boolean,
): StartupDecision {
  const last = prefs.lastProject?.trim() ? prefs.lastProject : null;
  if (!last) return { action: "picker", missingPath: null };
  if (!exists(last) || !authorized(last)) {
    return { action: "picker", missingPath: last };
  }
  return { action: "open", path: last };
}
