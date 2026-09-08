import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// board.ts resolves the agent binary through pi_paths at import; the mock
// keeps the tests in plain node and lets each case pin the resolution.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  DEFAULT_AGENT_BIN,
  STATE_LABELS,
  allowedActionFor,
  boardActionCommand,
  boardListCommand,
  boardShowCommand,
  effectiveAgentBin,
  gateDots,
  latestGateByName,
  latestGates,
  loadResolvedAgentBin,
  parseBoard,
  parseTicket,
  quoteBin,
  railTickets,
  stateLabel,
  type Ticket,
} from "./board";

const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(
    path.join(here, "__fixtures__", name),
    "utf8",
  ).trim();
}

describe("parseBoard", () => {
  it("reads the sample snapshot: states, counts and tickets", () => {
    const board = parseBoard(fixture("board-sample.json"));
    expect(board.states).toEqual([
      "todo",
      "align",
      "in_progress",
      "verify",
      "review",
      "land",
      "done",
      "rework",
    ]);
    expect(board.counts).toEqual({ todo: 1, in_progress: 1 });
    expect(board.tickets).toHaveLength(1);
    const ticket = board.tickets[0];
    expect(ticket.id).toBe("t2");
    expect(ticket.kind).toBe("question");
    expect(ticket.status).toBe("in_progress");
    expect(ticket.attempt).toBe(0);
    expect(ticket.priority).toBe(2);
    expect(ticket.red_gates).toBe(1);
    expect(ticket.workpad?.criteria).toBe(
      "Board refreshes within 10s of a change",
    );
    expect(ticket.workpad?.confusions).toEqual([]);
    expect(ticket.gates[0]).toMatchObject({
      id: 8,
      gate: "acceptance",
      passed: true,
      provider: "board",
      source: "machine",
      attempt: 0,
      created_at: "2026-09-07 01:05:56",
    });
  });

  it("reads the empty board fixture", () => {
    const board = parseBoard(fixture("board-empty.json"));
    expect(board.tickets).toEqual([]);
    expect(board.counts).toEqual({});
    expect(board.states).toHaveLength(8);
  });

  it("coerces missing fields and throws on malformed json", () => {
    const board = parseBoard('{"states":["todo"]}');
    expect(board.counts).toEqual({});
    expect(board.tickets).toEqual([]);
    expect(() => parseBoard("not json")).toThrow();
  });
});

describe("parseTicket", () => {
  const raw = JSON.stringify({
    id: "t9",
    kind: "task",
    status: "review",
    attempt: 2,
    title: "Land the rail",
    priority: 1,
    created_at: "2026-09-07 00:00:00",
    updated_at: null,
    red_gates: 0,
    workpad: { plan: "step", confusions: ["why?", 3] },
    gates: [
      { id: 1, gate: "acceptance", passed: false, attempt: 0 },
      { id: 2, gate: "acceptance", passed: true, attempt: 2 },
    ],
  });

  it("parses a ticket object and keeps only string confusions", () => {
    const ticket = parseTicket(raw);
    expect(ticket.id).toBe("t9");
    expect(ticket.status).toBe("review");
    expect(ticket.workpad?.plan).toBe("step");
    expect(ticket.workpad?.criteria).toBeNull();
    expect(ticket.workpad?.confusions).toEqual(["why?"]);
    expect(ticket.gates).toHaveLength(2);
  });

  it("fills defaults for a sparse payload", () => {
    const ticket = parseTicket("{}");
    expect(ticket).toMatchObject({
      id: "",
      attempt: 0,
      red_gates: 0,
      workpad: null,
      gates: [],
    });
  });
});

// K12e: show --json carries the spine authority (harness commit 9df925e); the
// parse is tolerant when the field is absent so an older binary never throws.
describe("parseTicket allowedActions", () => {
  it("parses the harness authority entries with their gate reasons", () => {
    const ticket = parseTicket(
      JSON.stringify({
        id: "aa",
        kind: "build",
        status: "todo",
        allowedActions: [
          { action: "align", allowed: true, reasons: ["criteria_confirmed"] },
          { action: "rework", allowed: false, reasons: ["criteria_confirmed"] },
        ],
      }),
    );
    expect(ticket.allowedActions).toEqual([
      { action: "align", allowed: true, reasons: ["criteria_confirmed"] },
      { action: "rework", allowed: false, reasons: ["criteria_confirmed"] },
    ]);
  });

  it("tolerates a missing allowedActions field as null (older harness)", () => {
    const ticket = parseTicket(JSON.stringify({ id: "x", gates: [] }));
    expect(ticket.allowedActions).toBeNull();
  });

  it("keeps an empty list for a terminal ticket and drops malformed entries", () => {
    const ticket = parseTicket(
      JSON.stringify({
        allowedActions: [
          { action: "close", allowed: false, reasons: ["resolved", 7, "wiki-close"] },
          "junk",
          3,
        ],
      }),
    );
    expect(ticket.allowedActions).toEqual([
      { action: "close", allowed: false, reasons: ["resolved", "wiki-close"] },
    ]);
  });

  it("allowedActionFor finds one verb entry or null when not offered", () => {
    const todo = parseTicket(
      JSON.stringify({
        status: "todo",
        allowedActions: [
          { action: "align", allowed: true, reasons: ["criteria_confirmed"] },
          { action: "rework", allowed: false, reasons: ["criteria_confirmed"] },
        ],
      }),
    );
    expect(allowedActionFor(todo, "align")?.allowed).toBe(true);
    expect(allowedActionFor(todo, "rework")?.allowed).toBe(false);
    expect(allowedActionFor(todo, "close")).toBeNull();
    expect(allowedActionFor(todo, "land")).toBeNull();
  });

  it("latestGates returns one full report per gate name in first-appearance order", () => {
    const ticket = parseTicket(
      JSON.stringify({
        gates: [
          { id: 1, gate: "acceptance", passed: false, attempt: 0 },
          { id: 2, gate: "wiki-close", passed: false, attempt: 1 },
          { id: 3, gate: "acceptance", passed: true, attempt: 1 },
        ],
      }),
    );
    expect(latestGates(ticket).map((g) => [g.gate, g.id])).toEqual([
      ["acceptance", 3],
      ["wiki-close", 2],
    ]);
  });
});

