// K14 dock recovery: the pure decision behind a no-argument launch (design.md
// row R1.3 and the TUESDAY T1 row). A recorded last project reopens only when
// it both exists and is authorized; anything else shows the folder picker.

import { describe, expect, it } from "vitest";

import {
  chooseStartupProject,
  launchEffects,
  type LaunchInput,
  planLaunch,
  sidebarCollapsedAfter,
} from "./startup";

const exists = (paths: string[]) => (path: string) => paths.includes(path);
const yes = () => true;
const no = () => false;

describe("chooseStartupProject", () => {
  it("opens the last project when it exists and is authorized", () => {
    const decision = chooseStartupProject(
      { lastProject: "/proj/a" },
      exists(["/proj/a"]),
      yes,
    );
    expect(decision).toEqual({ action: "open", path: "/proj/a" });
  });

  it("shows the picker with the recorded path when the project is missing", () => {
    const decision = chooseStartupProject(
      { lastProject: "/proj/gone" },
      exists([]),
      yes,
    );
    expect(decision).toEqual({ action: "picker", missingPath: "/proj/gone" });
  });

  it("shows the picker when the recorded project is not authorized", () => {
    const decision = chooseStartupProject(
      { lastProject: "/proj/b" },
      exists(["/proj/b"]),
      no,
    );
    // Existing but unauthorized never reopens it, and the picker still names
    // the refused path so the owner knows what needed consent.
    expect(decision).toEqual({ action: "picker", missingPath: "/proj/b" });
  });

  it("shows the picker without a missing path when no project was recorded", () => {
    expect(chooseStartupProject({ lastProject: null }, exists([]), yes)).toEqual(
      { action: "picker", missingPath: null },
    );
  });

  it("treats a blank lastProject as absent", () => {
    expect(chooseStartupProject({ lastProject: "   " }, yes, yes)).toEqual({
      action: "picker",
      missingPath: null,
    });
  });
});

describe("planLaunch", () => {
  const base = {
    piFlag: false,
    explicitDir: null,
    fallbackDir: "/home/me",
    lastProject: null,
    lastProjectExists: false,
    lastProjectAuthorized: false,
  };

  it("opens chat on the existing last project and drops the home shell", () => {
    // The dock launch with a usable last project: chat is the primary tab
    // and the pre-seeded home terminal must not survive it.
    expect(
      planLaunch({
        ...base,
        lastProject: "/proj/a",
        lastProjectExists: true,
        lastProjectAuthorized: true,
      }),
    ).toEqual({ action: "chat", project: "/proj/a", keepInitialShell: false });
  });

  it("shows the picker with the missing path when the project is gone", () => {
    expect(
      planLaunch({ ...base, lastProject: "/proj/gone" }),
    ).toEqual({ action: "picker", missingPath: "/proj/gone" });
  });

  it("shows the picker without a path when nothing was recorded", () => {
    expect(planLaunch(base)).toEqual({
      action: "picker",
      missingPath: null,
    });
  });

  it("keeps the shell for a plain folder launch without --pi", () => {
    // A positional dir without --pi is a terminal-first launch; recovery
    // must never hijack it.
    expect(
      planLaunch({ ...base, explicitDir: "/some/dir", lastProject: "/proj/a" }),
    ).toEqual({ action: "shell" });
  });

  it("opens chat on the explicit --pi project and keeps the seeded shell", () => {
    expect(
      planLaunch({
        ...base,
        piFlag: true,
        explicitDir: "/proj/b",
        lastProject: "/proj/a",
      }),
    ).toEqual({ action: "chat", project: "/proj/b", keepInitialShell: true });
  });

  it("opens chat on the fallback cwd when --pi carries no dir", () => {
    expect(
      planLaunch({ ...base, piFlag: true, lastProject: "/proj/a" }),
    ).toEqual({
      action: "chat",
      project: "/home/me",
      keepInitialShell: true,
    });
  });
});

