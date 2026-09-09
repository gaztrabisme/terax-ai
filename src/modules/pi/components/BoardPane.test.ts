// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import {
  DEFAULT_AGENT_BIN,
  stateLabel,
  parseBoard,
  type BoardSnapshot,
} from "../lib/board";
import { BoardView, POLL_MS } from "./BoardPane";
import { appendBoardLog, awaitingDecisionCount } from "../lib/useBoardData";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

// board.ts resolves the agent binary through pi_paths at import; the mock
// keeps every test in plain jsdom without a real Tauri backend.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Pane-level expectations: panel and full screen are one board representation
// (the state lanes), and the binary defaults stay empty so the resolver
// decides per machine.
describe("BoardView rail configuration", () => {
  it("counts distinct tickets in every human-decision column", () => {
    const tickets = [
      "align",
      "verify",
      "review",
      "land",
      "in_progress",
      "done",
    ].map((status, i) => ({ id: `t${i}`, status }));
    tickets.push({ id: "t0", status: "align" });
    expect(awaitingDecisionCount(parseBoard(JSON.stringify({ tickets })))).toBe(
      4,
    );
    expect(awaitingDecisionCount(null)).toBe(0);
  });

  it("labels every board state without underscores", () => {
    for (const state of [
      "todo",
      "align",
      "in_progress",
      "verify",
      "review",
      "land",
      "done",
      "rework",
    ]) {
      expect(stateLabel(state)).not.toContain("_");
      expect(stateLabel(state).length).toBeGreaterThan(0);
    }
  });

  it("defaults the action binary to empty so the resolver decides", () => {
    expect(DEFAULT_AGENT_BIN).toBe("");
  });

  it("keeps the board CLI default empty from module settings", () => {
    expect(PI_MODULE_PREFS_DEFAULTS.boardBin).toBe("");
  });

  // Rail and full mode share BoardView, so both re-poll on the same
  // visibility-gated 10s cadence; refreshKey bumps stay the fast path.
  it("polls every 10 seconds in both modes", () => {
    expect(POLL_MS).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// K12e: loud refresh failures
// ---------------------------------------------------------------------------

const SNAPSHOT: BoardSnapshot = parseBoard(
  JSON.stringify({
    states: [
      "todo",
      "align",
      "in_progress",
      "verify",
      "review",
      "land",
      "done",
      "rework",
    ],
    counts: { todo: 1 },
    tickets: [
      {
        id: "aa",
        kind: "build",
        status: "align",
        attempt: 0,
        title: "Build the rail",
        priority: 2,
        created_at: null,
        updated_at: null,
        red_gates: 0,
        workpad: null,
        gates: [],
        allowedActions: null,
      },
    ],
  }),
);

const FAILED_COMMAND =
  "HARNESS_DB='/proj/.pi/board.db' '/bin/agent' board --json";

function boardData(overrides: Partial<{
  snapshot: BoardSnapshot | null;
  error: string | null;
  failedCommand: string | null;
}> = {}) {
  return {
    snapshot: null,
    error: null,
    failedCommand: null,
    refresh: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => cleanup());

describe("BoardView loud refresh failures", () => {
  it("keeps the previous snapshot marked stale under a named board-error line", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        data: boardData({
          snapshot: SNAPSHOT,
          error: "board exited 1",
          failedCommand: FAILED_COMMAND,
        }),
      }),
    );
    const line = document.body.querySelector('[data-uat="board-error"]');
    expect(line).not.toBeNull();
    // The header line names the failed command and the log path.
    expect(line?.textContent).toContain("Refresh failed:");
    expect(line?.textContent).toContain(FAILED_COMMAND);
    expect(line?.textContent).toContain(".pi/logs/board.jsonl");
    expect(line?.getAttribute("title")).toBe("board exited 1");
    // The stale marker stands next to it, and the content stayed.
    expect(screen.getByText("stale")).toBeTruthy();
    expect(screen.getByText("Build the rail")).toBeTruthy();
    expect(screen.queryByText("Board offline")).toBeNull();
  });

  it("shows the offline panel when no snapshot ever arrived", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        data: boardData({
          error: "agent missing",
          failedCommand: FAILED_COMMAND,
        }),
      }),
    );
    expect(
      document.body.querySelector('[data-uat="board-error"]'),
    ).not.toBeNull();
    expect(screen.getByText("Board offline")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
  });

  it("renders no board-error line while the last load succeeded", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        data: boardData({ snapshot: SNAPSHOT }),
      }),
    );
    expect(document.body.querySelector('[data-uat="board-error"]')).toBeNull();
    expect(screen.getByText("Build the rail")).toBeTruthy();
  });

  it("keeps the error line in framed panel mode too", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        framed: true,
        data: boardData({
          snapshot: SNAPSHOT,
          error: "board exited 1",
          failedCommand: FAILED_COMMAND,
        }),
      }),
    );
    const line = document.body.querySelector('[data-uat="board-error"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain(".pi/logs/board.jsonl");
    expect(screen.getByText("stale")).toBeTruthy();
  });
});

