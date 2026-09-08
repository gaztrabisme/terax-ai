import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  answerAsk,
  applyEvent,
  askResponseLine,
  dismissAsk,
  effectiveQuestionId,
  initialPiSessionState,
  promptLine,
  recordSavedAttachments,
  resetAsk,
  retryPendingLabel,
  type PiBlock,
  type PiErrorBlock,
  type PiRetryBlock,
  type PiSessionState,
} from "./parse";

const here = path.dirname(fileURLToPath(import.meta.url));

// The R2 captures are driver logs: each line records one wire frame with
// dir "stdin"/"stdout" and the payload in .raw. The stdout entries are
// byte-for-byte what the Rust pi module forwards over the event channel.
function stdoutEvents(fixture: string): string[] {
  const text = readFileSync(path.join(here, "__fixtures__", fixture), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { dir: string; raw: string })
    .filter((entry) => entry.dir === "stdout")
    .map((entry) => entry.raw);
}

function replay(fixture: string): PiSessionState {
  return stdoutEvents(fixture).reduce(applyEvent, initialPiSessionState());
}

function replayUpTo(
  fixture: string,
  predicate: (raw: string) => boolean,
): PiSessionState {
  const state: PiSessionState = { ...initialPiSessionState() };
  for (const raw of stdoutEvents(fixture)) {
    const next = applyEvent(state, raw);
    // applyEvent is pure: fold manually so the prefix stops inclusively.
    Object.assign(state, next);
    if (predicate(raw)) break;
  }
  return state;
}

function blocksOfKind<K extends PiBlock["kind"]>(
  state: PiSessionState,
  kind: K,
) {
  return state.blocks.filter(
    (b): b is Extract<PiBlock, { kind: K }> => b.kind === kind,
  );
}