describe("launch scripts (the App.tsx startup effect, end to end)", () => {
  // A model of the shell App.tsx mounts: one terminal tab seeded from the
  // launch directory, hidden (and therefore never spawned) until the launch
  // decision reveals or replaces it. The executor below applies the exact
  // effect list launchEffects produces, the same loop App.tsx runs.
  type ShellTab = { id: number; kind: "terminal" | "pi"; cwd?: string };
  const HOME_SHELL_ID = 1;

  function runLaunch(input: LaunchInput) {
    const shell = {
      tabs: [
        { id: HOME_SHELL_ID, kind: "terminal", cwd: input.fallbackDir ?? "/" },
      ] as ShellTab[],
      activeId: HOME_SHELL_ID as number | null,
      homeShellVisible: false,
      picker: null as { missingPath: string | null } | null,
    };
    for (const effect of launchEffects(planLaunch(input))) {
      switch (effect.kind) {
        case "open-chat": {
          const id = Math.max(...shell.tabs.map((t) => t.id)) + 1;
          shell.tabs.push({ id, kind: "pi", cwd: effect.project });
          shell.activeId = id;
          break;
        }
        case "close-initial-shell":
          shell.tabs = shell.tabs.filter((t) => t.id !== HOME_SHELL_ID);
          break;
        case "reveal-initial-shell":
          shell.homeShellVisible = true;
          break;
        case "show-picker":
          shell.picker = { missingPath: effect.missingPath };
          break;
      }
    }
    return shell;
  }

  it("no argument plus an existing authorized last project: chat on it, no home terminal", () => {
    const shell = runLaunch({
      piFlag: false,
      explicitDir: null,
      fallbackDir: "/home/me",
      lastProject: "/proj/a",
      lastProjectExists: true,
      lastProjectAuthorized: true,
    });
    // The chat tab is the primary surface, selected, on the recovered
    // project; the seeded home shell was closed without ever being shown.
    expect(shell.tabs).toEqual([{ id: 2, kind: "pi", cwd: "/proj/a" }]);
    expect(shell.activeId).toBe(2);
    expect(shell.homeShellVisible).toBe(false);
    expect(shell.picker).toBeNull();
  });

  it("no argument plus a missing last project: the picker stands with the path", () => {
    const shell = runLaunch({
      piFlag: false,
      explicitDir: null,
      fallbackDir: "/home/me",
      lastProject: "/proj/gone",
      lastProjectExists: false,
      lastProjectAuthorized: false,
    });
    // No conversation opens; the overlay names the missing path, and no
    // home terminal shows behind it.
    expect(shell.tabs).toEqual([
      { id: 1, kind: "terminal", cwd: "/home/me" },
    ]);
    expect(shell.activeId).toBe(1);
    expect(shell.homeShellVisible).toBe(false);
    expect(shell.picker).toEqual({ missingPath: "/proj/gone" });
  });

  it("an explicit folder argument keeps the old terminal-first behaviour", () => {
    const shell = runLaunch({
      piFlag: false,
      explicitDir: "/some/dir",
      fallbackDir: "/home/me",
      lastProject: "/proj/a",
      lastProjectExists: true,
      lastProjectAuthorized: true,
    });
    // Recovery never hijacks a positional dir: the seeded shell shows and
    // nothing else opens.
    expect(shell.tabs).toEqual([
      { id: 1, kind: "terminal", cwd: "/home/me" },
    ]);
    expect(shell.activeId).toBe(1);
    expect(shell.homeShellVisible).toBe(true);
    expect(shell.picker).toBeNull();
  });

  it("an explicit --pi folder opens chat beside the seeded shell", () => {
    const shell = runLaunch({
      piFlag: true,
      explicitDir: "/proj/b",
      fallbackDir: "/home/me",
      lastProject: "/proj/a",
      lastProjectExists: true,
      lastProjectAuthorized: true,
    });
    expect(shell.tabs).toEqual([
      { id: 1, kind: "terminal", cwd: "/home/me" },
      { id: 2, kind: "pi", cwd: "/proj/b" },
    ]);
    expect(shell.activeId).toBe(2);
    expect(shell.homeShellVisible).toBe(true);
    expect(shell.picker).toBeNull();
  });
});

describe("sidebarCollapsedAfter", () => {
  it("collapses on a launch and on a chat open even when it was open", () => {
    expect(sidebarCollapsedAfter("launch", false)).toBe(true);
    expect(sidebarCollapsedAfter("chat-open", false)).toBe(true);
    expect(sidebarCollapsedAfter("chat-open", true)).toBe(true);
  });

  it("keeps the current visibility when switching between open tabs", () => {
    expect(sidebarCollapsedAfter("tab-switch", false)).toBe(false);
    expect(sidebarCollapsedAfter("tab-switch", true)).toBe(true);
  });
});
