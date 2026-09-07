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
  resetAsk,
  type PiBlock,
  type PiErrorBlock,
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