describe("q1-rpc-basic: message_update snapshot semantics", () => {
  const final = replay("q1-rpc-basic.jsonl");

  it("keeps exactly one user and one assistant message block", () => {
    const messages = blocksOfKind(final, "message");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("replaces parts on every update instead of appending", () => {
    // 11 message_update events streamed this message; the snapshot content
    // grows 0 -> 3 parts. Appending instead of replacing would multiply them.
    const messages = blocksOfKind(final, "message");
    const assistant = messages[1];
    expect(assistant.parts).toHaveLength(3);
    expect(assistant.parts.map((p) => p.type)).toEqual([
      "text",
      "thinking",
      "text",
    ]);
    expect(assistant.parts[1]).toEqual({
      type: "thinking",
      thinking: "\nOK\n",
    });
    expect(assistant.parts[2]).toEqual({ type: "text", text: "\n\nOK" });
  });

  it("finalizes the assistant message from message_end usage", () => {
    const assistant = blocksOfKind(final, "message")[1];
    expect(assistant.streaming).toBe(false);
    expect(assistant.usage?.totalTokens).toBe(4939);
    expect(final.tokens?.totalTokens).toBe(4939);
  });

  it("ends done with the session id from agent_start", () => {
    expect(final.status).toBe("done");
    expect(final.sessionId).toBe("005cb0ff-26c7-468d-9c1a-a00d9afd4d9e");
  });
});

describe("q2-rpc-tools: tool row lifecycle", () => {
  it("marks the row running on tool_execution_start", () => {
    const mid = replayUpTo("q2-rpc-tools.jsonl", (raw) =>
      raw.includes('"type":"tool_execution_start"'),
    );
    const tools = blocksOfKind(mid, "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe("bash");
    expect(tools[0].status).toBe("running");
    expect(tools[0].resultText).toBeNull();
    expect(mid.status).toBe("tool");
  });

  it("ends the row done with result.content[0].text", () => {
    const final = replay("q2-rpc-tools.jsonl");
    const tools = blocksOfKind(final, "tool");
    expect(tools).toHaveLength(1);
    const row = tools[0];
    expect(row.toolCallId).toBe("call_3a1c8ef1");
    expect(row.status).toBe("done");
    expect(row.isError).toBe(false);
    expect(row.resultText).toBe("hello-r2\n");
  });

  it("keeps partial output from tool_execution_update", () => {
    const final = replay("q2-rpc-tools.jsonl");
    const row = blocksOfKind(final, "tool")[0];
    expect(row.partialText).toBe("hello-r2\n");
  });

  it("final usage.totalTokens comes from the last message_end", () => {
    const final = replay("q2-rpc-tools.jsonl");
    expect(final.tokens?.totalTokens).toBe(2049);
  });
});

describe("q3-rpc-ask: pending ask card", () => {
  // Stop inclusive of the ask_request: later events resolve the card.
  const atAsk = replayUpTo("q3-rpc-ask.jsonl", (raw) =>
    raw.includes('"type":"ask_request"'),
  );

  it("inserts exactly one pending card and flips status", () => {
    const asks = blocksOfKind(atAsk, "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0].state).toBe("pending");
    expect(atAsk.status).toBe("awaiting-ask");
  });

  it("carries the measured question shape with recommended: 0", () => {
    const card = blocksOfKind(atAsk, "ask")[0];
    expect(card.questions).toHaveLength(1);
    const q = card.questions[0];
    expect(q.question).toBe("Proceed?");
    expect(q.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(q.recommended).toBe(0);
    expect(card.timeoutMs).toBe(300000);
  });

  it("pairs answers by array index when pi omits question ids", () => {
    const card = blocksOfKind(atAsk, "ask")[0];
    expect(card.questions[0].id).toBeUndefined();
    expect(effectiveQuestionId(card.questions[0], 0)).toBe("0");
  });

  it("builds the exact wire answer pi requires", () => {
    const card = blocksOfKind(atAsk, "ask")[0];
    const line = askResponseLine(card.requestId, [
      { questionId: "0", selected: ["Yes"] },
    ]);
    expect(JSON.parse(line)).toEqual({
      type: "ask_response",
      requestId: card.requestId,
      answers: [{ questionId: "0", selected: ["Yes"] }],
    });
  });

  it("marks the card answered locally and settles the ask tool row", () => {
    const answered = answerAsk(atAsk, blocksOfKind(atAsk, "ask")[0].requestId, [
      { questionId: "0", selected: ["Yes"] },
    ]);
    expect(blocksOfKind(answered, "ask")[0].state).toBe("answered");

    const final = replay("q3-rpc-ask.jsonl");
    const askRow = blocksOfKind(final, "tool").find(
      (t) => t.toolName === "ask",
    );
    expect(askRow?.status).toBe("done");
    expect(askRow?.resultText).toBe("Q: Proceed?\nA: Yes");
    expect(final.status).toBe("done");
  });

  it("dismiss and reset round-trip the card state", () => {
    const id = blocksOfKind(atAsk, "ask")[0].requestId;
    const dismissed = dismissAsk(atAsk, id);
    expect(blocksOfKind(dismissed, "ask")[0].state).toBe("dismissed");
    expect(blocksOfKind(resetAsk(dismissed, id), "ask")[0].state).toBe(
      "pending",
    );
  });
});

describe("q7-rpc-model-error: failed model request", () => {
  const final = replay("q7-rpc-model-error.jsonl");
  const errorText = "IO error: Connection refused (os error 61)";

  it("lands in status error with one error card and lastErrorText", () => {
    expect(final.status).toBe("error");
    const errors = final.blocks.filter(
      (b): b is PiErrorBlock => b.kind === "error",
    );
    // Four auto-retries repeat the same top-level agent_end error; only the
    // first becomes a card.
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toBe(errorText);
    expect(final.lastErrorText).toBe(errorText);
  });

  it("a user message_start clears the latch so the next failure gets its own card", () => {
    const rearmed = applyEvent(
      final,
      '{"type":"message_start","message":{"role":"user","content":"try again"}}',
    );
    expect(rearmed.lastErrorText).toBeNull();
    const retried = applyEvent(
      rearmed,
      `{"error":"${errorText}","type":"agent_end"}`,
    );
    const errors = retried.blocks.filter(
      (b): b is PiErrorBlock => b.kind === "error",
    );
    expect(errors).toHaveLength(2);
  });
});

describe("q8-rpc-retry-success: retry lifecycle and per-turn usage", () => {
  const final = replay("q8-rpc-retry-success.jsonl");
  const errorText = "Provider rate limited (429)";

  it("holds the pending retry between auto_retry_start and auto_retry_end", () => {
    const pending = replayUpTo("q8-rpc-retry-success.jsonl", (raw) =>
      raw.includes('"type":"auto_retry_start"'),
    );
    expect(pending.retry).toEqual({ attempt: 1, max: 3, delayMs: 4000 });
    expect(pending.status).toBe("thinking");
    expect(retryPendingLabel(pending.retry!)).toBe("retrying 1/3 in 4 s");
  });

  it("records retry start and end as feed cards on the turn", () => {
    const retries = final.blocks.filter(
      (b): b is PiRetryBlock => b.kind === "retry",
    );
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({
      kind: "retry",
      phase: "start",
      attempt: 1,
      max: 3,
      delayMs: 4000,
      errorText,
    });
    expect(retries[1]).toMatchObject({
      kind: "retry",
      phase: "end",
      attempt: 1,
      success: true,
      errorText: null,
    });
  });

  it("clears the retry state once auto_retry_end lands", () => {
    expect(final.retry).toBeNull();
    expect(final.status).toBe("done");
  });

  it("captures turn_end usage with the priced cost total", () => {
    expect(final.turnUsage).toEqual({
      input: 1204,
      output: 312,
      cacheRead: 9700,
      cacheWrite: 0,
      totalTokens: 11216,
      costTotal: 0.0031,
    });
    expect(final.tokens?.totalTokens).toBe(11216);
  });

  it("accumulates session tokens and cost across turn_end events only", () => {
    // The failed first attempt ends with zero usage; the retried one bills.
    expect(final.turnTokens).toBe(11216);
    expect(final.sessionCost).toBeCloseTo(0.0031, 6);
    const oneMore = applyEvent(
      final,
      '{"type":"turn_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.0,"output":0.0002,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0002}}}}',
    );
    expect(oneMore.turnTokens).toBe(11231);
    expect(oneMore.sessionCost).toBeCloseTo(0.0033, 6);
  });

  it("a user message_start re-arms the turn: usage and retry state reset", () => {
    const rearmed = applyEvent(
      final,
      '{"type":"message_start","message":{"role":"user","content":"next"}}',
    );
    expect(rearmed.turnUsage).toBeNull();
    expect(rearmed.retry).toBeNull();
  });
});

describe("retry events: malformed and failure shapes", () => {
  it("ignores auto_retry_start with missing numeric fields", () => {
    const state = initialPiSessionState();
    const next = applyEvent(
      state,
      '{"type":"auto_retry_start","attempt":1,"errorMessage":"x"}',
    );
    expect(next).toBe(state);
  });

  it("keeps the q7 failure path: retry cards plus the deduped error card", () => {
    const final = replay("q7-rpc-model-error.jsonl");
    const retries = final.blocks.filter(
      (b): b is PiRetryBlock => b.kind === "retry",
    );
    // Three starts and one terminal failure end; the pending state is gone.
    expect(retries.filter((b) => b.phase === "start")).toHaveLength(3);
    expect(retries.filter((b) => b.phase === "end")).toHaveLength(1);
    expect(retries[3]).toMatchObject({ success: false, attempt: 3 });
    expect(final.retry).toBeNull();
    const errors = final.blocks.filter(
      (b): b is PiErrorBlock => b.kind === "error",
    );
    expect(errors).toHaveLength(1);
  });

  it("reads cost.total when present and defaults to 0 when absent", () => {
    let state = initialPiSessionState();
    state = applyEvent(
      state,
      '{"type":"turn_end","message":{"role":"assistant","usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110,"cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0}}}}',
    );
    expect(state.turnUsage?.costTotal).toBe(0);
    state = applyEvent(
      state,
      '{"type":"turn_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2}}}',
    );
    expect(state.turnUsage?.costTotal).toBe(0);
  });
});

describe("protocol hygiene", () => {
  it("ignores launcher banner lines and malformed JSON", () => {
    const state = initialPiSessionState();
    expect(applyEvent(state, "[1/8] banner")).toBe(state);
    expect(applyEvent(state, "not json")).toBe(state);
    expect(applyEvent(state, '{"type":')).toBe(state);
    expect(applyEvent(state, '{"type":"unknown_kind"}')).toBe(state);
  });

  it("builds the prompt command line", () => {
    expect(JSON.parse(promptLine("Reply with exactly: OK"))).toEqual({
      type: "prompt",
      message: "Reply with exactly: OK",
    });
  });
});

describe("promptLine streamingBehavior", () => {
  const png = { mediaType: "image/png", data: "AAAA" };

  it("adds the field only when given", () => {
    expect(promptLine("hi")).toBe('{"type":"prompt","message":"hi"}');
    expect(promptLine("hi", undefined, "follow-up")).toBe(
      '{"type":"prompt","message":"hi","streamingBehavior":"follow-up"}',
    );
    expect(promptLine("hi", undefined, "steer")).toBe(
      '{"type":"prompt","message":"hi","streamingBehavior":"steer"}',
    );
  });

  it("rides alongside images in pi's accepted shape", () => {
    // pi 0.3.0 reads streamingBehavior (or streaming_behavior) off the
    // prompt command and accepts "follow-up" | "followUp" | "follow_up" |
    // "steer" (vendor rpc.rs parse_streaming_behavior).
    const parsed = JSON.parse(promptLine("hi", [png], "follow-up")) as {
      type: string;
      message: string;
      streamingBehavior: string;
      images: { type: string; source: Record<string, string> }[];
    };
    expect(parsed).toEqual({
      type: "prompt",
      message: "hi",
      images: [
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "AAAA" },
        },
      ],
      streamingBehavior: "follow-up",
    });
  });
});

describe("promptLine images", () => {
  const png = { mediaType: "image/png", data: "AAAA" };
  const jpeg = { mediaType: "image/jpeg", data: "/9j/4AA" };

  it("emits no images field for zero images", () => {
    expect(promptLine("hi")).toBe('{"type":"prompt","message":"hi"}');
    expect(promptLine("hi", [])).toBe('{"type":"prompt","message":"hi"}');
    expect(promptLine("hi", undefined)).toBe(
      '{"type":"prompt","message":"hi"}',
    );
  });

  it("wraps one image in pi's exact item shape", () => {
    // pi's rpc.rs parse_prompt_images reads exactly these key names:
    // items[].type = "image", items[].source.type = "base64",
    // items[].source.mediaType, items[].source.data.
    expect(promptLine("hi", [png])).toBe(
      JSON.stringify({
        type: "prompt",
        message: "hi",
        images: [
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "AAAA" },
          },
        ],
      }),
    );
    const parsed = JSON.parse(promptLine("hi", [png])) as {
      images: { type: string; source: Record<string, string> }[];
    };
    expect(Object.keys(parsed.images[0])).toEqual(["type", "source"]);
    expect(Object.keys(parsed.images[0].source)).toEqual([
      "type",
      "mediaType",
      "data",
    ]);
  });

  it("carries two images in order", () => {
    const parsed = JSON.parse(promptLine("two", [png, jpeg])) as {
      type: string;
      message: string;
      images: {
        type: string;
        source: { type: string; mediaType: string; data: string };
      }[];
    };
    expect(parsed.type).toBe("prompt");
    expect(parsed.message).toBe("two");
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0].source.mediaType).toBe("image/png");
    expect(parsed.images[0].source.data).toBe("AAAA");
    expect(parsed.images[1].source.mediaType).toBe("image/jpeg");
    expect(parsed.images[1].source.data).toBe("/9j/4AA");
    for (const image of parsed.images) {
      expect(image.type).toBe("image");
      expect(image.source.type).toBe("base64");
    }
  });
});

