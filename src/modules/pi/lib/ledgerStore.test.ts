import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { actionRecord, assistantMessage, jsonLines, ledgerSnapshot, sourceRecord } from "@/modules/pi/lib/__fixtures__/ledger";
import { actionDuration, actionTurnKey, ledgerDiscrepancies, ledgerPath, parseLedger, refreshLedger, resetLedgerStore, useLedgerStore, watchLedger } from "@/modules/pi/lib/ledgerStore";
import { applyEvent, initialPiSessionState, type PiSessionState } from "@/modules/pi/lib/parse";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));

const files = new Map<string, string>();
const path = ledgerPath("/project", "session-1");
const sourcePath = "/project/.pi/logs/session.jsonl";
const snapshot = () => useLedgerStore.getState().sessions[path];

beforeEach(() => {
  resetLedgerStore(); files.clear(); vi.clearAllMocks();
  files.set(path, jsonLines(actionRecord()));
  files.set(sourcePath, jsonLines(sourceRecord()));
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const file = (args as { path: string }).path;
    if (!files.has(file)) throw new Error("ENOENT");
    return { kind: "text", content: files.get(file) };
  });
});
afterEach(() => { resetLedgerStore(); vi.useRealTimers(); });

describe("persisted ledger reader", () => {
  it("parses the measured null usage and null turnId shape without creating usage", () => {
    const record = actionRecord();
    expect(parseLedger(jsonLines(record)).rows).toEqual({ "call-1": record });
    expect(actionDuration(record)).toBe(2500);
    expect(actionDuration(actionRecord({ startedAt: null, durationMs: 500 }))).toBeNull();
    expect(ledgerPath("C:\\project", "../session/a")).toBe("C:/project/.pi/runs/%2E%2E%2Fsession%2Fa/actions.jsonl");
  });

  it("tails only complete lines and replaces the same actionId on a correction", () => {
    const start = actionRecord({ eventId: "start", status: "running", endedAt: null });
    const finish = actionRecord();
    const partial = JSON.stringify(finish).slice(0, 35);
    const initial = parseLedger(jsonLines(start) + partial);
    expect(initial.rows["call-1"].status).toBe("running");
    const final = parseLedger(jsonLines(start, finish), initial);
    expect(Object.values(final.rows)).toEqual([finish]);
    expect(parseLedger(jsonLines(start, finish), final).rows).toBe(final.rows);
    expect(parseLedger(jsonLines(start), final).rows).toEqual({ "call-1": start });
  });

  it("rejects complete malformed lines and invalid fields with their line number", () => {
    expect(() => parseLedger(jsonLines(actionRecord()) + "bad\n")).toThrow("line 2");
    expect(() => parseLedger(jsonLines({ ...actionRecord(), usage: { input: -1 } }))).toThrow("invalid action usage");
    expect(parseLedger("{broken").rows).toEqual({});
  });

  it("keeps opaque action IDs as data, including object prototype names", () => {
    const actions = parseLedger(jsonLines(actionRecord({ actionId: "__proto__" }), actionRecord({ actionId: "constructor" })));
    expect(Object.keys(actions.rows)).toEqual(["__proto__", "constructor"]);
    expect(actions.rows.__proto__.actionId).toBe("__proto__");
    expect(Object.getPrototypeOf(actions.rows)).toBeNull();
  });

  it("loads through project file IPC and keeps a stale snapshot on failure, then recovers", async () => {
    await refreshLedger("/project", "session-1");
    expect(snapshot().actions["call-1"]).toEqual(actionRecord());
    expect(invoke).toHaveBeenCalledWith("fs_read_file", { path, workspace: { kind: "local" } });
    files.set(path, jsonLines(actionRecord()) + "{bad}\n");
    await refreshLedger("/project", "session-1");
    expect(snapshot().error).toContain("line 2");
    expect(snapshot().error).toContain(path);
    expect(snapshot().actions["call-1"].status).toBe("done");
    files.set(path, jsonLines(actionRecord({ status: "failed" })));
    await refreshLedger("/project", "session-1");
    expect(snapshot().error).toBeNull();
    expect(snapshot().actions["call-1"].status).toBe("failed");
    files.delete(path);
    await refreshLedger("/project", "session-1");
    expect(snapshot().error).toContain("ENOENT");
  });

  it("polls every two seconds only in flight, reads once on idle and shares subscribers", async () => {
    vi.useFakeTimers();
    const stop = watchLedger("/project", "session-1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(invoke).toHaveBeenCalledTimes(2);
    files.set(path, jsonLines(actionRecord({ status: "failed" })));
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot().actions["call-1"].status).toBe("failed");
    const second = watchLedger("/project", "session-1", true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(invoke).mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoke).toHaveBeenCalledTimes(2);
    stop(); second();
    const idle = watchLedger("/project", "session-1", false);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(invoke).mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    expect(invoke).not.toHaveBeenCalled();
    idle();
  });

  it("isolates sessions and reports a record in the wrong session directory", async () => {
    files.set(ledgerPath("/project", "session-2"), jsonLines(actionRecord({ sessionId: "session-2", actionId: "second" })));
    await Promise.all([refreshLedger("/project", "session-1"), refreshLedger("/project", "session-2")]);
    expect(Object.keys(snapshot().actions)).toEqual(["call-1"]);
    files.set(path, jsonLines(actionRecord({ sessionId: "session-2" })));
    await refreshLedger("/project", "session-1");
    expect(snapshot().error).toContain("different session");
  });

  it("resolves the owning user turn from the exact source message while turnId stays null", () => {
    const blocks = [
      { type: "message_start", message: { role: "user", content: "Do work" } },
      { type: "message_start", message: assistantMessage },
      { type: "message_end", message: assistantMessage },
      sourceRecord().event,
    ].reduce<PiSessionState>((state, event) => applyEvent(state, JSON.stringify(event)), initialPiSessionState()).blocks;
    expect(actionTurnKey(actionRecord({ actionId: "answer" }), ledgerSnapshot(), blocks)).toBe("msg-0");
  });

  it("names both displayed and missing source values after idle and clears on source arrival", async () => {
    files.set(sourcePath, jsonLines({ check: "delegation", verdict: "allow" }));
    await refreshLedger("/project", "session-1");
    expect(ledgerDiscrepancies(snapshot(), true)).toEqual([]);
    expect(ledgerDiscrepancies(snapshot(), false)[0]).toMatch(/^usage-discrepancy:.*displayed=.*source=missing event source-1.*\.pi\/logs\/session.jsonl/);
    files.set(sourcePath, jsonLines(sourceRecord()));
    await refreshLedger("/project", "session-1");
    expect(ledgerDiscrepancies(snapshot(), false)).toEqual([]);
  });
});
