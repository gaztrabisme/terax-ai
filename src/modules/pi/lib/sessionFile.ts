import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  asUsage,
  messageSourceKey,
  toParts,
  type PiFeedItem,
  type PiMessageBlock,
  type PiUsage,
} from "./parse";

/** A saved pi session read back from disk: the header id plus the user and
 *  assistant messages as transcript blocks. F1b: switch_session replays no
 *  history (vendor rpc.rs answers response_ok and nothing else), so the app
 *  loads the transcript from the session file itself. */
export type ParsedSessionFile = {
  /** The session header's id; null when the file records none. */
  sessionId: string | null;
  /** User and assistant messages in file order. Message ids carry the `h-`
   *  prefix so they can never collide with the wire reducer's msg-N ids
   *  after the switch resets its sequence counter. */
  blocks: PiFeedItem[];
};

/** One parsed jsonl entry, loosely typed: session files are pi's own wire
 *  shape and this module must tolerate anything pi writes beside the
 *  message and session entries it reads. */
type SessionEntry = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parses a session file's text. Mirrors the store's read side (Rust twin:
 * sessions.rs message_text): only user and assistant message entries become
 * blocks; tool results, thinking-only metadata and compaction records are
 * skipped. Bad lines are ignored, so a session pi appended to mid-crash
 * still restores everything readable.
 */
export function parseSessionFile(
  text: string,
  now: number = Date.now(),
): ParsedSessionFile {
  let sessionId: string | null = null;
  const blocks: PiFeedItem[] = [];
  for (const [n, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(trimmed) as SessionEntry;
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.type === "session") {
      sessionId ??= asString(entry.id);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = asString(message.role);
    if (role !== "user" && role !== "assistant") continue;
    // The entry timestamp pins the block's at value, so restored turns keep
    // their real generation durations; entries without one share `now`.
    const at =
      asString(entry.timestamp) !== null
        ? (Date.parse(asString(entry.timestamp) ?? "") || now)
        : now;
    const block: PiMessageBlock = {
      kind: "message",
      id: `h-${n}`,
      role,
      parts: toParts(message.content),
      model: asString(message.model),
      usage: asUsage(message.usage),
      sourceKey: messageSourceKey(message),
      stopReason: asString(message.stopReason),
      streaming: false,
      at,
    };
    blocks.push(block);
  }
  return { sessionId, blocks };
}

/** Reads one session file through the project-file bridge. The error names
 *  the path: a failed restore must say what could not be opened. */
export async function readSessionFileText(path: string): Promise<string> {
  let res: { kind?: unknown; content?: unknown };
  try {
    res = await invoke<{ kind: string; content?: string }>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${path}: ${reason}`);
  }
  if (res.kind !== "text" || typeof res.content !== "string") {
    throw new Error(`${path}: not readable as text (pi session file expected)`);
  }
  return res.content;
}

/**
 * Loads a saved session: reads the file, parses it, and refuses a file with
 * neither a header id nor any message (a corrupt or unrelated jsonl). The
 * caller keeps the current conversation until this resolves.
 */
export async function loadSessionFile(
  path: string,
  now: number = Date.now(),
): Promise<ParsedSessionFile> {
  const parsed = parseSessionFile(await readSessionFileText(path), now);
  if (parsed.sessionId === null && parsed.blocks.length === 0) {
    throw new Error(`${path}: no pi session header or messages found`);
  }
  return parsed;
}

/** The filename-safe short id pi writes into session file names (vendor
 *  pi_agent_rust src/session.rs: the first 8 id characters). */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** True when a session file path belongs to the session id: pi names files
 *  `<timestamp>_<short id>.jsonl`, and the timestamp part has no underscore,
 *  so the name must end with an underscore plus the short id. The full id
 *  never appears in the name, so an exact-suffix check on it never matches
 *  (the current-session hit bug). */
export function pathMatchesSessionId(
  path: string,
  sessionId: string,
): boolean {
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.jsonl$/, "");
  return name.endsWith(`_${shortSessionId(sessionId)}`);
}

/** Usage sums over a restored transcript: the strip's totals for a session
 *  that has already run (UX-14: the strip must not claim "no turns yet"
 *  above a transcript full of turns). */
export function restoredUsageTotals(blocks: PiFeedItem[]): {
  turnTokens: number;
  sessionCost: number;
  turnUsage: PiUsage | null;
} {
  let turnTokens = 0;
  let sessionCost = 0;
  let turnUsage: PiUsage | null = null;
  for (const block of blocks) {
    if (block.kind !== "message" || block.role !== "assistant" || !block.usage)
      continue;
    turnTokens += block.usage.totalTokens;
    sessionCost += block.usage.costTotal;
    turnUsage = block.usage;
  }
  return { turnTokens, sessionCost, turnUsage };
}

/**
 * Resolves the current session's exact file from the project locator
 * (`.pi/session-manifest.json`): null on any failure, because a missing
 * locator only means the strip cannot show a path.
 */
export async function resolveSessionPath(
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const res = await invoke<{ kind?: unknown; content?: unknown }>(
      "fs_read_file",
      {
        path: `${cwd.replace(/[\\/]+$/, "")}/.pi/session-manifest.json`,
        workspace: currentWorkspaceEnv(),
      },
    );
    if (res.kind !== "text" || typeof res.content !== "string") return null;
    const manifest = JSON.parse(res.content) as {
      sessions?: { id?: unknown; path?: unknown }[];
    };
    if (!Array.isArray(manifest.sessions)) return null;
    for (const record of manifest.sessions) {
      if (record.id === sessionId && typeof record.path === "string") {
        return `${cwd.replace(/[\\/]+$/, "")}/${record.path.replace(/^[\\/]+/, "")}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}
