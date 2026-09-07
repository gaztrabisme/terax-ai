import type {
  PiAskBlock,
  PiBlock,
  PiMessageBlock,
  PiToolBlock,
} from "./parse";

export type TurnActivityEntry =
  | { kind: "thinking"; text: string }
  | { kind: "narration"; text: string }
  | { kind: "tool"; block: PiToolBlock };

export type TurnStatus = "streaming" | "done";

export type Turn = {
  /** Stable while the tab lives: derived from the block ids of the turn. */
  key: string;
  /** Turn ordinal in the conversation; names exported answer files. */
  index: number;
  /** Text of the user message that opened the turn. */
  user: string;
  /** Text of the last assistant message; while streaming, the latest one. */
  answer: string;
  /** Thinking, narration (assistant text before the answer) and tools, in order. */
  activity: TurnActivityEntry[];
  asks: PiAskBlock[];
  status: TurnStatus;
  counts: {
    /** Every tool block. */
    tools: number;
    /** Tool blocks named subagent. */
    children: number;
    /** Tool blocks whose name starts with board_. */
    board: number;
  };
  /** Last block timestamp minus first, from the reducer-pinned `at` values. */
  durationMs: number | null;
};

export function isSubagentTool(block: PiToolBlock): boolean {
  return block.toolName === "subagent";
}

export function isBoardTool(block: PiToolBlock): boolean {
  return block.toolName.startsWith("board_");
}

/** board_open -> "open"; non board tools pass through. */
export function boardOp(toolName: string): string {
  return toolName.startsWith("board_")
    ? toolName.slice("board_".length) || "board"
    : toolName;
}

export function messageText(block: PiMessageBlock): string {
  return block.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function thinkingParts(block: PiMessageBlock): string[] {
  return block.parts
    .filter((p) => p.type === "thinking")
    .map((p) => p.thinking);
}

function firstArgString(args: unknown, keys: string[]): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Display name of the agent invoked by a subagent tool call. */
export function subagentName(block: PiToolBlock): string {
  return firstArgString(block.args, ["name", "agent", "agentName", "subagent"]) ?? "subagent";
}

/** First line of the subagent brief: args first, then the tool result. */
export function subagentBrief(block: PiToolBlock): string {
  const source =
    firstArgString(block.args, [
      "brief",
      "task",
      "prompt",
      "message",
      "description",
      "instructions",
    ]) ?? block.resultText ?? "";
  return source.trim().split("\n")[0] ?? "";
}

const TRANSCRIPT_RE = /[^\s"'`]*\.transcript\.jsonl/;

function findTranscriptRef(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    return value.match(TRANSCRIPT_RE)?.[0] ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTranscriptRef(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findTranscriptRef(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolves the child transcript path for a subagent call: the first
 * *.transcript.jsonl reference in the tool args, then in the result text.
 * Relative references are joined onto cwd, matching the keys pi_watch_transcripts
 * feeds into the child store (absolute paths there, so cwd is usually a no-op).
 */
export function childTranscriptPath(
  block: PiToolBlock,
  cwd?: string,
): string | null {
  const raw =
    findTranscriptRef(block.args) ??
    (block.resultText ? findTranscriptRef(block.resultText) : null);
  if (!raw) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  if (!cwd) return null;
  return `${cwd.replace(/[\\/]+$/, "")}/${raw.replace(/^[.\\/]+/, "")}`;
}

function blockAt(block: PiBlock): number | null {
  return typeof block.at === "number" && Number.isFinite(block.at)
    ? block.at
    : null;
}

function blockKey(block: PiBlock): string {
  switch (block.kind) {
    case "message":
      return block.id;
    case "tool":
      return block.toolCallId;
    case "ask":
      return block.requestId;
  }
}

function isBusy(block: PiBlock): boolean {
  if (block.kind === "message") return block.streaming;
  if (block.kind === "tool") return block.status === "running";
  return block.state === "pending";
}

type TurnGroup = { key: string; blocks: PiBlock[] };

/** Splits the block feed at user messages; leading blocks form a pre-group. */
function groupBlocks(blocks: PiBlock[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const block of blocks) {
    if (block.kind === "message" && block.role === "user") {
      groups.push({ key: block.id, blocks: [block] });
      continue;
    }
    if (groups.length === 0) {
      // Child transcripts may open without a user message; keep the blocks
      // under a stable synthetic key instead of dropping them.
      groups.push({ key: `pre-${blockKey(block)}`, blocks: [] });
    }
    groups[groups.length - 1].blocks.push(block);
  }
  return groups;
}

function deriveTurn(group: TurnGroup, index: number, isLast: boolean): Turn {
  const userBlock = group.blocks.find(
    (b): b is PiMessageBlock => b.kind === "message" && b.role === "user",
  );
  const assistantMessages = group.blocks.filter(
    (b): b is PiMessageBlock => b.kind === "message" && b.role === "assistant",
  );
  const answerMessage = assistantMessages[assistantMessages.length - 1] ?? null;

  const activity: TurnActivityEntry[] = [];
  const asks: PiAskBlock[] = [];
  let tools = 0;
  let children = 0;
  let board = 0;

  for (const block of group.blocks) {
    if (block.kind === "message") {
      if (block.role !== "assistant") continue;
      for (const thinking of thinkingParts(block)) {
        if (thinking.trim()) activity.push({ kind: "thinking", text: thinking });
      }
      if (block !== answerMessage) {
        const narration = messageText(block);
        if (narration.trim()) activity.push({ kind: "narration", text: narration });
      }
      continue;
    }
    if (block.kind === "tool") {
      activity.push({ kind: "tool", block });
      tools += 1;
      if (isSubagentTool(block)) children += 1;
      if (isBoardTool(block)) board += 1;
      continue;
    }
    asks.push(block);
  }

  const streaming =
    group.blocks.some(isBusy) || (isLast && assistantMessages.length === 0);

  const ats = group.blocks
    .map(blockAt)
    .filter((at): at is number => at !== null);
  const durationMs =
    ats.length >= 2 ? Math.max(...ats) - Math.min(...ats) : null;

  return {
    key: group.key,
    index,
    user: userBlock ? messageText(userBlock) : "",
    answer: answerMessage ? messageText(answerMessage) : "",
    activity,
    asks,
    status: streaming ? "streaming" : "done",
    counts: { tools, children, board },
    durationMs,
  };
}

/**
 * Pure turn model over the reduced block feed: a turn starts at a user
 * message and runs until the next one. Blocks that carry no `at` timestamp
 * (none since the reducer pins them) simply do not contribute durations.
 */
export function groupTurns(blocks: PiBlock[]): Turn[] {
  const groups = groupBlocks(blocks);
  return groups.map((group, index) =>
    deriveTurn(group, index, index === groups.length - 1),
  );
}
