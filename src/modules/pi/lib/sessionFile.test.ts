import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  loadSessionFile,
  parseSessionFile,
  pathMatchesSessionId,
  readSessionFileText,
  restoredUsageTotals,
  resolveSessionPath,
  shortSessionId,
} from "./sessionFile";

const CWD = "/tmp/proj";
const PATH = `${CWD}/.pi/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_019ea7c5.jsonl`;
const FULL_ID = "019ea7c5-abcd-4e5f-8a1b-2c3d4e5f6a7b";

/** A saved session in pi's own jsonl shape (Rust twin: sessions.rs tests). */
function sessionFileText(): string {
  return [
    `{"type":"session","version":3,"id":"${FULL_ID}","timestamp":"2026-06-08T15:07:02.400Z","cwd":"${CWD}"}`,
    `{"type":"message","id":"e1","parentId":null,"timestamp":"2026-06-08T15:07:02.408Z","message":{"role":"user","content":[{"type":"text","text":"find the RECOVER_QUARTZ_17 marker"}]}}`,
    `{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-06-08T15:07:05.778Z","message":{"role":"assistant","content":[{"type":"text","text":"here it is"}],"api":"openai-completions","provider":"omlx","model":"q","usage":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":12,"cost":{"total":0.004}},"stopReason":"stop","timestamp":1780931222452}}`,
    `{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-06-08T15:07:06.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"tool output"}],"is_error":false,"timestamp":1780931222460}}`,
    `{"type":"summary","id":"s1","tokenized":"text"}`,
    `not json at all`,
    `{"type":"message","id":"e4","parentId":null,"timestamp":"2026-06-08T15:08:00.000Z","message":{"role":"user","content":"plain string prompt"}}`,
    "",
  ].join("\n");
}

describe("parseSessionFile", () => {
  it("reads the header id and user/assistant messages as h-prefixed blocks", () => {
    const parsed = parseSessionFile(sessionFileText());
    expect(parsed.sessionId).toBe(FULL_ID);
    expect(parsed.blocks).toHaveLength(3);
    const [user, assistant, plain] = parsed.blocks;
    expect(user && user.kind === "message" && user.id).toBe("h-1");
    expect(user && user.kind === "message" && user.role).toBe("user");
    expect(
      user?.kind === "message" &&
        user.parts[0] &&
        user.parts[0].type === "text" &&
        user.parts[0].text,
    ).toBe("find the RECOVER_QUARTZ_17 marker");
    expect(assistant && assistant.kind === "message" && assistant.model).toBe("q");
    expect(
      assistant?.kind === "message" && assistant.usage?.totalTokens,
    ).toBe(12);
    expect(
      assistant?.kind === "message" && assistant.usage?.costTotal,
    ).toBeCloseTo(0.004, 6);
    expect(assistant?.kind === "message" && assistant.stopReason).toBe("stop");
    expect(assistant?.kind === "message" && assistant.streaming).toBe(false);
    // Plain-string user content normalizes to one text part; toolResult and
    // non-message entries never become blocks; bad lines are skipped.
    expect(
      plain?.kind === "message" && plain.parts[0]?.type === "text" &&
        plain.parts[0].text,
    ).toBe("plain string prompt");
  });

  it("pins block timestamps from the entry timestamps", () => {
    const parsed = parseSessionFile(sessionFileText());
    const first = parsed.blocks[0];
    expect(first?.kind === "message" && first.at).toBe(
      Date.parse("2026-06-08T15:07:02.408Z"),
    );
  });

  it("tolerates a file with no header id when messages exist", () => {
    const parsed = parseSessionFile(
      `{"type":"message","message":{"role":"user","content":"hi"}}`,
    );
    expect(parsed.sessionId).toBeNull();
    expect(parsed.blocks).toHaveLength(1);
  });
});

