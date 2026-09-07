import { invoke } from "@tauri-apps/api/core";
import { quoteShellArg } from "@/lib/shellQuote";
import type { PiResolvedPaths } from "@/modules/pi/lib/providers";

/**
 * Harness agent binary used for human keystone actions
 * (align/land/close/rework). Empty by default: a machine-specific path must
 * never be a code default, so a blank agentBin pref falls back to the path
 * pi_paths resolves (pref, then the bundled sidecar).
 */
export const DEFAULT_AGENT_BIN = "";

// One pi_paths read per webview load; board actions are rare and manual. A
// failed read leaves null and the action command surfaces the empty binary
// through the shell error instead of hiding it.
let resolvedAgentBin: string | null = null;

/**
 * Resolves the agent binary through pi_paths and caches it for
 * effectiveAgentBin. Exported so tests (and callers) can re-run it after the
 * resolution inputs change.
 */
export function loadResolvedAgentBin(): Promise<string | null> {
  // Promise.resolve absorbs a failed or stubbed invoke so the module-level
  // call below can never reject into the console.
  return Promise.resolve(
    invoke<PiResolvedPaths>("pi_paths", {
      prefs: { piBin: "", agentBin: "", agentDir: "", launcherDir: "" },
    }),
  )
    .then((paths) => {
      resolvedAgentBin = paths?.agent?.path ?? null;
      return resolvedAgentBin;
    })
    .catch(() => {
      resolvedAgentBin = null;
      return null;
    });
}

void loadResolvedAgentBin();

/** The binary a board action runs: the pref when set, else the pi_paths win. */
export function effectiveAgentBin(agentBin: string): string {
  const pref = agentBin.trim();
  if (pref) return pref;
  return resolvedAgentBin ?? "";
}

export type BoardVerb = "align" | "land" | "close" | "rework";

export type Gate = {
  id: number;
  gate: string;
  passed: boolean;
  provider: string;
  source: string;
  attempt: number;
  note: string | null;
  created_at: string | null;
};

export type Workpad = {
  plan: string | null;
  criteria: string | null;
  validation: string | null;
  notes: string | null;
  confusions: string[];
};

export type Ticket = {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  title: string;
  priority: number;
  created_at: string | null;
  updated_at: string | null;
  red_gates: number;
  workpad: Workpad | null;
  gates: Gate[];
};

export type BoardSnapshot = {
  states: string[];
  counts: Record<string, number>;
  tickets: Ticket[];
};

