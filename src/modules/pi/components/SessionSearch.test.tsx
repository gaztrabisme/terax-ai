// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { initialPiSessionState, type PiFeedItem } from "../lib/parse";
import { usePiStore } from "../lib/piStore";
import { SessionSearch, groupHits, snippetProbe, sessionLabel, sessionIdFromPath } from "./SessionSearch";
import type { PiSessionHit, PiSessionSummary } from "../lib/sessions";

const CWD = "/tmp/proj";
const AGENT_DIR = "/home/u/agent";
// The full id pi reports on agent_start; session FILES carry only its first
// eight characters (`<timestamp>_<short id>.jsonl`).
const CURRENT_ID = "019ea7c5-abcd-4e5f-8a1b-2c3d4e5f6a7b";
const PAST_PATH =
  "/a/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_bbbbbbbb.jsonl";

/** A saved past session in pi's jsonl shape, served by the fs_read_file mock. */
function pastSessionText(): string {
  return [
    '{"type":"session","version":3,"id":"bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb","timestamp":"2026-06-08T15:07:02.400Z","cwd":"/tmp/proj"}',
    '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-06-08T15:07:02.408Z","message":{"role":"user","content":[{"type":"text","text":"...please find the grail diary..."}]}}',
    '{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-06-08T15:07:05.778Z","message":{"role":"assistant","content":[{"type":"text","text":"cited"}],"model":"q","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"stop","timestamp":1}}',
    "",
  ].join("\n");
}

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