// Wire shapes measured on pi 0.3.0: the switch ack carries no session id
// ({command:"switch_session",data:{cancelled}}), and only agent_start,
// turn_start and turn_end carry one. The new id lands on the next
// agent_start, after which turn_start and turn_end repeat it.
const SWITCH_ACK =
  '{"command":"switch_session","data":{"cancelled":false},"id":"9","success":true,"type":"response"}';
const SESSION_A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";

const A_USAGE =
  '{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.01}}';
const B_USAGE =
  '{"input":3,"output":4,"cacheRead":0,"cacheWrite":0,"totalTokens":7,"cost":{"total":0.02}}';

/** A full turn in session A: messages, a tool row, an ask card, usage, a
 *  retry in flight and a terminal error, so the reset has everything to
 *  clear. */
function sessionAState(): PiSessionState {
  let state = initialPiSessionState();
  const feed = [
    `{"type":"agent_start","sessionId":"${SESSION_A}"}`,
    `{"type":"turn_start","sessionId":"${SESSION_A}","turnIndex":0,"timestamp":1000}`,
    '{"type":"message_start","message":{"role":"user","content":"hello"}}',
    '{"type":"tool_execution_start","toolCallId":"tool-1","toolName":"bash","args":{"cmd":"ls"}}',
    '{"type":"tool_execution_end","toolCallId":"tool-1","result":{"content":[{"type":"text","text":"out"}]},"isError":false}',
    `{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"from A"}],"model":"m-1"}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"from A"}],"model":"m-1","usage":${A_USAGE}}}`,
    `{"type":"turn_end","sessionId":"${SESSION_A}","turnIndex":0,"message":{"role":"assistant","usage":${A_USAGE}}}`,
    '{"type":"ask_request","id":"ask-1","questions":[{"question":"Proceed?","options":[{"label":"Yes"}],"recommended":0,"multi":false}],"timeoutMs":1000}',
    '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":4000}',
    '{"type":"agent_end","error":"boom"}',
  ];
  for (const raw of feed) state = applyEvent(state, raw);
  return state;
}