describe("gate helpers", () => {
  const ticket: Ticket = parseTicket(
    JSON.stringify({
      gates: [
        { id: 1, gate: "acceptance", passed: false, attempt: 0 },
        { id: 2, gate: "validation", passed: true, attempt: 1 },
        { id: 3, gate: "acceptance", passed: true, attempt: 1 },
      ],
    }),
  );

  it("latestGateByName keeps the highest attempt per gate name", () => {
    const latest = latestGateByName(ticket);
    expect(latest.size).toBe(2);
    expect(latest.get("acceptance")?.id).toBe(3);
    expect(latest.get("validation")?.passed).toBe(true);
  });

  it("gateDots returns one dot per gate name in first-appearance order", () => {
    expect(gateDots(ticket)).toEqual([
      { gate: "acceptance", passed: true },
      { gate: "validation", passed: true },
    ]);
  });

  it("gateDots is empty for a ticket without gates", () => {
    expect(gateDots(parseTicket("{}"))).toEqual([]);
  });
});

describe("commands", () => {
  it("quoteBin splits a $HOME prefix out of the quotes", () => {
    expect(quoteBin("$HOME/Documents/x/board")).toBe(
      '"$HOME"/\'Documents/x/board\'',
    );
    expect(quoteBin("/abs/board")).toBe("'/abs/board'");
  });

  it("boardListCommand prints json", () => {
    expect(boardListCommand("$HOME/bin/board", "/work/proj")).toBe(
      '"$HOME"/\'bin/board\' --root \'/work/proj\' board --json',
    );
  });

  it("boardShowCommand quotes the ticket id and prints json", () => {
    expect(boardShowCommand("/abs/bin/board", "/w", "T-12")).toBe(
      "'/abs/bin/board' --root '/w' show 'T-12' --json",
    );
  });

  it("boardActionCommand exports the DB and runs the harness agent", () => {
    expect(boardActionCommand("$HOME/tools/harness/agent", "/work/proj", "land", "t2")).toBe(
      `HARNESS_DB='/work/proj/.pi/board.db' "$HOME"/'tools/harness/agent' land 't2'`,
    );
  });

  it("defaults the agent binary to empty so the resolver decides", () => {
    expect(DEFAULT_AGENT_BIN).toBe("");
  });

  it("falls back to the pi_paths agent binary when the pref is blank", async () => {
    invoke.mockResolvedValue({
      agent: { path: "/app/exe/agent", source: "bundled", candidates: [] },
    });
    expect(await loadResolvedAgentBin()).toBe("/app/exe/agent");
    expect(effectiveAgentBin("")).toBe("/app/exe/agent");
    expect(effectiveAgentBin("   ")).toBe("/app/exe/agent");
    expect(boardActionCommand(DEFAULT_AGENT_BIN, "/work/proj", "land", "t2")).toBe(
      `HARNESS_DB='/work/proj/.pi/board.db' '/app/exe/agent' land 't2'`,
    );
    // An explicit pref wins over the resolution.
    expect(effectiveAgentBin("$HOME/bin/agent")).toBe("$HOME/bin/agent");
  });

  it("keeps the blank fallback when pi_paths fails", async () => {
    invoke.mockRejectedValue(new Error("unavailable"));
    expect(await loadResolvedAgentBin()).toBe(null);
    expect(effectiveAgentBin("")).toBe("");
  });
});

describe("rail and labels", () => {
  const board = parseBoard(fixture("board-sample.json"));

  it("railTickets lists align, in_progress, verify and review by default", () => {
    expect(railTickets(board).map((t) => t.id)).toEqual(["t2"]);
  });

  it("railTickets narrows to the filtered state", () => {
    expect(railTickets(board, "todo")).toEqual([]);
    expect(railTickets(board, "in_progress").map((t) => t.id)).toEqual(["t2"]);
  });

  it("stateLabel covers every board state and de-underscores unknowns", () => {
    expect(Object.keys(STATE_LABELS)).toEqual([
      "todo",
      "align",
      "in_progress",
      "verify",
      "review",
      "land",
      "done",
      "rework",
    ]);
    expect(stateLabel("in_progress")).toBe("In progress");
    expect(stateLabel("custom_state")).toBe("custom state");
  });
});

describe("board read commands with a blank board binary", () => {
  it("runs the harness agent against the project board database", () => {
    const cmd = boardListCommand("", "/tmp/proj", "/opt/agent");
    expect(cmd).toBe("HARNESS_DB='/tmp/proj/.pi/board.db' '/opt/agent' board --json");
  });

  it("shows a ticket through the agent the same way", () => {
    const cmd = boardShowCommand("", "/tmp/proj", "T-1", "/opt/agent");
    expect(cmd).toBe("HARNESS_DB='/tmp/proj/.pi/board.db' '/opt/agent' show 'T-1' --json");
  });

  it("keeps the shim when a board binary is set", () => {
    expect(boardListCommand("/x/board", "/tmp/proj", "/opt/agent")).toBe(
      "'/x/board' --root '/tmp/proj' board --json",
    );
  });
});
