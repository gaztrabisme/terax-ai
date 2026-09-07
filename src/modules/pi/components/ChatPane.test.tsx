// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { composerProps, invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  composerProps: [] as Array<{ modelAcceptsImages?: boolean }>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// The header and the composer wiring are under test; the composer and
// transcript bodies are not. The composer mock records its props so the
// vision-flag wiring can be asserted.
vi.mock("./Composer", () => ({
  Composer: (props: { modelAcceptsImages?: boolean }) => {
    composerProps.push(props);
    return null;
  },
}));
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

describe("ChatPane composer vision flag", () => {
  afterEach(() => {
    cleanup();
    composerProps.length = 0;
    invokeMock.mockReset();
    usePiStore.setState({ tabs: {}, modelRows: {} });
  });

  it("passes true from the cached table when the model accepts images", () => {
    seedTab(4, replayFixture("q8-rpc-retry-success.jsonl"));
    usePiStore.setState({
      modelRows: {
        anthropic: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            context: "200K",
            maxOut: "64K",
            thinking: true,
            images: true,
          },
        ],
      },
    });
    render(<ChatPane tabId={4} onOpenChild={() => {}} />);
    expect(composerProps[composerProps.length - 1]?.modelAcceptsImages).toBe(true);
  });

  it("passes false for a row with images no and undefined without a table", () => {
    seedTab(5, replayFixture("q8-rpc-retry-success.jsonl"));
    usePiStore.setState({
      modelRows: {
        anthropic: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            context: "200K",
            maxOut: "64K",
            thinking: true,
            images: false,
          },
        ],
      },
    });
    const { unmount } = render(<ChatPane tabId={5} onOpenChild={() => {}} />);
    expect(composerProps[composerProps.length - 1]?.modelAcceptsImages).toBe(false);
    unmount();
    composerProps.length = 0;

    // No cached rows: the flag stays undefined so the notice keeps its
    // conservative "may not accept" text.
    usePiStore.setState({ modelRows: {} });
    render(<ChatPane tabId={5} onOpenChild={() => {}} />);
    expect(composerProps[composerProps.length - 1]?.modelAcceptsImages).toBeUndefined();
  });

  it("fetches the model rows for the tab's provider once", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pi_list_models") {
        return [
          "provider   model              context  max-out  thinking  images",
          "anthropic  claude-sonnet-4-5  1M       128K     yes       yes",
        ].join("\n");
      }
      throw new Error(`${cmd} unavailable in test`);
    });
    seedTab(6, replayFixture("q8-rpc-retry-success.jsonl"));
    usePiStore.setState({ modelRows: {} });
    render(<ChatPane tabId={6} onOpenChild={() => {}} />);
    await waitFor(() => {
      expect(
        usePiStore.getState().modelRows.anthropic?.map((r) => r.model),
      ).toEqual(["claude-sonnet-4-5"]);
    });
    expect(invokeMock).toHaveBeenCalledWith("pi_list_models", {
      prefs: { launcherDir: "", agentDir: "" },
      pattern: null,
    });
    await waitFor(() => {
      expect(composerProps[composerProps.length - 1]?.modelAcceptsImages).toBe(true);
    });
  });
});
