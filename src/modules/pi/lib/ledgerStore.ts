import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { messageSourceKey, type PiFeedItem, type PiSessionState } from "@/modules/pi/lib/parse";

export type ActionRecord = {
  v: 1;
  eventId: string;
  sessionId: string | null;
  turnId: string | null;
  actionId: string;
  parentActionId: string | null;
  role: string | null;
  agentId: string | null;
  ticketId: string | null;
  kind: "tool" | "delegation" | "acceptance" | "human-decision" | "preparation" | "answer";
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  usage: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cost: number | null;
    currency: string | null;
    sourceEventId: string | null;
  };
  evidencePath: string | null;
};

export type LedgerSource = {
  eventId: string;
  sessionId: string | null;
  turnId: string | null;
  type: string;
  event: Record<string, unknown>;
};

type JsonlTail<T> = { text: string; offset: number; rows: Record<string, T> };
export type LedgerSnapshot = {
  actions: Record<string, ActionRecord>;
  sources: Record<string, LedgerSource>;
  loaded: boolean;
  error: string | null;
};
export const EMPTY_LEDGER: LedgerSnapshot = {
  actions: Object.create(null), sources: Object.create(null), loaded: false, error: null,
};
export const LEDGER_POLL_MS = 2000;
export const SESSION_LOG = ".pi/logs/session.jsonl";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const nullableString = (v: unknown) => v === null || (typeof v === "string" && v.length > 0);
const nullableNumber = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

export function parseAction(value: unknown): ActionRecord {
  if (!object(value) || value.v !== 1 ||
    !["eventId", "actionId"].every((k) => typeof value[k] === "string" && value[k]) ||
    !["sessionId", "turnId", "parentActionId", "role", "agentId", "ticketId", "evidencePath"].every((k) => nullableString(value[k])) ||
    !["tool", "delegation", "acceptance", "human-decision", "preparation", "answer"].includes(String(value.kind)) ||
    !["running", "done", "failed", "cancelled"].includes(String(value.status)) ||
    !["startedAt", "endedAt"].every((k) => value[k] === null || (typeof value[k] === "string" && Number.isFinite(Date.parse(value[k])))) ||
    !nullableNumber(value.durationMs) || !object(value.usage)) {
    throw new Error("invalid action record");
  }
  const usage = value.usage;
  if (!["input", "output", "cacheRead", "cost"].every((k) => nullableNumber(usage[k])) ||
    !nullableString(usage.currency) || !nullableString(usage.sourceEventId)) {
    throw new Error("invalid action usage");
  }
  return value as ActionRecord;
}

function parseSource(value: unknown): LedgerSource | null {
  if (!object(value)) throw new Error("invalid source log record");
  // The board extension writes other record shapes into the same log.
  if (!Object.prototype.hasOwnProperty.call(value, "eventId")) return null;
  if (value.v !== 1 || typeof value.eventId !== "string" || !value.eventId ||
    !nullableString(value.sessionId) || !nullableString(value.turnId) ||
    typeof value.type !== "string" || !object(value.event)) {
    throw new Error("invalid source event");
  }
  return value as LedgerSource;
}

