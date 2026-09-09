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
 * Everything the launch decision needs, resolved by the caller before asking.
 * The exists/authorized answers describe the recorded lastProject, because
 * that is the only path whose recovery depends on them.
 */
export type LaunchInput = {
  /** True when the process was started with the `--pi` flag. */
  piFlag: boolean;
  /** Explicit positional directory argument, null when there was none. */
  explicitDir: string | null;
  /** Workspace fallback cwd (the home directory on a dock launch). */
  fallbackDir: string | null;
  lastProject: string | null;
  lastProjectExists: boolean;
  lastProjectAuthorized: boolean;
};

export type LaunchPlan =
  /** Open chat on the project. keepInitialShell says whether the terminal
   *  tab seeded from the launch directory stays (explicit dir or --pi
   *  launch); a dock recovery drops it so no home shell survives. */
  | { action: "chat"; project: string; keepInitialShell: boolean }
  /** Show the folder picker, naming the missing path when one was recorded. */
  | { action: "picker"; missingPath: string | null }
  /** Terminal-first launch: keep the seeded shell, no chat recovery. */
  | { action: "shell" };

/**
 * Decides what a launch opens, covering the explicit `--pi` path, a plain
 * folder launch and the no-argument dock launch in one place. An explicit
 * project argument always wins. A positional dir without `--pi` stays a
 * terminal-first launch and is never hijacked by recovery. Only a launch
 * with neither consults the recorded last project, and then through
 * chooseStartupProject (design.md 3.1, the launch transition row, and 3.4's
 * project-registry paragraph).
 */
export function planLaunch(input: LaunchInput): LaunchPlan {
  if (input.piFlag) {
    const project = input.explicitDir ?? input.fallbackDir;
    return project
      ? { action: "chat", project, keepInitialShell: true }
      : { action: "shell" };
  }
  if (input.explicitDir) return { action: "shell" };
  const decision = chooseStartupProject(
    { lastProject: input.lastProject },
    () => input.lastProjectExists,
    () => input.lastProjectAuthorized,
  );
  if (decision.action === "open") {
    return {
      action: "chat",
      project: decision.path,
      keepInitialShell: false,
    };
  }
  return { action: "picker", missingPath: decision.missingPath };
}

/** One shell mutation a decided launch performs, in order. App.tsx executes
 *  exactly these; keeping the mapping pure makes the whole launch verifiable
 *  without mounting the shell. */
export type LaunchEffect =
  /** Open a chat tab on the project and select it. */
  | { kind: "open-chat"; project: string }
  /** Close the terminal tab seeded from the launch directory, unseen. */
  | { kind: "close-initial-shell" }
  /** Reveal the seeded terminal tab: a terminal-first launch happened. */
  | { kind: "reveal-initial-shell" }
  /** Stand the folder picker up, naming the missing path when one exists. */
  | { kind: "show-picker"; missingPath: string | null };

/**
 * Turns a launch plan into the ordered shell effects App.tsx runs. A chat
 * plan opens the tab first and then either keeps the seeded shell (explicit
 * dir and --pi launches) or closes it before it was ever shown (dock
 * recovery); a picker plan only stands the overlay; a shell plan only
 * reveals the seeded tab.
 */
export function launchEffects(plan: LaunchPlan): LaunchEffect[] {
  switch (plan.action) {
    case "chat":
      return [
        { kind: "open-chat", project: plan.project },
        plan.keepInitialShell
          ? { kind: "reveal-initial-shell" }
          : { kind: "close-initial-shell" },
      ];
    case "picker":
      return [{ kind: "show-picker", missingPath: plan.missingPath }];
    case "shell":
      return [{ kind: "reveal-initial-shell" }];
  }
}

/**
 * Section 3.1's sidebar startup transition: a new app process and every chat
 * launch or reopened chat tab start with the sidebar collapsed. Only
 * creation events consult this; a switch between still-open tabs passes the
 * current visibility through untouched, and nothing restores a saved flag.
 */
export function sidebarCollapsedAfter(
  event: "launch" | "chat-open" | "tab-switch",
  collapsedNow: boolean,
): boolean {
  return event === "tab-switch" ? collapsedNow : true;
}

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
