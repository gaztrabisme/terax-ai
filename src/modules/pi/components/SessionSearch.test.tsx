// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { initialPiSessionState } from "../lib/parse";
import { usePiStore } from "../lib/piStore";
import { SessionSearch, groupHits, snippetProbe } from "./SessionSearch";
import type { PiSessionHit, PiSessionSummary } from "../lib/sessions";

const CWD = "/tmp/proj";
const AGENT_DIR = "/home/u/agent";
const CURRENT_ID = "019ea7c5-current";

function summary(over: Partial<PiSessionSummary>): PiSessionSummary {
  return {
    path: `/a/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_a.jsonl`,
    startedAt: "2026-06-08T15:07:02.400Z",
    firstPrompt: "first prompt",
    turns: 2,
    tokens: 413,
    ...over,
  };
}

function hit(over: Partial<PiSessionHit> = {}): PiSessionHit {
  return {
    path: `/a/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_other.jsonl`,
    startedAt: "2026-06-08T15:07:02.400Z",
    role: "user",
    snippet: "...please find the grail diary...",
    ...over,
  };
}

function seedTab(tabId: number, sessionId: string | null) {
  const send = vi.fn().mockResolvedValue(undefined);
  usePiStore.setState({
    tabs: {
      [tabId]: {
        gen: 1,
        state: { ...initialPiSessionState(), sessionId },
        session: { id: 9, send, kill: vi.fn().mockResolvedValue(undefined) },
        exited: false,
        exitCode: null,
        error: null,
        roles: { provider: "omlx", model: "q", smol: "" },
      },
    },
  });
  return send;
}

describe("helpers", () => {
  it("snippetProbe strips cut edges and folds whitespace", () => {
    expect(snippetProbe("...please find the grail diary...")).toBe(
      "please find the grail diary",
    );
    expect(snippetProbe("a\n b   c")).toBe("a b c");
    expect(snippetProbe("")).toBe("");
  });

  it("groupHits groups per session preserving first-seen order", () => {
    const grouped = groupHits([
      hit({ path: "/a/1.jsonl" }),
      hit({ path: "/a/2.jsonl" }),
      hit({ path: "/a/1.jsonl", role: "assistant" }),
    ]);
    expect(grouped.map(([path]) => path)).toEqual(["/a/1.jsonl", "/a/2.jsonl"]);
    expect(grouped[0][1]).toHaveLength(2);
  });
});