/** Column headers for the kanban; unknown states fall back to a de-underscored label. */
export const STATE_LABELS: Record<string, string> = {
  todo: "Todo",
  align: "Align",
  in_progress: "In progress",
  verify: "Verify",
  review: "Review",
  land: "Land",
  done: "Done",
  rework: "Rework",
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

/** States the compact rail lists when no column filter is active. */
export const RAIL_STATES: readonly string[] = [
  "align",
  "in_progress",
  "verify",
  "review",
];

/** Tickets for the rail body, optionally narrowed to one filtered state. */
export function railTickets(
  snapshot: BoardSnapshot,
  filter: string | null = null,
): Ticket[] {
  const states = filter ? [filter] : RAIL_STATES;
  return snapshot.tickets.filter((t) => states.includes(t.status));
}

// The binaries are absolute settings, not cwd-relative lookups; --root points
// them at the project whose .pi/board.db they should read while the shell keeps
// the tab cwd as working directory. A "$HOME/" prefix must survive quoting, so
// it is split out and re-joined outside the quotes.
export function quoteBin(bin: string): string {
  return bin.startsWith("$HOME/")
    ? `"$HOME"/${quoteShellArg(bin.slice("$HOME/".length))}`
    : quoteShellArg(bin);
}

/**
 * Resolves the agent binary once and returns it; callers that build a board
 * command with a blank board binary await this so the fallback never runs an
 * empty program.
 */
export function ensureAgentBin(agentBin = ""): Promise<string> {
  const pref = agentBin.trim();
  if (pref) return Promise.resolve(pref);
  if (resolvedAgentBin) return Promise.resolve(resolvedAgentBin);
  return loadResolvedAgentBin().then((bin) => bin ?? "");
}

/**
 * Read verbs: the bin/board shim when a board binary is set (it exports
 * HARNESS_DB from --root and execs the agent), else the harness agent directly
 * against <root>/.pi/board.db, which is what the shim does.
 */
export function boardListCommand(
  boardBin: string,
  root: string,
  agentBin = "",
): string {
  if (boardBin.trim()) {
    return `${quoteBin(boardBin)} --root ${quoteShellArg(root)} board --json`;
  }
  return `HARNESS_DB=${quoteShellArg(`${root}/.pi/board.db`)} ${quoteBin(effectiveAgentBin(agentBin))} board --json`;
}

export function boardShowCommand(
  boardBin: string,
  root: string,
  ticketId: string,
  agentBin = "",
): string {
  if (boardBin.trim()) {
    return `${quoteBin(boardBin)} --root ${quoteShellArg(root)} show ${quoteShellArg(ticketId)} --json`;
  }
  return `HARNESS_DB=${quoteShellArg(`${root}/.pi/board.db`)} ${quoteBin(effectiveAgentBin(agentBin))} show ${quoteShellArg(ticketId)} --json`;
}

// Human keystone actions run the harness binary directly against the board DB.
// A blank binary falls back to the pi_paths resolution cached at load.
export function boardActionCommand(
  agentBin: string,
  root: string,
  verb: BoardVerb,
  ticketId: string,
): string {
  const db = `${root}/.pi/board.db`;
  return `HARNESS_DB=${quoteShellArg(db)} ${quoteBin(effectiveAgentBin(agentBin))} ${verb} ${quoteShellArg(ticketId)}`;
}

// Latest gate per gate name: gates arrive in chronological order, so the last
// entry with the highest attempt wins.
export function latestGateByName(ticket: Ticket): Map<string, Gate> {
  const latest = new Map<string, Gate>();
  for (const gate of ticket.gates ?? []) {
    const current = latest.get(gate.gate);
    if (!current || gate.attempt >= current.attempt) latest.set(gate.gate, gate);
  }
  return latest;
}

/** One dot per gate name, in first-appearance order, at its latest result. */
export function gateDots(ticket: Ticket): { gate: string; passed: boolean }[] {
  const latest = latestGateByName(ticket);
  const seen = new Set<string>();
  const dots: { gate: string; passed: boolean }[] = [];
  for (const gate of ticket.gates ?? []) {
    if (seen.has(gate.gate)) continue;
    seen.add(gate.gate);
    const current = latest.get(gate.gate);
    if (current) dots.push({ gate: gate.gate, passed: current.passed });
  }
  return dots;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

export function parseGate(value: unknown): Gate {
  const rec = asRecord(value);
  return {
    id: asNumber(rec.id),
    gate: asString(rec.gate),
    passed: asBoolean(rec.passed),
    provider: asString(rec.provider),
    source: asString(rec.source),
    attempt: asNumber(rec.attempt),
    note: asStringOrNull(rec.note),
    created_at: asStringOrNull(rec.created_at),
  };
}

export function parseWorkpad(value: unknown): Workpad {
  const rec = asRecord(value);
  return {
    plan: asStringOrNull(rec.plan),
    criteria: asStringOrNull(rec.criteria),
    validation: asStringOrNull(rec.validation),
    notes: asStringOrNull(rec.notes),
    confusions: Array.isArray(rec.confusions)
      ? rec.confusions.filter((c): c is string => typeof c === "string")
      : [],
  };
}

export function parseTicketRecord(value: unknown): Ticket {
  const rec = asRecord(value);
  return {
    id: asString(rec.id),
    kind: asString(rec.kind),
    status: asString(rec.status),
    attempt: asNumber(rec.attempt),
    title: asString(rec.title),
    priority: asNumber(rec.priority),
    created_at: asStringOrNull(rec.created_at),
    updated_at: asStringOrNull(rec.updated_at),
    red_gates: asNumber(rec.red_gates),
    workpad: rec.workpad === undefined ? null : parseWorkpad(rec.workpad),
    gates: Array.isArray(rec.gates) ? rec.gates.map(parseGate) : [],
  };
}

/** Parses the stdout of `board --json`; throws on malformed output. */
export function parseBoard(json: string): BoardSnapshot {
  const value: unknown = JSON.parse(json);
  const rec = asRecord(value);
  const counts: Record<string, number> = {};
  for (const [state, n] of Object.entries(asRecord(rec.counts))) {
    counts[state] = asNumber(n);
  }
  return {
    states: Array.isArray(rec.states)
      ? rec.states.filter((s): s is string => typeof s === "string")
      : [],
    counts,
    tickets: Array.isArray(rec.tickets)
      ? rec.tickets.map(parseTicketRecord)
      : [],
  };
}

/** Parses the stdout of `show <id> --json`; throws on malformed output. */
export function parseTicket(json: string): Ticket {
  return parseTicketRecord(JSON.parse(json));
}
