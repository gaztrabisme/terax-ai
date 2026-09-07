// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// The header is under test; the composer and transcript bodies are not.
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./Transcript", () => ({
  Transcript: () => null,
  formatCost: (cost: number) =>
    cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`,
}));

import {
  initialPiSessionState,
  applyEvent,
  type PiSessionState,
} from "../lib/parse";
import { usePiStore } from "../lib/piStore";
import { ChatPane } from "./ChatPane";

const here = path.dirname(fileURLToPath(import.meta.url));

function replayFixture(
  fixture: string,
  stopOn?: (raw: string) => boolean,
): PiSessionState {
  const text = readFileSync(
    path.join(here, "../lib/__fixtures__", fixture),
    "utf8",
  );
  const raws = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { dir: string; raw: string })
    .filter((entry) => entry.dir === "stdout")
    .map((entry) => entry.raw);
  let state = initialPiSessionState();
  for (const raw of raws) {
    const next = applyEvent(state, raw, 1000);
    state = { ...state, ...next };
    if (stopOn?.(raw)) break;
  }
  return state;
}

function seedTab(tabId: number, state: PiSessionState) {
  usePiStore.setState({
    tabs: {
      [tabId]: {
        gen: 1,
        state,
        session: null,
        exited: false,
        exitCode: null,
        error: null,
        roles: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          smol: "omlx/q",
        },
      },
    },
  });
}

describe("ChatPane header chip", () => {
  afterEach(() => {
    cleanup();
    usePiStore.setState({ tabs: {} });
  });

  it("shows the pending retry instead of the running label, with Stop", () => {
    const pending = replayFixture("q8-rpc-retry-success.jsonl", (raw) =>
      raw.includes('"type":"auto_retry_start"'),
    );
    seedTab(1, pending);
    const { getByText, queryByText } = render(
      <ChatPane tabId={1} onOpenChild={() => {}} />,
    );
    expect(getByText("retrying 1/3 in 4 s")).toBeTruthy();
    expect(getByText("Stop")).toBeTruthy();
    expect(queryByText("New session")).toBeNull();
  });

  it("shows session token and cost totals, never a $0", () => {
    seedTab(2, replayFixture("q8-rpc-retry-success.jsonl"));
    const { getByText, queryByText } = render(
      <ChatPane tabId={2} onOpenChild={() => {}} />,
    );
    expect(getByText("done")).toBeTruthy();
    expect(getByText("11,216 tok")).toBeTruthy();
    expect(getByText("$0.0031")).toBeTruthy();
    expect(queryByText("$0.0000")).toBeNull();
  });

  it("shows no cost chip when the session billed nothing", () => {
    seedTab(3, replayFixture("q7-rpc-model-error.jsonl"));
    const { queryByText } = render(
      <ChatPane tabId={3} onOpenChild={() => {}} />,
    );
    expect(queryByText(/^\$/)).toBeNull();
  });
});
