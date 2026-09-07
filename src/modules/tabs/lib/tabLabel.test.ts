import { describe, expect, it } from "vitest";
import { labelFor } from "./tabLabel";
import type { BoardTab, RunGraphTab, TerminalTab } from "./useTabs";

function terminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...over,
  };
}

describe("labelFor (terminal tabs)", () => {
  it("derives the label from the last cwd segment", () => {
    expect(labelFor(terminalTab({ cwd: "/Users/me/projects/terax-ai" }))).toBe(
      "terax-ai",
    );
  });

  it("falls back to the title when there is no cwd", () => {
    expect(labelFor(terminalTab({ title: "private" }))).toBe("private");
  });

  it("prefers a custom title over the cwd-derived name", () => {
    expect(
      labelFor(
        terminalTab({
          cwd: "/Users/me/projects/terax-ai",
          customTitle: "Server",
        }),
      ),
    ).toBe("Server");
  });

  it("keeps the custom title after the cwd changes (survives cd)", () => {
    const renamed = terminalTab({ cwd: "/Users/me/a", customTitle: "Server" });
    const afterCd = { ...renamed, cwd: "/Users/me/b/c" };
    expect(labelFor(afterCd)).toBe("Server");
  });

  it("handles Windows-style cwd separators", () => {
    expect(labelFor(terminalTab({ cwd: "C:\\Users\\me\\proj" }))).toBe("proj");
  });
});

describe("labelFor (board / run-graph tabs)", () => {
  const boardTab: BoardTab = {
    id: 10,
    kind: "board",
    title: "Board",
    cwd: "/Users/me/projects/terax-ai",
  };

  const runGraphTab: RunGraphTab = {
    id: 11,
    kind: "run-graph",
    title: "Run graph",
    cwd: "/Users/me/projects/terax-ai",
    piTabId: 3,
  };

  it("uses the stored title for board tabs", () => {
    expect(labelFor(boardTab)).toBe("Board");
  });

  it("uses the stored title for run-graph tabs", () => {
    expect(labelFor(runGraphTab)).toBe("Run graph");
  });

  it("does not derive board / run-graph labels from cwd", () => {
    // These kinds carry no customTitle; the title must win over the
    // terminal-style cwd fallback.
    expect(labelFor({ ...boardTab, title: "Kanban" })).toBe("Kanban");
    expect(labelFor({ ...runGraphTab, title: "Runs" })).toBe("Runs");
  });
});