function seedTab(
  tabId: number,
  sessionId: string | null,
  blocks: PiFeedItem[] = [],
) {
  const send = vi.fn().mockResolvedValue(undefined);
  usePiStore.setState({
    tabs: {
      [tabId]: {
        gen: 1,
        state: { ...initialPiSessionState(), sessionId, blocks },
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

function currentBlock(): PiFeedItem {
  return {
    kind: "message",
    id: "msg-0",
    role: "user",
    parts: [{ type: "text", text: "live prompt" }],
    model: null,
    usage: null,
    streaming: false,
    at: 1000,
  };
}

describe("helpers", () => {
  it("formats local calendar days and time, including midnight and month boundaries", () => {
    const now = new Date(2026, 8, 1, 0, 5);
    expect(sessionLabel(new Date(2026, 8, 1, 0, 3).toISOString(), now)).toBe("today 00:03");
    expect(sessionLabel(new Date(2026, 7, 31, 9, 12).toISOString(), now)).toBe("yesterday 09:12");
    expect(sessionLabel(new Date(2026, 7, 30, 14, 3).toISOString(), now)).toBe("30 Aug 14:03");
    expect(sessionLabel("unavailable", now)).toBe("Time unavailable");
    expect(sessionIdFromPath("C:\\sessions\\2026-06-08T15-07-02-400Z_stable_id.jsonl")).toBe("stable_id");
  });
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
    expect(queryByText(sessionLabel("2026-06-08T15:07:02.400Z"))?.parentElement?.textContent)
      .toBe(`${sessionLabel("2026-06-08T15:07:02.400Z")} - 2 turns`);
    // Only the two read commands run: no search with an empty query.
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("pi_sessions_list");
    expect(cmds).not.toContain("pi_sessions_search");
    const listCall = invokeMock.mock.calls.find((c) => c[0] === "pi_sessions_list");
    expect(listCall?.[1]).toMatchObject({ cwd: CWD, agentDir: AGENT_DIR });
  });

  it("leads with one line of prompt and keeps the locator and stable id in the title and Copy id action", async () => {
    const saved = summary({ firstPrompt: "Find the\n  useful report" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pi_paths") return { runtimeAgentDir: { path: AGENT_DIR } };
      if (cmd === "pi_sessions_list") return [saved];
      throw new Error(`unexpected ${cmd}`);
    });
    const { findByText, getByRole, container } = render(<SessionSearch tabId={7} cwd={CWD} />);
    const prompt = await findByText("Find the useful report");
    const row = container.querySelector<HTMLButtonElement>('[data-uat="session-row"]')!;
    expect(row.firstElementChild).toBe(prompt);
    expect(prompt.classList.contains("truncate")).toBe(true);
    expect(row.title).toBe(`${saved.path}\nSession id: a`);
    expect(row.textContent).not.toContain(saved.path);
    expect(row.textContent).not.toContain(saved.startedAt);
    expect(row.getAttribute("aria-description")).toContain(saved.path);
    fireEvent.click(getByRole("button", { name: "Copy id" }));
    expect(writeText).toHaveBeenCalledWith("a");
    expect(invokeMock.mock.calls.some((call) => call[0] === "pi_sessions_search")).toBe(false);
  });

  it("uses summary prompts and turn counts for search rows without showing filename headers", async () => {
    const match = hit();
    const saved = summary({ path: match.path, firstPrompt: "Recover our research", turns: 8 });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pi_paths") return { runtimeAgentDir: { path: AGENT_DIR } };
      if (cmd === "pi_sessions_list") return [saved];
      if (cmd === "pi_sessions_search") return [match];
      throw new Error(`unexpected ${cmd}`);
    });
    const { findByText, container } = render(<SessionSearch tabId={7} cwd={CWD} query="grail" />);
    await findByText("Recover our research");
    const row = container.querySelector<HTMLButtonElement>('[data-uat="session-row"]')!;
    expect(row.firstElementChild?.textContent).toBe(saved.firstPrompt);
    expect(row.textContent).toContain("8 turns");
    expect(row.textContent).toContain(match.snippet);
    expect(row.title).toBe(`${match.path}\nSession id: other`);
    expect(container.textContent).not.toContain(".jsonl");
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

  it("a past hit reads the session file before switching and stages the parsed history", async () => {
    const send = seedTab(7, CURRENT_ID, [currentBlock()]);
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
        return Promise.resolve([hit({ path: PAST_PATH })]);
      }
      if (cmd === "fs_read_file") {
        return Promise.resolve({ kind: "text", content: pastSessionText() });
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
      expect(send).toHaveBeenCalledTimes(1);
    });
    // The file read preceded the wire command.
    const readIndex = invokeMock.mock.calls.findIndex(
      (c) => c[0] === "fs_read_file",
    );
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(invokeMock.mock.calls[readIndex]![1]).toMatchObject({
      path: PAST_PATH,
    });
    expect(invokeMock.mock.invocationCallOrder[readIndex]!).toBeLessThan(
      send.mock.invocationCallOrder[0]!,
    );
    const line = JSON.parse(send.mock.calls[0][0] as string);
    expect(line).toEqual({ type: "switch_session", sessionPath: PAST_PATH });
    // The parsed history is staged for the ack; the old transcript is still
    // the visible one and no scroll happened yet.
    expect(usePiStore.getState().tabs[7]!.pendingSwitch?.sessionId).toBe(
      "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(usePiStore.getState().tabs[7]!.pendingSwitch?.blocks).toHaveLength(2);
    expect(usePiStore.getState().tabs[7]!.state.blocks).toHaveLength(1);
    expect(scrollMock).not.toHaveBeenCalled();
  });

  it("a failed read keeps the conversation and names the file", async () => {
    const send = seedTab(7, CURRENT_ID, [currentBlock()]);
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
        return Promise.resolve([hit({ path: PAST_PATH })]);
      }
      if (cmd === "fs_read_file") {
        return Promise.reject(new Error("no such file"));
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
    const error = await findByText(`${PAST_PATH}: no such file`);
    expect(error).toBeTruthy();
    // Nothing was sent and the previous conversation stands.
    expect(send).not.toHaveBeenCalled();
    expect(
      usePiStore.getState().tabs[7]!.pendingSwitch ?? null,
    ).toBeNull();
    expect(usePiStore.getState().tabs[7]!.state.sessionId).toBe(CURRENT_ID);
    expect(usePiStore.getState().tabs[7]!.state.blocks).toHaveLength(1);
  });

  it("clicking a hit in the current session scrolls instead of switching", async () => {
    const send = seedTab(7, CURRENT_ID, [currentBlock()]);
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
          // pi's file name carries only the short id form.
          hit({
            path:
              "/a/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_019ea7c5.jsonl",
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
    // Scroll only: no file read, no switch, no reset.
    expect(send).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "fs_read_file"),
    ).toBe(false);
    expect(usePiStore.getState().tabs[7]!.state.blocks).toHaveLength(1);
  });

  it("hints when the tab has no project directory", async () => {
    const { findByText } = render(<SessionSearch tabId={7} cwd={undefined} />);
    expect(
      await findByText("Open the tab in a project directory to list its sessions."),
    ).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