describe("readSessionFileText and loadSessionFile", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns the text content through the project-file read", async () => {
    invokeMock.mockResolvedValue({ kind: "text", content: sessionFileText() });
    await expect(readSessionFileText(PATH)).resolves.toBe(sessionFileText());
    expect(invokeMock.mock.calls[0][0]).toBe("fs_read_file");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ path: PATH });
  });

  it("names the path when the read fails or the file is not text", async () => {
    invokeMock.mockRejectedValue(new Error("no such file"));
    await expect(readSessionFileText(PATH)).rejects.toThrow(
      `${PATH}: no such file`,
    );
    invokeMock.mockResolvedValue({ kind: "binary", size: 3 });
    await expect(loadSessionFile(PATH)).rejects.toThrow(
      `${PATH}: not readable as text (pi session file expected)`,
    );
  });

  it("refuses a file with neither header nor messages, naming the path", async () => {
    invokeMock.mockResolvedValue({ kind: "text", content: "hello\nworld\n" });
    await expect(loadSessionFile(PATH)).rejects.toThrow(
      `${PATH}: no pi session header or messages found`,
    );
  });

  it("loads and parses a good file", async () => {
    invokeMock.mockResolvedValue({ kind: "text", content: sessionFileText() });
    const parsed = await loadSessionFile(PATH);
    expect(parsed.sessionId).toBe(FULL_ID);
    expect(parsed.blocks).toHaveLength(3);
  });
});

describe("pathMatchesSessionId", () => {
  it("matches pi's <timestamp>_<short id>.jsonl name against the full id", () => {
    expect(pathMatchesSessionId(PATH, FULL_ID)).toBe(true);
    expect(
      pathMatchesSessionId(
        `${CWD}/.pi/sessions/--tmp-proj--/2026-06-09T09-00-00-000Z_ffffffff.jsonl`,
        FULL_ID,
      ),
    ).toBe(false);
    expect(
      pathMatchesSessionId(PATH, "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb"),
    ).toBe(false);
  });

  it("uses the whole id when it is shorter than the short form", () => {
    expect(pathMatchesSessionId("/a/2026-06-08T15-07-02-400Z_abc.jsonl", "abc")).toBe(true);
  });

  it("shortSessionId takes pi's first eight characters", () => {
    expect(shortSessionId(FULL_ID)).toBe("019ea7c5");
    expect(shortSessionId("abc")).toBe("abc");
  });
});

describe("restoredUsageTotals", () => {
  it("sums assistant usage for the strip totals", () => {
    const parsed = parseSessionFile(sessionFileText());
    const totals = restoredUsageTotals(parsed.blocks);
    expect(totals.turnTokens).toBe(12);
    expect(totals.sessionCost).toBeCloseTo(0.004, 6);
    expect(totals.turnUsage?.totalTokens).toBe(12);
  });

  it("reads zero for a transcript with no usage", () => {
    const parsed = parseSessionFile(
      `{"type":"session","id":"x","cwd":"${CWD}"}\n{"type":"message","message":{"role":"user","content":"hi"}}`,
    );
    const totals = restoredUsageTotals(parsed.blocks);
    expect(totals).toEqual({ turnTokens: 0, sessionCost: 0, turnUsage: null });
  });
});

describe("resolveSessionPath", () => {
  it("joins the locator's project-relative path onto the cwd", async () => {
    invokeMock.mockResolvedValue({
      kind: "text",
      content: JSON.stringify({
        v: 1,
        lastSessionId: FULL_ID,
        sessions: [
          {
            id: FULL_ID,
            path: ".pi/sessions/--tmp-proj--/2026-06-08T15-07-02-400Z_019ea7c5.jsonl",
            cwd: CWD,
            createdAt: "2026-06-08T15:07:02.400Z",
            lastTurnId: null,
          },
        ],
      }),
    });
    await expect(resolveSessionPath(CWD, FULL_ID)).resolves.toBe(PATH);
  });

  it("returns null on any failure or mismatch", async () => {
    invokeMock.mockRejectedValue(new Error("gone"));
    await expect(resolveSessionPath(CWD, FULL_ID)).resolves.toBeNull();
    invokeMock.mockResolvedValue({
      kind: "text",
      content: JSON.stringify({ v: 1, sessions: [{ id: "other", path: "x" }] }),
    });
    await expect(resolveSessionPath(CWD, FULL_ID)).resolves.toBeNull();
    invokeMock.mockResolvedValue({ kind: "binary", size: 1 });
    await expect(resolveSessionPath(CWD, FULL_ID)).resolves.toBeNull();
  });
});