// UX-11: one board representation in both modes. The panel stacks the same
// state lanes the full screen shows as columns; empty lanes are their single
// muted count line, and no status filter narrows the view.
describe("BoardView panel lanes", () => {
  function lane(state: string): Element | null {
    return document.body.querySelector(
      `[data-uat="board-columns"][data-uat-key="${state}"]`,
    );
  }

  it("renders one lane per board state with its count in the panel", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        data: boardData({ snapshot: SNAPSHOT }),
      }),
    );
    const lanes = document.body.querySelectorAll('[data-uat="board-columns"]');
    expect(lanes).toHaveLength(SNAPSHOT.states.length);
    const align = lane("align");
    expect(align?.textContent).toContain("Align");
    expect(align?.textContent).toContain("Build the rail");
    expect(align?.querySelectorAll('[data-uat="board-ticket"]')).toHaveLength(1);
  });

  it("collapses an empty lane to its single muted count line", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        data: boardData({ snapshot: SNAPSHOT }),
      }),
    );
    const todo = lane("todo");
    expect(todo?.textContent).toContain("Todo");
    expect(todo?.textContent).toContain("0");
    expect(todo?.querySelectorAll('[data-uat="board-ticket"]')).toHaveLength(0);
  });

  it("shows the same lanes as columns in full screen", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        mode: "full",
        data: boardData({ snapshot: SNAPSHOT }),
      }),
    );
    const lanes = document.body.querySelectorAll('[data-uat="board-columns"]');
    expect(lanes).toHaveLength(SNAPSHOT.states.length);
    expect(screen.getByText("Build the rail")).toBeTruthy();
  });

  it("offers no status filter control and shows each ticket exactly once", () => {
    render(
      createElement(BoardView, {
        cwd: "/proj",
        data: boardData({ snapshot: SNAPSHOT }),
      }),
    );
    const labelled = Array.from(
      document.body.querySelectorAll("button"),
    ).filter((button) =>
      [
        "Todo",
        "Align",
        "In progress",
        "Verify",
        "Review",
        "Land",
        "Done",
        "Rework",
      ].some((label) => (button.textContent ?? "").startsWith(label)),
    );
    expect(labelled).toHaveLength(0);
    expect(screen.getAllByText("Build the rail")).toHaveLength(1);
  });
});

describe("appendBoardLog", () => {
  it("appends one record to .pi/logs/board.jsonl through fs_write_file", async () => {
    invokeMock.mockResolvedValue({ kind: "text", content: '{"time":"t0"}\n' });
    await appendBoardLog("/proj/", FAILED_COMMAND, "board exited 1");
    const read = invokeMock.mock.calls.find(([cmd]) => cmd === "fs_read_file");
    expect(read?.[1]).toMatchObject({ path: "/proj/.pi/logs/board.jsonl" });
    const write = invokeMock.mock.calls.find(([cmd]) => cmd === "fs_write_file");
    expect(write?.[1]).toMatchObject({
      path: "/proj/.pi/logs/board.jsonl",
    });
    const content = (write?.[1] as { content: string }).content;
    expect(content.startsWith('{"time":"t0"}\n')).toBe(true);
    const record = JSON.parse(content.trim().split("\n").pop() ?? "{}");
    expect(record).toMatchObject({
      command: FAILED_COMMAND,
      error: "board exited 1",
    });
    expect(typeof record.time).toBe("string");
  });

  it("creates the log on the first failure and never throws", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_read_file") throw new Error("missing");
      if (cmd === "fs_create_dir") return null;
      return null;
    });
    await expect(
      appendBoardLog("/proj", "board --json", "no agent"),
    ).resolves.toBeUndefined();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "fs_create_dir")).toBe(
      true,
    );
    const write = invokeMock.mock.calls.find(([cmd]) => cmd === "fs_write_file");
    const content = JSON.parse(
      (write?.[1] as { content: string }).content.trim(),
    );
    expect(content).toMatchObject({ command: "board --json", error: "no agent" });
  });

  it("swallows a failed log write so the refresh error stays the story", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    await expect(
      appendBoardLog("/proj", "board --json", "board exited 1"),
    ).resolves.toBeUndefined();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "fs_write_file")).toBe(
      true,
    );
  });
});