describe("SessionSearch", () => {
  let scrollMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    scrollMock = vi.fn();
    // jsdom has no layout engine: stub the scroll the flash helper needs.
    Element.prototype.scrollIntoView = scrollMock;
  });

  afterEach(() => {
    cleanup();
    usePiStore.setState({ tabs: {} });
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("lists the cwd's sessions when the query is empty", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pi_paths") {
        return Promise.resolve({
          pi: { path: "/pi", source: "pref", candidates: [] },
          agent: { path: "/agent", source: "pref", candidates: [] },
          agentDir: { path: AGENT_DIR, source: "pref", candidates: [] },
          runtimeAgentDir: { path: AGENT_DIR, source: "pref", seeded: true },
        });
      }
      if (cmd === "pi_sessions_list") {
        return Promise.resolve([
          summary({ firstPrompt: "newest first prompt" }),
          summary({
            path: "/a/sessions/--tmp-proj--/2026-06-07T15-07-02-400Z_b.jsonl",
            startedAt: "2026-06-07T15:07:02.400Z",
            firstPrompt: "older prompt",
            turns: 1,
            tokens: 10,
          }),
        ]);
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { findByText, queryByText } = render(
      <SessionSearch tabId={7} cwd={CWD} />,
    );
    expect(
      await findByText("newest first prompt"),
    ).toBeTruthy();
    expect(queryByText("older prompt")).toBeTruthy();
    expect(
      queryByText("2026-06-08 15:07 - 2 turns - 413 tok"),
    ).toBeTruthy();
    // Only the two read commands run: no search with an empty query.
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("pi_sessions_list");
    expect(cmds).not.toContain("pi_sessions_search");
    const listCall = invokeMock.mock.calls.find((c) => c[0] === "pi_sessions_list");
    expect(listCall?.[1]).toMatchObject({ cwd: CWD, agentDir: AGENT_DIR });
  });

  it("searches on input and renders hits grouped per session", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pi_paths") {
        return Promise.resolve({
          pi: { path: "/pi", source: "pref", candidates: [] },
          agent: { path: "/agent", source: "pref", candidates: [] },
          agentDir: { path: AGENT_DIR, source: "pref", candidates: [] },
          runtimeAgentDir: { path: AGENT_DIR, source: "pref", seeded: true },
        });
      }
      if (cmd === "pi_sessions_list") return Promise.resolve([]);
      if (cmd === "pi_sessions_search") {
        return Promise.resolve([
          hit(),
          hit({
            path: "/a/sessions/--tmp-proj--/2026-06-09T15-07-02-400Z_c.jsonl",
            role: "assistant",
            snippet: "...the grail diary is cited...",
          }),
        ]);
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { findByText, getByLabelText, queryByText } = render(
      <SessionSearch tabId={7} cwd={CWD} />,
    );
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "pi_sessions_list"),
      ).toBe(true);
    });
    fireEvent.change(getByLabelText("Search pi sessions"), {
      target: { value: "grail" },
    });
    await findByText("...please find the grail diary...");
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(
        (c) => c[0] === "pi_sessions_search",
      );
      expect(call?.[1]).toMatchObject({
        cwd: CWD,
        agentDir: AGENT_DIR,
        query: "grail",
        limit: 20,
      });
    });
    expect(queryByText("...the grail diary is cited...")).toBeTruthy();
    expect(queryByText("assistant")).toBeTruthy();
  });

  it("clicking a hit in another session sends switch_session", async () => {
    const send = seedTab(7, CURRENT_ID);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pi_paths") {
        return Promise.resolve({
          pi: { path: "/pi", source: "pref", candidates: [] },
          agent: { path: "/agent", source: "pref", candidates: [] },
          agentDir: { path: AGENT_DIR, source: "pref", candidates: [] },
          runtimeAgentDir: { path: AGENT_DIR, source: "pref", seeded: true },
        });
      }
      if (cmd === "pi_sessions_list") return Promise.resolve([]);
      if (cmd === "pi_sessions_search") return Promise.resolve([hit()]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { findByText, getByLabelText } = render(
      <SessionSearch tabId={7} cwd={CWD} />,
    );
    fireEvent.change(getByLabelText("Search pi sessions"), {
      target: { value: "grail" },
    });
    fireEvent.click(await findByText("...please find the grail diary..."));
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const line = JSON.parse(send.mock.calls[0][0] as string);
    expect(line).toEqual({
      type: "switch_session",
      sessionPath:
        "/a/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_other.jsonl",
    });
    expect(scrollMock).not.toHaveBeenCalled();
  });

  it("clicking a hit in the current session scrolls instead of switching", async () => {
    const send = seedTab(7, CURRENT_ID);
    document.body.innerHTML =
      '<div data-pi-chat="7"><div id="turn">please find the grail diary</div></div>';
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pi_paths") {
        return Promise.resolve({
          pi: { path: "/pi", source: "pref", candidates: [] },
          agent: { path: "/agent", source: "pref", candidates: [] },
          agentDir: { path: AGENT_DIR, source: "pref", candidates: [] },
          runtimeAgentDir: { path: AGENT_DIR, source: "pref", seeded: true },
        });
      }
      if (cmd === "pi_sessions_list") return Promise.resolve([]);
      if (cmd === "pi_sessions_search") {
        return Promise.resolve([
          hit({
            path: `/a/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_${CURRENT_ID}.jsonl`,
          }),
        ]);
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { findByText, getByLabelText } = render(
      <SessionSearch tabId={7} cwd={CWD} />,
    );
    fireEvent.change(getByLabelText("Search pi sessions"), {
      target: { value: "grail" },
    });
    fireEvent.click(await findByText("...please find the grail diary..."));
    await waitFor(() => {
      expect(scrollMock).toHaveBeenCalledTimes(1);
    });
    expect(scrollMock.mock.calls[0][0]).toEqual({ block: "center" });
    expect(send).not.toHaveBeenCalled();
  });

  it("hints when the tab has no project directory", async () => {
    const { findByText } = render(<SessionSearch tabId={7} cwd={undefined} />);
    expect(
      await findByText("Open the tab in a project directory to list its sessions."),
    ).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
