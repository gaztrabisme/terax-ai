import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  answerAsk,
  applyEvent,
  initialPiSessionState,
  messageBlocks,
  type PiBlock,
  type PiSessionState,
} from "./parse";
import {
  boardOp,
  childTranscriptPath,
  groupTurns,
  subagentBrief,
  subagentName,
} from "./turns";

const here = path.dirname(fileURLToPath(import.meta.url));

function stdoutEvents(fixture: string): string[] {
  const text = readFileSync(path.join(here, "__fixtures__", fixture), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { dir: string; raw: string })
    .filter((entry) => entry.dir === "stdout")
    .map((entry) => entry.raw);
}

/** Replays with a deterministic clock: block i is stamped i * 1000 ms. */
function replay(fixture: string): PiSessionState {
  return stdoutEvents(fixture).reduce(
    (state, raw, i) => applyEvent(state, raw, (i + 1) * 1000),
    initialPiSessionState(),
  );
}

function replayUpTo(
  fixture: string,
  predicate: (raw: string) => boolean,
): PiSessionState {
  const state = initialPiSessionState();
  for (const [i, raw] of stdoutEvents(fixture).entries()) {
    Object.assign(state, applyEvent(state, raw, (i + 1) * 1000));
    if (predicate(raw)) break;
  }
  return state;
}

function block(id: string, over: Partial<PiBlock> = {}): PiBlock {
  return {
    kind: "message",
    id,
    role: "user",
    parts: [{ type: "text", text: `message ${id}` }],
    model: null,
    usage: null,
    streaming: false,
    at: 0,
    ...over,
  } as PiBlock;
}

function toolBlock(
  id: string,
  over: Partial<Extract<PiBlock, { kind: "tool" }>> = {},
): Extract<PiBlock, { kind: "tool" }> {
  return {
    kind: "tool",
    toolCallId: id,
    toolName: "bash",
    args: {},
    status: "done",
    partialText: null,
    resultText: "ok",
    isError: false,
    at: 0,
    ...over,
  };
}

describe("q2-rpc-tools: one turn with tools", () => {
  const turns = groupTurns(messageBlocks(replay("q2-rpc-tools.jsonl").blocks));

  it("groups the whole session into a single turn keyed by the user message", () => {
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toContain("echo hello-r2");
    expect(turns[0].key).toBe("msg-0");
  });

  it("answers with the last assistant message and narrates the earlier one", () => {
    const turn = turns[0];
    expect(turn.answer).toContain("Output: `hello-r2`");
    const narrations = turn.activity.filter((a) => a.kind === "narration");
    expect(narrations).toHaveLength(0);
  });

  it("keeps every thinking part and the tool in activity order", () => {
    const kinds = turns[0].activity.map((a) => a.kind);
    expect(kinds).toEqual(["thinking", "tool", "thinking"]);
    const tool = turns[0].activity[1];
    if (tool.kind !== "tool") throw new Error("not a tool entry");
    expect(tool.block.toolName).toBe("bash");
    expect(tool.block.status).toBe("done");
  });

  it("counts one tool and no children or boards", () => {
    expect(turns[0].counts).toEqual({ tools: 1, children: 0, board: 0 });
  });

  it("measures duration from the pinned block timestamps", () => {
    expect(turns[0].status).toBe("done");
    expect(turns[0].durationMs).not.toBeNull();
    expect(turns[0].durationMs ?? 0).toBeGreaterThan(0);
  });
});

describe("streaming turn", () => {
  it("q2 at tool_execution_start: the turn streams with a running tool", () => {
    const mid = replayUpTo("q2-rpc-tools.jsonl", (raw) =>
      raw.includes('"type":"tool_execution_start"'),
    );
    const [turn] = groupTurns(messageBlocks(mid.blocks));
    expect(turn.status).toBe("streaming");
    const running = turn.activity.find((a) => a.kind === "tool");
    if (running?.kind !== "tool") throw new Error("no tool entry");
    expect(running.block.status).toBe("running");
  });

  it("a still-streaming assistant message is the answer so far", () => {
    const [turn] = groupTurns([
      block("u1"),
      block("a1", {
        role: "assistant",
        streaming: true,
        parts: [{ type: "text", text: "partial answer" }],
      }),
    ]);
    expect(turn.status).toBe("streaming");
    expect(turn.answer).toBe("partial answer");
  });
});