function runTurnB(from: PiSessionState): PiSessionState {
  let state = from;
  const feed = [
    `{"type":"agent_start","sessionId":"${SESSION_B}"}`,
    `{"type":"turn_start","sessionId":"${SESSION_B}","turnIndex":0,"timestamp":2000}`,
    '{"type":"message_start","message":{"role":"user","content":"next"}}',
    `{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"from B"}],"model":"m-2"}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"from B"}],"model":"m-2","usage":${B_USAGE}}}`,
    `{"type":"turn_end","sessionId":"${SESSION_B}","turnIndex":0,"message":{"role":"assistant","usage":${B_USAGE}}}`,
  ];
  for (const raw of feed) state = applyEvent(state, raw);
  return state;
}

describe("switch_session: the transcript resets to the new session", () => {
  it("populates session A with blocks, positions, usage, retry and error state", () => {
    const state = sessionAState();
    expect(state.sessionId).toBe(SESSION_A);
    expect(state.blocks).toHaveLength(6);
    expect(Object.keys(state.toolPos)).toEqual(["tool-1"]);
    expect(Object.keys(state.askPos)).toEqual(["ask-1"]);
    expect(state.tokens?.totalTokens).toBe(15);
    expect(state.turnTokens).toBe(15);
    expect(state.sessionCost).toBeCloseTo(0.01, 6);
    expect(state.retry).toEqual({ attempt: 1, max: 3, delayMs: 4000 });
    expect(state.lastErrorText).toBe("boom");
    expect(state.switching).toBe(false);
  });

  it("the ack clears the transcript state and waits for the new session id", () => {
    const switched = applyEvent(sessionAState(), SWITCH_ACK);
    expect(switched.blocks).toEqual([]);
    expect(switched.openMessageId).toBeNull();
    expect(switched.toolPos).toEqual({});
    expect(switched.askPos).toEqual({});
    expect(switched.tokens).toBeNull();
    expect(switched.turnTokens).toBe(0);
    expect(switched.sessionCost).toBe(0);
    expect(switched.turnUsage).toBeNull();
    expect(switched.retry).toBeNull();
    expect(switched.lastErrorText).toBeNull();
    expect(switched.startedMs).toBeNull();
    expect(switched.sessionId).toBeNull();
    expect(switched.status).toBe("idle");
    expect(switched.switching).toBe(true);
  });

  it("events from session B after the switch yield only B's transcript and totals", () => {
    const final = runTurnB(applyEvent(sessionAState(), SWITCH_ACK));
    const messages = blocksOfKind(final, "message");
    expect(messages).toHaveLength(2);
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "next" });
    expect(messages[1].parts[0]).toEqual({ type: "text", text: "from B" });
    expect(final.sessionId).toBe(SESSION_B);
    expect(final.switching).toBe(false);
    expect(final.tokens?.totalTokens).toBe(7);
    expect(final.turnTokens).toBe(7);
    expect(final.sessionCost).toBeCloseTo(0.02, 6);
  });

  it("a stale turn_end from session A after the switch is ignored", () => {
    const final = runTurnB(applyEvent(sessionAState(), SWITCH_ACK));
    const stale = applyEvent(
      final,
      `{"type":"turn_end","sessionId":"${SESSION_A}","turnIndex":9,"message":{"role":"assistant","usage":{"input":99,"output":99,"cacheRead":0,"cacheWrite":0,"totalTokens":999,"cost":{"total":9.99}}}}`,
    );
    expect(stale).toBe(final);
    expect(stale.turnTokens).toBe(7);
    expect(stale.sessionCost).toBeCloseTo(0.02, 6);
  });

  it("frames inside the switch window are ignored until the new agent_start", () => {
    const switched = applyEvent(sessionAState(), SWITCH_ACK);
    const staleUser = applyEvent(
      switched,
      '{"type":"message_start","message":{"role":"user","content":"stale"}}',
    );
    expect(staleUser).toBe(switched);
    const staleTurn = applyEvent(
      switched,
      `{"type":"turn_end","sessionId":"${SESSION_A}","turnIndex":0,"message":{"role":"assistant","usage":${A_USAGE}}}`,
    );
    expect(staleTurn).toBe(switched);
    const adopted = applyEvent(
      staleTurn,
      `{"type":"agent_start","sessionId":"${SESSION_B}"}`,
    );
    expect(adopted.sessionId).toBe(SESSION_B);
    expect(adopted.switching).toBe(false);
    expect(adopted.status).toBe("thinking");
  });

  it("an agent_start naming another session resets even when the ack was missed", () => {
    const reset = applyEvent(
      sessionAState(),
      `{"type":"agent_start","sessionId":"${SESSION_B}"}`,
    );
    expect(reset.blocks).toEqual([]);
    expect(reset.sessionId).toBe(SESSION_B);
    expect(reset.tokens).toBeNull();
    expect(reset.turnTokens).toBe(0);
    const final = runTurnB(reset);
    expect(final.turnTokens).toBe(7);
    expect(final.sessionCost).toBeCloseTo(0.02, 6);
  });

  it("a cancelled or failed switch ack keeps the current session", () => {
    const state = sessionAState();
    const cancelled = applyEvent(
      state,
      '{"command":"switch_session","data":{"cancelled":true},"id":"9","success":true,"type":"response"}',
    );
    expect(cancelled).toBe(state);
    const failed = applyEvent(
      state,
      '{"command":"switch_session","id":"9","success":false,"type":"response"}',
    );
    expect(failed).toBe(state);
  });

  it("a new run in the same session does not reset the transcript", () => {
    const state = sessionAState();
    const rerun = applyEvent(
      state,
      `{"type":"agent_start","sessionId":"${SESSION_A}"}`,
    );
    expect(rerun.blocks).toHaveLength(6);
    expect(rerun.tokens?.totalTokens).toBe(15);
    expect(rerun.switching).toBe(false);
  });
});