export function tailJsonl<T>(
  text: string,
  previous: JsonlTail<T> | undefined,
  parse: (value: unknown) => T | null,
  key: (row: T) => string,
): JsonlTail<T> {
  const base = previous && text.startsWith(previous.text) ? previous : undefined;
  const offset = text.lastIndexOf("\n") + 1;
  if (base && offset === base.offset) return { ...base, text };
  const rows: Record<string, T> = Object.assign(Object.create(null), base?.rows);
  let lineNumber = text.slice(0, base?.offset ?? 0).split("\n").length;
  for (const line of text.slice(base?.offset ?? 0, offset).split("\n").slice(0, -1)) {
    try {
      if (line.trim()) {
        const row = parse(JSON.parse(line));
        if (row) rows[key(row)] = row;
      }
    } catch (error) {
      throw new Error(`line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    lineNumber += 1;
  }
  return { text, offset, rows };
}

export function parseLedger(text: string, previous?: JsonlTail<ActionRecord>) {
  return tailJsonl(text, previous, parseAction, (r) => r.actionId);
}

export function ledgerPath(cwd: string, sessionId: string): string {
  const id = encodeURIComponent(sessionId).replace(/\./g, "%2E");
  return `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/.pi/runs/${id}/actions.jsonl`;
}

export async function readProjectText(path: string): Promise<string> {
  try {
    const result = await invoke<{ kind: string; content?: string }>("fs_read_file", {
      path, workspace: currentWorkspaceEnv(),
    });
    if (result?.kind !== "text" || typeof result.content !== "string") {
      throw new Error(`expected text, received ${result?.kind ?? "no data"}`);
    }
    return result.content;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} (${path})`);
  }
}

export const useLedgerStore = create<{ sessions: Record<string, LedgerSnapshot> }>(() => ({ sessions: {} }));
type Reader = {
  actions?: JsonlTail<ActionRecord>;
  sources?: JsonlTail<LedgerSource>;
  clients: Map<symbol, boolean>;
  timer?: ReturnType<typeof setInterval>;
  pending?: Promise<void>;
  again: boolean;
};
const readers = new Map<string, Reader>();

export function refreshLedger(cwd: string, sessionId: string): Promise<void> {
  const path = ledgerPath(cwd, sessionId);
  let reader = readers.get(path);
  if (!reader) {
    reader = { clients: new Map(), again: false };
    readers.set(path, reader);
  }
  const current = reader;
  if (current.pending) {
    current.again = true;
    return current.pending;
  }
  current.pending = (async () => {
    do {
      current.again = false;
      const sourcePath = `${cwd.replace(/[\\/]+$/, "")}/${SESSION_LOG}`;
      const results = await Promise.allSettled([readProjectText(path), readProjectText(sourcePath)]);
      if (readers.get(path) !== current) return;
      const errors: string[] = [];
      const [actions, sources] = results;
      try {
        if (actions.status === "rejected") throw actions.reason;
        current.actions = tailJsonl(actions.value, current.actions, (value) => {
          const action = parseAction(value);
          if (action.sessionId !== sessionId) throw new Error("action belongs to a different session");
          return action;
        }, (r) => r.actionId);
      } catch (error) { errors.push(`Ledger read: ${String(error)} (${path})`); }
      try {
        if (sources.status === "rejected") throw sources.reason;
        current.sources = tailJsonl(sources.value, current.sources, (value) => {
          const source = parseSource(value);
          return source?.sessionId === sessionId ? source : null;
        }, (r) => r.eventId);
      } catch (error) { errors.push(`Usage source read: ${String(error)} (${sourcePath})`); }
      const snapshot: LedgerSnapshot = {
        actions: current.actions?.rows ?? EMPTY_LEDGER.actions, sources: current.sources?.rows ?? EMPTY_LEDGER.sources,
        loaded: errors.length === 0, error: errors.join("\n") || null,
      };
      useLedgerStore.setState((state) => {
        const previous = state.sessions[path];
        if (previous && previous.actions === snapshot.actions && previous.sources === snapshot.sources && previous.loaded === snapshot.loaded && previous.error === snapshot.error) return state;
        return { sessions: { ...state.sessions, [path]: snapshot } };
      });
    } while (current.again && readers.get(path) === current);
  })().finally(() => { current.pending = undefined; });
  return current.pending;
}

export function watchLedger(cwd: string, sessionId: string, inFlight: boolean): () => void {
  void refreshLedger(cwd, sessionId);
  const path = ledgerPath(cwd, sessionId);
  const reader = readers.get(path)!;
  const client = Symbol();
  reader.clients.set(client, inFlight);
  const schedule = () => {
    const busy = [...reader.clients.values()].some(Boolean);
    if (busy && !reader.timer) reader.timer = setInterval(() => { void refreshLedger(cwd, sessionId); }, LEDGER_POLL_MS);
    if (!busy && reader.timer) { clearInterval(reader.timer); reader.timer = undefined; }
  };
  schedule();
  return () => { reader.clients.delete(client); schedule(); };
}

export function useLedger(cwd?: string, sessionId?: string | null, inFlight = false): LedgerSnapshot {
  const path = cwd && sessionId ? ledgerPath(cwd, sessionId) : "";
  const snapshot = useLedgerStore((s) => s.sessions[path] ?? EMPTY_LEDGER);
  useEffect(() => {
    if (cwd && sessionId) return watchLedger(cwd, sessionId, inFlight);
  }, [cwd, sessionId, inFlight]);
  return snapshot;
}

export function actionDuration(action: ActionRecord): number | null {
  if (action.startedAt === null || action.endedAt === null) return null;
  const elapsed = Date.parse(action.endedAt) - Date.parse(action.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function actionTurnKey(action: ActionRecord, ledger: LedgerSnapshot, blocks: PiFeedItem[]): string | null {
  const source = action.usage.sourceEventId ? ledger.sources[action.usage.sourceEventId] : null;
  const sourceKey = source?.type === "turn_end" ? messageSourceKey(source.event.message) : null;
  let turnKey: string | null = null;
  const matches = new Set<string>();
  const toolMatches = new Set<string>();
  for (const block of blocks) {
    if (block.kind === "message" && block.role === "user") turnKey = block.id;
    if (!turnKey && block.kind !== "error" && block.kind !== "retry") {
      turnKey = `pre-${block.kind === "message" ? block.id : block.kind === "tool" ? block.toolCallId : block.requestId}`;
    }
    if (turnKey && block.kind === "message" && sourceKey && block.sourceKey === sourceKey) {
      matches.add(turnKey);
    }
    if (turnKey && block.kind === "tool" && block.toolCallId === (action.parentActionId ?? action.actionId)) toolMatches.add(turnKey);
  }
  return matches.size === 1 ? [...matches][0] : matches.size === 0 && toolMatches.size === 1 ? [...toolMatches][0] : null;
}

export function ledgerDiscrepancies(ledger: LedgerSnapshot, inFlight: boolean): string[] {
  if (!ledger.loaded || inFlight) return [];
  return Object.values(ledger.actions).flatMap((action) => {
    const id = action.usage.sourceEventId;
    if (!id || ledger.sources[id]?.type === "turn_end") return [];
    return [`usage-discrepancy: action ${action.actionId} displayed=${JSON.stringify(action.usage)}; source=missing event ${id} (${SESSION_LOG})`];
  });
}

/** Child transcript statuses that mean the child process is still working
 * (the same live set the pi tab counts for the graph badge). */
const LIVE_CHILD_STATUS = new Set(["thinking", "tool", "awaiting-ask"]);

/** Resolved child run for one ticket, joined from the ledger's latest
 * delegation record and the child store's live transcripts (F9 run
 * summary). */
export type TicketChildRun = {
  /** The latest delegation record recorded for the ticket. */
  action: ActionRecord;
  /** Transcript path resolved from the record's evidence, when it names one. */
  transcriptPath: string | null;
  /** agentId from the record, else the transcript filename stem. */
  agentId: string | null;
  /** True while the delegation runs and the known child transcript is live;
   * a finished or stopped transcript never reads running, whatever the
   * record still claims. */
  running: boolean;
  /** While running: now minus startedAt. After: the record's duration. */
  elapsedMs: number | null;
};

function delegationTranscriptPath(
  action: ActionRecord,
  cwd?: string,
): string | null {
  // Same resolution as runGraph.actionTranscriptPath; duplicated here
  // because runGraph imports values from this module and importing back
  // would cycle.
  const path = action.evidencePath?.replace(/\\/g, "/");
  if (!path?.endsWith(".transcript.jsonl")) return null;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return path;
  if (!cwd || path.split("/").includes("..")) return null;
  return `${cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/**
 * The delegation to name in the ticket sheet's run summary: the ticket's
 * latest delegation record by startedAt, its transcript resolved through
 * the child store, and whether the child is still working.
 */
export function ticketChildRun(
  ticketId: string | null | undefined,
  ledger: LedgerSnapshot,
  children: Record<string, PiSessionState>,
  cwd?: string,
  now: number = Date.now(),
): TicketChildRun | null {
  if (!ticketId) return null;
  let action: ActionRecord | null = null;
  for (const record of Object.values(ledger.actions)) {
    if (record.kind !== "delegation" || record.ticketId !== ticketId) continue;
    if (!action || (record.startedAt ?? "") > (action.startedAt ?? "")) {
      action = record;
    }
  }
  if (!action) return null;
  const transcriptPath = delegationTranscriptPath(action, cwd);
  const child = transcriptPath !== null ? children[transcriptPath] : undefined;
  const running =
    action.status === "running" &&
    (child === undefined || LIVE_CHILD_STATUS.has(child.status));
  const elapsedMs = running
    ? action.startedAt !== null
      ? Math.max(0, now - Date.parse(action.startedAt))
      : null
    : actionDuration(action);
  const agentId =
    action.agentId ??
    (transcriptPath !== null
      ? (transcriptPath.split(/[\\/]/).pop() ?? transcriptPath).replace(
          /\.transcript\.jsonl$/,
          "",
        )
      : null);
  return { action, transcriptPath, agentId, running, elapsedMs };
}

export function resetLedgerStore(): void {
  for (const reader of readers.values()) if (reader.timer) clearInterval(reader.timer);
  readers.clear();
  useLedgerStore.setState({ sessions: {} });
}