describe("q3-rpc-ask: turn with ask", () => {
  it("at ask_request the pending card rides in the streaming turn", () => {
    const atAsk = replayUpTo("q3-rpc-ask.jsonl", (raw) =>
      raw.includes('"type":"ask_request"'),
    );
    const [turn] = groupTurns(messageBlocks(atAsk.blocks));
    expect(turn.status).toBe("streaming");
    expect(turn.asks).toHaveLength(1);
    expect(turn.asks[0].state).toBe("pending");
  });

  it("after the optimistic answer the turn is done with the ask answered", () => {
    // The app answers the card optimistically in the store before the wire
    // confirms; a pure stdout replay keeps it pending, so mirror the app.
    const answered = answerAsk(
      replay("q3-rpc-ask.jsonl"),
      "c8519be0-1f52-4897-a9d7-424680058e56",
      [{ questionId: "0", selected: ["Yes"] }],
    );
    const [turn] = groupTurns(messageBlocks(answered.blocks));
    expect(turn.status).toBe("done");
    expect(turn.asks).toHaveLength(1);
    expect(turn.asks[0].state).toBe("answered");
    expect(turn.answer).toContain("ready to proceed");
    expect(turn.counts.tools).toBe(1);
  });
});

describe("two turns", () => {
  // q1 replayed, then a second prompt cycle appended on the wire.
  const lines = [
    ...stdoutEvents("q1-rpc-basic.jsonl"),
    '{"type":"message_start","message":{"role":"user","content":"again"}}',
    '{"type":"message_end","message":{"role":"user","content":"again"}}',
    '{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"second reply"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second reply"}]}}',
  ];
  const state = lines.reduce(
    (s, raw, i) => applyEvent(s, raw, (i + 1) * 1000),
    initialPiSessionState(),
  );
  const turns = groupTurns(messageBlocks(state.blocks));

  it("splits at the second user message", () => {
    expect(turns).toHaveLength(2);
    expect(turns[0].user).toContain("Reply with exactly");
    expect(turns[0].answer).toContain("OK");
    expect(turns[1].user).toBe("again");
    expect(turns[1].answer).toBe("second reply");
    expect(turns[1].index).toBe(1);
  });

  it("the finished first turn keeps status done", () => {
    expect(turns[0].status).toBe("done");
    expect(turns[1].status).toBe("done");
  });
});

describe("synthetic counting and helpers", () => {
  it("counts subagent and board tools inside the totals", () => {
    const turns = groupTurns([
      block("u1"),
      block("a1", {
        role: "assistant",
        parts: [{ type: "text", text: "working" }],
      }),
      toolBlock("t1", { toolName: "subagent" }),
      toolBlock("t2", { toolName: "board_open" }),
      toolBlock("t3", { toolName: "read" }),
      block("a2", {
        role: "assistant",
        parts: [{ type: "text", text: "final" }],
      }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].counts).toEqual({ tools: 3, children: 1, board: 1 });
    expect(turns[0].answer).toBe("final");
    expect(turns[0].activity.map((a) => a.kind)).toEqual([
      "narration",
      "tool",
      "tool",
      "tool",
    ]);
  });

  it("a user message with no assistant yet streams", () => {
    const [turn] = groupTurns([block("u1")]);
    expect(turn.status).toBe("streaming");
    expect(turn.answer).toBe("");
  });

  it("duration spans the first to the last block timestamp", () => {
    const turns = groupTurns([
      block("u1", { at: 1000 }),
      toolBlock("t1", { at: 2500 }),
      block("a1", { role: "assistant", parts: [{ type: "text", text: "x" }], at: 3250 }),
    ]);
    expect(turns[0].durationMs).toBe(2250);
  });

  it("subagent name, brief and transcript path resolution", () => {
    const call = toolBlock("t1", {
      toolName: "subagent",
      args: {
        name: "scout",
        brief: "find the bug\nsecond line",
        transcript: "agent-hub/42/scout.transcript.jsonl",
      },
    });
    expect(subagentName(call)).toBe("scout");
    expect(subagentBrief(call)).toBe("find the bug");
    expect(childTranscriptPath(call)).toBeNull();
    expect(childTranscriptPath(call, "/work/lab")).toBe(
      "/work/lab/agent-hub/42/scout.transcript.jsonl",
    );
    const absolute = toolBlock("t2", {
      toolName: "subagent",
      args: {},
      resultText: 'done: /tmp/hub/9/w.transcript.jsonl trailing',
    });
    expect(childTranscriptPath(absolute)).toBe("/tmp/hub/9/w.transcript.jsonl");
  });

  it("boardOp strips the prefix", () => {
    expect(boardOp("board_open")).toBe("open");
    expect(boardOp("read")).toBe("read");
  });
});
