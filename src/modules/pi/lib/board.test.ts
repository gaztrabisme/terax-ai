import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_BIN,
  STATE_LABELS,
  boardActionCommand,
  boardListCommand,
  boardShowCommand,
  gateDots,
  latestGateByName,
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
    expect(boardActionCommand(DEFAULT_AGENT_BIN, "/work/proj", "land", "t2")).toBe(
      `HARNESS_DB='/work/proj/.pi/board.db' "$HOME"/'Documents/Work/harness/target/release/agent' land 't2'`,
    );
  });

  it("defaults the agent binary to the harness checkout", () => {
    expect(DEFAULT_AGENT_BIN).toBe(
      "$HOME/Documents/Work/harness/target/release/agent",
    );
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
