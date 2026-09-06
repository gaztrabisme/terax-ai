import { beforeEach, describe, expect, it } from "vitest";
import { recommendedAnswers } from "./KeystoneCard";
import { applyEvent, initialPiSessionState } from "@/modules/pi/lib/parse";
import type { PiSessionHandle } from "@/modules/pi/lib/rpc-client";
import { usePiStore } from "@/modules/pi/lib/piStore";

// The card → store → rpc-client path must emit pi's exact wire lines. The
// session handle stands in for the rpc-client transport and captures what a
// send puts on the wire.
const wire = { sent: [] as string[] };

const fakeSession: PiSessionHandle = {
  id: 1,
  send: async (line: string) => {
    wire.sent.push(line);
  },
  kill: async () => {},
};

const ASK_REQUEST =
  '{"type":"ask_request","id":"req-1","timeoutMs":300000,"questions":[{"question":"Proceed?","header":"Status","multi":false,"recommended":0,"options":[{"label":"Yes","description":"Proceed"},{"label":"No","description":"Do not proceed"}]}]}';

function mountAsk(tabId: number, requestId: string) {
  let state = initialPiSessionState();
  state = applyEvent(state, ASK_REQUEST.replace("req-1", requestId));
  usePiStore.setState((s) => ({
    tabs: {
      ...s.tabs,
      [tabId]: {
        state,
        session: fakeSession,
        exited: false,
        exitCode: null,
        error: null,
      },
    },
  }));
}

function askCard(tabId: number) {
  const state = usePiStore.getState().tabs[tabId].state;
  const card = state.blocks.find((b) => b.kind === "ask");
  if (!card || card.kind !== "ask") throw new Error("no ask card in state");
  return card;
}

describe("KeystoneCard wire form", () => {
  beforeEach(() => {
    wire.sent.length = 0;
    usePiStore.setState({ tabs: {} });
  });

  it("approve sends exactly the pi ask_response shape", async () => {
    mountAsk(1, "req-1");
    expect(askCard(1).state).toBe("pending");

    const answers = recommendedAnswers(askCard(1));
    expect(answers).toEqual([{ questionId: "0", selected: ["Yes"] }]);

    await usePiStore.getState().answerAsk(1, "req-1", answers);
    expect(wire.sent).toEqual([
      '{"type":"ask_response","requestId":"req-1","answers":[{"questionId":"0","selected":["Yes"]}]}',
    ]);
  });

  it("reject sends dismissed true", async () => {
    mountAsk(1, "req-1");
    await usePiStore.getState().dismissAsk(1, "req-1");
    expect(wire.sent).toEqual([
      '{"type":"ask_response","requestId":"req-1","dismissed":true}',
    ]);
  });

  it("an explicit question id overrides the index in the answer", async () => {
    mountAsk(2, "req-2");
    let state = usePiStore.getState().tabs[2].state;
    state = applyEvent(
      state,
      '{"type":"ask_request","id":"req-3","timeoutMs":1000,"questions":[{"question":"Proceed?","id":"q1","recommended":1,"options":[{"label":"Yes"},{"label":"No"}]}]}',
    );
    const card = state.blocks.find(
      (b) => b.kind === "ask" && b.requestId === "req-3",
    );
    if (!card || card.kind !== "ask") throw new Error("no explicit-id card");
    expect(recommendedAnswers(card)).toEqual([
      { questionId: "q1", selected: ["No"] },
    ]);
  });
});
