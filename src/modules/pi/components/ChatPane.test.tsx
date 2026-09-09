// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { composerProps, errorCards, invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  composerProps: [] as Array<{
    modelAcceptsImages?: boolean;
    placeholder?: string;
    onStop?: () => void;
  }>,
  errorCards: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// The header and the composer wiring are under test; the composer and
// transcript bodies are not. The composer mock records its props so the
// vision-flag wiring can be asserted.
vi.mock("./Composer", () => ({
  Composer: (props: {
    modelAcceptsImages?: boolean;
    placeholder?: string;
    onStop?: () => void;
  }) => {
    composerProps.push(props);
    return null;
  },
}));
vi.mock("./Transcript", () => ({
  Transcript: () => null,
  formatCost: (cost: number) =>
    cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`,
  ErrorCard: (props: { block: { text: string } }) => {
    errorCards.push(props.block.text);
    return null;
  },
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

  it("shows explicit no-turns-yet values in an idle strip (UX-14)", () => {
    seedTab(10, initialPiSessionState());
    const { getByText } = render(
      <ChatPane tabId={10} onOpenChild={() => {}} />,
    );
    const strip = getByText("pi").closest('[data-uat="session-strip"]')!;
    const tokens = strip.querySelector('[data-uat="turn-tokens"]')!;
    const cost = strip.querySelector('[data-uat="session-cost"]')!;
    expect(tokens.textContent).toBe("no turns yet");
    expect(cost.textContent).toBe("no turns yet");
  });

  it("shows cost unknown, never a blank or $0, when the provider priced nothing", () => {
    seedTab(3, replayFixture("q7-rpc-model-error.jsonl"));
    const { getByText } = render(
      <ChatPane tabId={3} onOpenChild={() => {}} />,
    );
    const strip = getByText("pi").closest('[data-uat="session-strip"]')!;
    const cost = strip.querySelector('[data-uat="session-cost"]')!;
    expect(cost.textContent).toBe("cost unknown");
    expect(strip.textContent).not.toMatch(/^\$/m);
  });

  it("shows Cancelling with a disabled Stop and no New session", () => {
    seedTab(
      7,
      replayFixture("q8-rpc-retry-success.jsonl", (raw) =>
        raw.includes('"type":"message_start"'),
      ),
    );
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        7: {
          ...s.tabs[7]!,
          state: { ...s.tabs[7]!.state, status: "cancelling" },
        },
      },
    }));
    const { getByText, queryByText } = render(
      <ChatPane tabId={7} onOpenChild={() => {}} />,
    );
    expect(getByText("cancelling")).toBeTruthy();
    const stop = getByText("Stop") as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(queryByText("New session")).toBeNull();
    // Escape is not bound during a cancel: nothing to re-cancel.
    expect(
      composerProps[composerProps.length - 1]?.onStop,
    ).toBeUndefined();
  });

  it("binds composer Escape to the stop action only while a turn is in flight", () => {
    seedTab(8, replayFixture("q8-rpc-retry-success.jsonl"));
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        8: { ...s.tabs[8]!, state: { ...s.tabs[8]!.state, status: "thinking" } },
      },
    }));
    render(<ChatPane tabId={8} onOpenChild={() => {}} />);
    expect(typeof composerProps[composerProps.length - 1]?.onStop).toBe(
      "function",
    );
  });

  it("an exited process never shows a stale thinking strip or Stop", () => {
    seedTab(9, replayFixture("q8-rpc-retry-success.jsonl"));
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        9: {
          ...s.tabs[9]!,
          exited: true,
          exitCode: 0,
          session: null,
          state: { ...s.tabs[9]!.state, status: "thinking" },
        },
      },
    }));
    const { getByText, queryByText } = render(
      <ChatPane tabId={9} onOpenChild={() => {}} />,
    );
    expect(getByText("exited (0)")).toBeTruthy();
    // The exited placeholder rides the composer props (its body is mocked).
    expect(
      composerProps[composerProps.length - 1]?.placeholder,
    ).toBe("Session exited");
    expect(getByText("New session")).toBeTruthy();
    expect(queryByText("Stop")).toBeNull();
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

describe("ChatPane session identity (F1b)", () => {
  const FULL_ID = "019ea7c5-abcd-4e5f-8a1b-2c3d4e5f6a7b";
  const SESSION_FILE =
    "/tmp/p/.pi/sessions/--tmp-p--/2026-06-08T15-07-02-400Z_019ea7c5.jsonl";

  afterEach(() => {
    cleanup();
    usePiStore.setState({ tabs: {} });
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("names the active session in the strip with the short id, full id and path in the title", () => {
    seedTab(30, { ...initialPiSessionState(), sessionId: FULL_ID });
    usePiStore.setState((s) => ({
      tabs: { ...s.tabs, 30: { ...s.tabs[30]!, sessionPath: SESSION_FILE } },
    }));
    const { getByText } = render(<ChatPane tabId={30} onOpenChild={() => {}} />);
    const id = getByText("019ea7c5");
    expect(id.getAttribute("data-uat")).toBe("session-id");
    expect(id.title).toBe(`${FULL_ID}\n${SESSION_FILE}`);
  });

  it("the title falls back to the id alone when no file path is known", () => {
    seedTab(31, { ...initialPiSessionState(), sessionId: FULL_ID });
    const { getByText } = render(<ChatPane tabId={31} onOpenChild={() => {}} />);
    expect(getByText("019ea7c5").title).toBe(FULL_ID);
  });

  it("resolves the live session's file from the project locator", async () => {
    invokeMock.mockResolvedValue({
      kind: "text",
      content: JSON.stringify({
        v: 1,
        sessions: [{ id: FULL_ID, path: ".pi/sessions/--tmp-p--/2026-06-08T15-07-02-400Z_019ea7c5.jsonl" }],
      }),
    });
    seedTab(32, { ...initialPiSessionState(), sessionId: FULL_ID });
    const { getByText } = render(
      <ChatPane tabId={32} cwd="/tmp/p" onOpenChild={() => {}} />,
    );
    await waitFor(() => {
      expect(getByText("019ea7c5").title).toBe(`${FULL_ID}\n${SESSION_FILE}`);
    });
  });

  it("a failed switch renders a file-naming error card and keeps the strip", () => {
    seedTab(33, { ...initialPiSessionState(), sessionId: FULL_ID });
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        33: {
          ...s.tabs[33]!,
          switchError: "/tmp/p/.pi/sessions/x.jsonl: no such file",
        },
      },
    }));
    render(<ChatPane tabId={33} onOpenChild={() => {}} />);
    expect(errorCards[errorCards.length - 1]).toBe(
      "/tmp/p/.pi/sessions/x.jsonl: no such file",
    );
  });

  it("a committed switch scrolls to the hit once the transcript rendered", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    document.body.innerHTML =
      '<div data-pi-chat="34"><div id="turn">saved prompt</div></div>';
    seedTab(34, { ...initialPiSessionState(), sessionId: FULL_ID });
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        34: { ...s.tabs[34]!, scrollRequest: { seq: 7, snippet: "...saved prompt..." } },
      },
    }));
    render(<ChatPane tabId={34} onOpenChild={() => {}} />);
    await waitFor(() => {
      expect(scroll).toHaveBeenCalledWith({ block: "center" });
    });
    await waitFor(() => {
      expect(usePiStore.getState().tabs[34]!.scrollRequest).toBeNull();
    });
  });
});