// Measured on pi 0.3.0: a prompt sent right after agent_end is refused with
// {command:"prompt",success:false,error} and no run starts, so without a
// card the app gives no sign the prompt was dropped.
describe("rejected prompt response", () => {
  const rejection =
    '{"type":"response","command":"prompt","success":false,"error":"Agent is currently streaming; specify streamingBehavior"}';

  it("lands an error card with the rejection text and latches lastErrorText", () => {
    const rejected = applyEvent(initialPiSessionState(), rejection);
    const errors = rejected.blocks.filter(
      (b): b is PiErrorBlock => b.kind === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toBe(
      "prompt rejected: Agent is currently streaming; specify streamingBehavior",
    );
    expect(rejected.lastErrorText).toBe(
      "prompt rejected: Agent is currently streaming; specify streamingBehavior",
    );
    expect(rejected.status).toBe("idle");

    // A successful prompt response changes nothing, and a rejection without
    // an error string is ignored.
    const base = initialPiSessionState();
    expect(
      applyEvent(
        base,
        '{"command":"prompt","id":"2","success":true,"type":"response"}',
      ),
    ).toBe(base);
    expect(
      applyEvent(
        base,
        '{"command":"prompt","success":false,"type":"response"}',
      ),
    ).toBe(base);
  });
});

describe("local user attachment metadata", () => {
  it("records saved paths and write failures on the user message block", () => {
    let state = applyEvent(
      initialPiSessionState(),
      '{"type":"message_start","message":{"role":"user","content":"look"}}',
    );
    state = recordSavedAttachments(state, "msg-0", [
      { path: ".pi/attachments/0-0.png", error: null },
      { path: null, error: "disk full" },
    ]);
    const user = state.blocks[0];
    expect(user).toMatchObject({
      kind: "message",
      role: "user",
      savedAttachments: [
        { path: ".pi/attachments/0-0.png", error: null },
        { path: null, error: "disk full" },
      ],
    });
  });

  it("does not attach local metadata to an assistant block", () => {
    let state = applyEvent(
      initialPiSessionState(),
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
    );
    const unchanged = recordSavedAttachments(state, "msg-0", [
      { path: ".pi/attachments/0-0.png", error: null },
    ]);
    expect(unchanged).toBe(state);
  });
});
