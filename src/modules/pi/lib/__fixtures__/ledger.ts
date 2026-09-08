import type { ActionRecord, LedgerSnapshot, LedgerSource } from "@/modules/pi/lib/ledgerStore";

export function actionRecord(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    v: 1, eventId: "transition-1", sessionId: "session-1", turnId: null,
    actionId: "call-1", parentActionId: null, role: "worker", agentId: "worker-1", ticketId: "ticket-1",
    kind: "delegation", status: "done", startedAt: "2026-09-09T00:00:00.000Z", endedAt: "2026-09-09T00:00:02.500Z", durationMs: 2500,
    usage: { input: null, output: null, cacheRead: null, cost: null, currency: null, sourceEventId: "source-1" },
    evidencePath: "/project/.pi/agent-hub/run-1/worker-1.transcript.jsonl", ...overrides,
  };
}

export const assistantMessage = {
  role: "assistant", content: [{ type: "text", text: "Finished" }], timestamp: 1000,
  usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.04 } },
  stopReason: "stop",
};

export function sourceRecord(overrides: Partial<LedgerSource> = {}): LedgerSource & { v: 1 } {
  return { v: 1, eventId: "source-1", sessionId: "session-1", turnId: null, type: "turn_end", event: { type: "turn_end", sessionId: "session-1", message: assistantMessage }, ...overrides };
}

export function ledgerSnapshot(actions = [actionRecord()], sources = [sourceRecord()]): LedgerSnapshot {
  return { actions: Object.fromEntries(actions.map((action) => [action.actionId, action])), sources: Object.fromEntries(sources.map((source) => [source.eventId, source])), loaded: true, error: null };
}

export const jsonLines = (...records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
