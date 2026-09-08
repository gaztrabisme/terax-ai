export type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** usage.cost.total in dollars, priced from pi's embedded catalog; 0 when
   *  absent (local providers and zero-priced catalog rows cost nothing). */
  costTotal: number;
};

/** Retry in flight between auto_retry_start and auto_retry_end. */
export type PiRetryPending = {
  attempt: number;
  max: number;
  delayMs: number;
};

/** Header label for a pending retry, e.g. "retrying 2/3 in 4 s". */
export function retryPendingLabel(retry: PiRetryPending): string {
  return `retrying ${retry.attempt}/${retry.max} in ${Math.max(1, Math.round(retry.delayMs / 1000))} s`;
}

export type PiContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export type PiResultPart = { type: string; text?: string };

export type PiQuestion = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  recommended: number | null;
  multi: boolean;
  /** Explicit id from pi; when absent the answer must use the array index. */
  id?: string;
};

export type PiAskAnswer = { questionId: string; selected: string[] };

export type PiMessageBlock = {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  parts: PiContentPart[];
  model: string | null;
  usage: PiUsage | null;
  sourceKey?: string;
  eventUsage?: PiUsage | null;
  stopReason?: string | null;
  streaming: boolean;
  /** Creation epoch ms; applyEvent pins it from its optional `now` argument. */
  at: number;
  /** Local project paths and failures recorded for a user prompt. */
  savedAttachments?: PiSavedAttachment[];
};

export type PiSavedAttachment = {
  /** Relative to the project cwd when the write succeeded. */
  path: string | null;
  /** The write error shown when the path is null. */
  error: string | null;
};

export type PiToolBlock = {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  partialText: string | null;
  resultText: string | null;
  isError: boolean;
  /** Creation epoch ms; applyEvent pins it from its optional `now` argument. */
  at: number;
};

export type PiAskBlock = {
  kind: "ask";
  requestId: string;
  questions: PiQuestion[];
  timeoutMs: number;
  state: "pending" | "answered" | "dismissed";
  /** Creation epoch ms; applyEvent pins it from its optional `now` argument. */
  at: number;
};

export type PiErrorBlock = {
  kind: "error";
  /** The error text pi reported on the wire. */
  text: string;
  /** Creation epoch ms; applyEvent pins it from its optional `now` argument. */
  at: number;
};

export type PiRetryBlock = {
  kind: "retry";
  /** start = auto_retry_start; end = auto_retry_end. */
  phase: "start" | "end";
  attempt: number;
  /** maxAttempts; carried by auto_retry_start only. */
  max: number | null;
  /** Backoff before the next attempt; auto_retry_start only. */
  delayMs: number | null;
  /** auto_retry_end only: whether the retried request succeeded. */
  success: boolean | null;
  /** errorMessage on start, finalError on end. */
  errorText: string | null;
  /** Creation epoch ms; applyEvent pins it from its optional `now` argument. */
  at: number;
};

export type PiBlock = PiMessageBlock | PiToolBlock | PiAskBlock;

/** The transcript feed: turn-model blocks plus error and retry cards. Cards
 *  live outside PiBlock so the turn model (turns.ts) keeps its exhaustive
 *  message/tool/ask shape; renderers attach them to the turn they belong
 *  to instead. */
export type PiFeedItem = PiBlock | PiErrorBlock | PiRetryBlock;

/** Drops the cards so the turn model only sees message/tool/ask blocks. */
export function messageBlocks(feed: PiFeedItem[]): PiBlock[] {
  return feed.filter(
    (item): item is PiBlock => item.kind !== "error" && item.kind !== "retry",
  );
}

export type PiStatus =
  | "idle"
  | "thinking"
  | "tool"
  | "awaiting-ask"
  | "done"
  | "error";

export type PiSessionState = {
  status: PiStatus;
  sessionId: string | null;
  blocks: PiFeedItem[];
  /** Assistant message currently streaming; message_update replaces its parts. */
  openMessageId: string | null;
  toolPos: Record<string, number>;
  askPos: Record<string, number>;
  tokens: PiUsage | null;
  seq: number;
  /** First and latest turn_start epoch ms: child run elapsed. */
  startedMs: number | null;
  lastMs: number | null;
  /** Sum of turn_end usage.totalTokens across turns. */
  turnTokens: number;
  /** Sum of turn_end usage.cost.total across turns: the session bill. */
  sessionCost: number;
  /** Latest turn_end usage: the per-turn tokens and cost. */
  turnUsage: PiUsage | null;
  /** Retry in flight, from auto_retry_start until auto_retry_end. */
  retry: PiRetryPending | null;
  /** Text of the error already on the feed; agent_end retries repeat it. */
  lastErrorText: string | null;
  /** Between a switch_session ack and the new session's first start event:
   *  the transcript was reset but the new session id is not known yet. */
  switching: boolean;
};

export function initialPiSessionState(): PiSessionState {
  return {
    status: "idle",
    sessionId: null,
    blocks: [],
    openMessageId: null,
    toolPos: {},
    askPos: {},
    tokens: null,
    seq: 0,
    startedMs: null,
    lastMs: null,
    turnTokens: 0,
    sessionCost: 0,
    turnUsage: null,
    retry: null,
    lastErrorText: null,
    switching: false,
  };
}

/** State a session switch discards: the whole transcript plus the usage,
 *  retry and error accounting of the session that was switched away. Only
 *  per-session transcript state lives here; static state (cwd, model,
 *  pending composer text) is kept outside PiSessionState and survives. */
function switchedState(state: PiSessionState): PiSessionState {
  return {
    ...state,
    status: "idle",
    sessionId: null,
    blocks: [],
    openMessageId: null,
    toolPos: {},
    askPos: {},
    tokens: null,
    seq: 0,
    startedMs: null,
    lastMs: null,
    turnTokens: 0,
    sessionCost: 0,
    turnUsage: null,
    retry: null,
    lastErrorText: null,
    switching: true,
  };
}

/** True when the event names a session the reducer is not on. The switch ack
 *  clears sessionId until the new session's first start event, so every
 *  id-bearing frame seen while switching is stale too. */
function staleSession(
  state: PiSessionState,
  event: Record<string, unknown>,
): boolean {
  const sessionId = asString(event.sessionId);
  if (sessionId === null) return false;
  return (
    state.switching ||
    (state.sessionId !== null && sessionId !== state.sessionId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asUsage(value: unknown): PiUsage | null {
  if (!isRecord(value) || typeof value.totalTokens !== "number") return null;
  // usage.cost.total comes from pi's pricing catalog; a missing cost object
  // (or a zero-priced row, local providers included) means no bill.
  const cost = isRecord(value.cost) ? value.cost : null;
  return {
    input: typeof value.input === "number" ? value.input : 0,
    output: typeof value.output === "number" ? value.output : 0,
    cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
    cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
    totalTokens: value.totalTokens,
    costTotal: cost && typeof cost.total === "number" ? cost.total : 0,
  };
}

export function messageSourceKey(message: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  if (!isRecord(message)) return "";
  const { usage: _usage, ...identity } = message;
  return JSON.stringify(stable(identity));
}

// User messages carry a plain string content; assistant messages carry the
// typed part array. Normalize both so renderers only ever see parts.
function toParts(content: unknown): PiContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const parts: PiContentPart[] = [];
  for (const raw of content) {
    if (!isRecord(raw) || typeof raw.type !== "string") continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
      parts.push({ type: "thinking", thinking: raw.thinking });
    } else if (raw.type === "toolCall") {
      parts.push({
        type: "toolCall",
        id: asString(raw.id) ?? "",
        name: asString(raw.name) ?? "",
        arguments: raw.arguments,
      });
    }
  }
  return parts;
}

function textOfParts(parts: PiResultPart[]): string {
  return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
}

/** pi's ask questions may omit ids; ask.rs pairs answers by array index then. */
export function effectiveQuestionId(
  question: PiQuestion,
  index: number,
): string {
  return question.id ?? String(index);
}

/** One image attachment as the composer holds it: encoded bytes, base64. */
export type PiImageAttachment = {
  /** IANA media type of the bytes in `data` ("image/png" or "image/jpeg"). */
  mediaType: string;
  /** Base64 payload without the data-url header. */
  data: string;
};

/** The exact image item pi's RPC prompt accepts (rpc.rs parse_prompt_images). */
export type PiPromptImage = {
  type: "image";
  source: { type: "base64"; mediaType: string; data: string };
};

/** Wraps attachments in pi's item shape; undefined when there are none. */
export function toPromptImages(
  images?: PiImageAttachment[],
): PiPromptImage[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({
    type: "image",
    source: { type: "base64", mediaType: image.mediaType, data: image.data },
  }));
}

/** What pi should do with a prompt sent while a turn is streaming
 *  (rpc.rs parse_streaming_behavior): "steer" interrupts, "follow-up"
 *  queues the message to run after the current turn ends. */
export type PiStreamingBehavior = "follow-up" | "steer";

export function promptLine(
  message: string,
  images?: PiImageAttachment[],
  streamingBehavior?: PiStreamingBehavior,
): string {
  const wire = toPromptImages(images);
  if (!wire && !streamingBehavior)
    return JSON.stringify({ type: "prompt", message });
  return JSON.stringify({
    type: "prompt",
    message,
    ...(wire ? { images: wire } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  });
}

export function askResponseLine(
  requestId: string,
  answers: PiAskAnswer[],
): string {
  return JSON.stringify({ type: "ask_response", requestId, answers });
}

/**
 * Pure reducer over pi's measured stdout vocabulary. message_update carries a
 * FULL message snapshot, so it replaces the open message's parts rather than
 * appending (replaying the same snapshot twice must not duplicate parts).
 * Unknown or malformed lines return the state unchanged.
 */
export function applyEvent(
  state: PiSessionState,
  raw: string,
  now: number = Date.now(),
): PiSessionState {
  const line = raw.trimStart();
  if (!line.startsWith("{")) return state;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return state;
  }
  if (!isRecord(event) || typeof event.type !== "string") return state;

  // Between a switch ack and the new session's first start event nothing
  // legitimate flows: any other frame in that window belongs to the
  // generation that was switched away. Responses stay exempt so a second
  // switch command can still land.
  if (
    state.switching &&
    event.type !== "response" &&
    event.type !== "agent_start" &&
    event.type !== "turn_start"
  ) {
    return state;
  }

  switch (event.type) {
    case "agent_start":
    case "turn_start": {
      const sessionId = asString(event.sessionId);
      const ts = typeof event.timestamp === "number" ? event.timestamp : null;
      // The new session's first id-bearing start closes a pending switch;
      // a start naming a different session is the same reset when the ack
      // was missed. pi 0.3.0 carries no session id on the ack itself.
      const switched =
        state.switching ||
        (sessionId !== null &&
          state.sessionId !== null &&
          sessionId !== state.sessionId);
      const base = switched ? switchedState(state) : state;
      return {
        ...base,
        switching: false,
        status: base.status === "awaiting-ask" ? base.status : "thinking",
        ...(sessionId !== null && { sessionId }),
        ...(ts !== null && {
          startedMs: base.startedMs ?? ts,
          lastMs: ts,
        }),
      };
    }
    case "message_start":
      return applyMessageStart(state, event, now);
    case "message_update":
      return applyMessageUpdate(state, event);
    case "message_end":
      return applyMessageEnd(state, event);
    case "turn_end": {
      // Only agent_start, turn_start and turn_end carry a session id on
      // pi 0.3.0; a turn_end naming the session that was switched away is
      // stale generation and must not add to the new session's totals.
      if (staleSession(state, event)) return state;
      const usage = asUsage(
        isRecord(event.message) ? event.message.usage : null,
      );
      const key = messageSourceKey(event.message);
      const assistant = [...state.blocks].reverse().find(
        (b) => b.kind === "message" && b.role === "assistant" && b.sourceKey === key,
      );
      const previous = assistant?.kind === "message" ? assistant.eventUsage : null;
      let next = assistant?.kind === "message"
        ? withMessageBlock(state, assistant.id, (block) => ({
            ...block,
            eventUsage: usage,
            ...(block.eventUsage !== undefined && { usage }),
          }))
        : state;
      if (!usage) return next;
      if (assistant?.kind === "message" && previous && (usage.input > 0 || usage.output > 0)) {
        const index = next.blocks.findIndex((b) => b.kind === "message" && b.id === assistant.id);
        const nextUser = next.blocks.findIndex((b, i) => i > index && b.kind === "message" && b.role === "user");
        next = { ...next, blocks: next.blocks.filter((b, i) => i <= index || (nextUser >= 0 && i >= nextUser) || b.kind !== "error" || b.text !== "empty completion: no usage reported") };
      }
      return {
        ...next,
        tokens: usage,
        turnUsage: usage,
        turnTokens: state.turnTokens + usage.totalTokens - (previous?.totalTokens ?? 0),
        sessionCost: state.sessionCost + usage.costTotal - (previous?.costTotal ?? 0),
      };
    }
    case "auto_retry_start":
      return applyRetryStart(state, event, now);
    case "auto_retry_end":
      return applyRetryEnd(state, event, now);
    case "agent_end": {
      const error = asString(event.error);
      if (error === null) {
        const latestUser = state.blocks.map((b) => b.kind === "message" && b.role === "user").lastIndexOf(true);
        const currentBlocks = state.blocks.slice(Math.max(0, latestUser));
        const usages = currentBlocks.flatMap((b) => b.kind === "message" && b.role === "assistant" && b.usage ? [b.eventUsage ?? b.usage] : []);
        const completed = !currentBlocks.some((b) => b.kind === "message" && (b.stopReason === "error" || b.stopReason === "aborted"));
        const empty = completed && (usages.length > 0 ? usages.every((usage) => usage.input === 0 && usage.output === 0)
          : state.turnUsage?.input === 0 && state.turnUsage.output === 0);
        const text = "empty completion: no usage reported";
        // The retry lifecycle always closes before agent_end, but clear the
        // pending state here too so nothing outlives the run.
        return {
          ...state,
          status: "done",
          lastErrorText: null,
          retry: null,
          blocks: empty && !currentBlocks.some((b) => b.kind === "error" && b.text === text)
            ? [...state.blocks, { kind: "error", text, at: now }]
            : state.blocks,
        };
      }
      // Failed model request: pi ends every auto-retry attempt with the same
      // top-level error string, so only the first occurrence becomes a
      // transcript block; a later user message re-arms the card.
      const deduped = state.lastErrorText === error;
      return {
        ...state,
        status: "error",
        lastErrorText: error,
        blocks: deduped
          ? state.blocks
          : [...state.blocks, { kind: "error", text: error, at: now }],
        seq: deduped ? state.seq : state.seq + 1,
      };
    }
    case "tool_execution_start":
      return applyToolStart(state, event, now);
    case "tool_execution_update":
      return applyToolUpdate(state, event);
    case "tool_execution_end":
      return applyToolEnd(state, event, now);
    case "ask_request":
      return applyAskRequest(state, event, now);
    case "response":
      return applyResponse(state, event, now);
    default:
      return state;
  }
}

function applyMessageStart(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const message = event.message;
  if (!isRecord(message)) return state;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return state;
  const block: PiMessageBlock = {
    kind: "message",
    id: `msg-${state.seq}`,
    role,
    parts: toParts(message.content),
    model: asString(message.model),
    usage: null,
    streaming: role === "assistant",
    at: now,
  };
  return {
    ...state,
    seq: state.seq + 1,
    status: role === "assistant" ? "thinking" : state.status,
    // A new user message opens a fresh turn: its failure gets its own card
    // and the turn's usage and retry state start empty.
    ...(role === "user" && {
      lastErrorText: null,
      turnUsage: null,
      retry: null,
    }),
    blocks: [...state.blocks, block],
    openMessageId: role === "assistant" ? block.id : state.openMessageId,
  };
}

/** Adds local attachment results to one user message without changing pi's
 *  wire-derived content. */
export function recordSavedAttachments(
  state: PiSessionState,
  messageId: string,
  attachments: PiSavedAttachment[],
): PiSessionState {
  if (attachments.length === 0) return state;
  const block = state.blocks.find(
    (item) => item.kind === "message" && item.id === messageId,
  );
  if (!block || block.kind !== "message" || block.role !== "user") {
    return state;
  }
  return withMessageBlock(state, messageId, (current) => ({
    ...current,
    savedAttachments: attachments,
  }));
}

function applyRetryStart(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const attempt = typeof event.attempt === "number" ? event.attempt : null;
  const max = typeof event.maxAttempts === "number" ? event.maxAttempts : null;
  const delayMs = typeof event.delayMs === "number" ? event.delayMs : null;
  if (attempt === null || max === null || delayMs === null) return state;
  const block: PiRetryBlock = {
    kind: "retry",
    phase: "start",
    attempt,
    max,
    delayMs,
    success: null,
    errorText: asString(event.errorMessage),
    at: now,
  };
  return {
    ...state,
    // The engine is working again: the header shows the retry label on top
    // of the running state instead of the failure.
    status: "thinking",
    retry: { attempt, max, delayMs },
    blocks: [...state.blocks, block],
  };
}

function applyRetryEnd(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const attempt = typeof event.attempt === "number" ? event.attempt : null;
  const success = event.success === true;
  if (attempt === null) return state;
  const block: PiRetryBlock = {
    kind: "retry",
    phase: "end",
    attempt,
    max: null,
    delayMs: null,
    success,
    errorText: asString(event.finalError),
    at: now,
  };
  return {
    ...state,
    retry: null,
    blocks: [...state.blocks, block],
  };
}

function applyMessageUpdate(
  state: PiSessionState,
  event: Record<string, unknown>,
): PiSessionState {
  const message = event.message;
  if (!isRecord(message) || state.openMessageId === null) return state;
  return withMessageBlock(state, state.openMessageId, (block) => ({
    ...block,
    // Snapshot semantics: replace, never append.
    parts: toParts(message.content),
    model: asString(message.model) ?? block.model,
  }));
}

function applyMessageEnd(
  state: PiSessionState,
  event: Record<string, unknown>,
): PiSessionState {
  const message = event.message;
  if (!isRecord(message)) return state;
  const role = message.role;
  if (role === "user" || role === "toolResult") return state;
  if (role !== "assistant") return state;
  const usage = asUsage(message.usage);
  const next = withMessageBlock(state, state.openMessageId ?? "", (block) => ({
    ...block,
    parts: toParts(message.content),
    model: asString(message.model) ?? block.model,
    usage: usage ?? block.usage,
    sourceKey: messageSourceKey(message),
    stopReason: asString(message.stopReason),
    streaming: false,
  }));
  return {
    ...next,
    openMessageId: null,
    ...(usage !== null && { tokens: usage }),
  };
}

function withMessageBlock(
  state: PiSessionState,
  id: string,
  patch: (block: PiMessageBlock) => PiMessageBlock,
): PiSessionState {
  const index = state.blocks.findIndex(
    (b) => b.kind === "message" && b.id === id,
  );
  if (index === -1) return state;
  const block = state.blocks[index];
  if (block.kind !== "message") return state;
  const blocks = state.blocks.slice();
  blocks[index] = patch(block);
  return { ...state, blocks };
}

function applyToolStart(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const toolCallId = asString(event.toolCallId);
  if (!toolCallId || state.toolPos[toolCallId] !== undefined) return state;
  const block: PiToolBlock = {
    kind: "tool",
    toolCallId,
    toolName: asString(event.toolName) ?? "",
    args: event.args,
    status: "running",
    partialText: null,
    resultText: null,
    isError: false,
    at: now,
  };
  return {
    ...state,
    status: "tool",
    blocks: [...state.blocks, block],
    toolPos: { ...state.toolPos, [toolCallId]: state.blocks.length },
  };
}

function applyToolUpdate(
  state: PiSessionState,
  event: Record<string, unknown>,
): PiSessionState {
  const toolCallId = asString(event.toolCallId);
  if (!toolCallId) return state;
  const index = state.toolPos[toolCallId];
  if (index === undefined) return state;
  const partial = event.partialResult;
  const content = isRecord(partial) ? partial.content : null;
  if (!Array.isArray(content)) return state;
  const text = textOfParts(content as PiResultPart[]);
  // Approval-audit updates carry empty content: keep the last visible output.
  if (!text) return state;
  const block = state.blocks[index];
  if (block.kind !== "tool") return state;
  const blocks = state.blocks.slice();
  blocks[index] = { ...block, partialText: text };
  return { ...state, blocks };
}

function applyToolEnd(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const toolCallId = asString(event.toolCallId);
  if (!toolCallId) return state;
  const result = event.result;
  const content =
    isRecord(result) && Array.isArray(result.content)
      ? (result.content as PiResultPart[])
      : [];
  const isError = event.isError === true;
  const patch = {
    status: (isError ? "error" : "done") as PiToolBlock["status"],
    resultText: textOfParts(content),
    isError,
  };
  const index = state.toolPos[toolCallId];
  if (index === undefined) {
    // End without a seen start: synthesize the row so nothing is lost.
    const block: PiToolBlock = {
      kind: "tool",
      toolCallId,
      toolName: asString(event.toolName) ?? "",
      args: event.args,
      partialText: null,
      at: now,
      ...patch,
    };
    return {
      ...state,
      status: "thinking",
      blocks: [...state.blocks, block],
      toolPos: { ...state.toolPos, [toolCallId]: state.blocks.length },
    };
  }
  const block = state.blocks[index];
  if (block.kind !== "tool") return state;
  const blocks = state.blocks.slice();
  blocks[index] = { ...block, ...patch };
  return { ...state, status: "thinking", blocks };
}

function applyAskRequest(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const requestId = asString(event.id);
  if (!requestId || state.askPos[requestId] !== undefined) return state;
  const questions: PiQuestion[] = Array.isArray(event.questions)
    ? event.questions.filter(isRecord).map((q) => ({
        question: asString(q.question) ?? "",
        ...(asString(q.header) !== null && {
          header: asString(q.header) ?? undefined,
        }),
        options: Array.isArray(q.options)
          ? q.options.filter(isRecord).map((o) => ({
              label: asString(o.label) ?? "",
              ...(asString(o.description) !== null && {
                description: asString(o.description) ?? undefined,
              }),
            }))
          : [],
        recommended: typeof q.recommended === "number" ? q.recommended : null,
        multi: q.multi === true,
        ...(asString(q.id) !== null && { id: asString(q.id) ?? undefined }),
      }))
    : [];
  const block: PiAskBlock = {
    kind: "ask",
    requestId,
    questions,
    timeoutMs: typeof event.timeoutMs === "number" ? event.timeoutMs : 0,
    state: "pending",
    at: now,
  };
  return {
    ...state,
    status: "awaiting-ask",
    blocks: [...state.blocks, block],
    askPos: { ...state.askPos, [requestId]: state.blocks.length },
  };
}

function applyResponse(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  if (event.command === "switch_session")
    return applySwitchResponse(state, event);
  if (event.command === "prompt" && event.success === false)
    return applyPromptRejection(state, event, now);
  if (event.command !== "ask_response") return state;
  const requestId = asString(event.id);
  if (!requestId) return state;
  const index = state.askPos[requestId];
  if (index === undefined) return state;
  const block = state.blocks[index];
  if (block.kind !== "ask") return state;
  const data = event.data;
  const unresolved =
    event.success === false || (isRecord(data) && data.resolved === false);
  // A failed resolution puts the card back in front of the user.
  if (unresolved) return withAskState(state, index, "pending");
  return withAskState(state, index, "answered");
}

/** The switch_session ack: pi 0.3.0 defers the switch until the running
 *  turn finishes, then answers {command:"switch_session",data:{cancelled}}
 *  without the new session id; the id arrives on the next agent_start. So
 *  the transcript resets here and the new id is adopted later. A failed or
 *  cancelled switch leaves the current session untouched. */
function applySwitchResponse(
  state: PiSessionState,
  event: Record<string, unknown>,
): PiSessionState {
  if (event.success === false) return state;
  const data = isRecord(event.data) ? event.data : null;
  if (data !== null && data.cancelled === true) return state;
  return switchedState(state);
}

/** A prompt the rpc command handler refused: pi answers
 *  {command:"prompt",success:false,error} and nothing else happens, so the
 *  dropped prompt surfaces as a transcript error card instead of vanishing. */
function applyPromptRejection(
  state: PiSessionState,
  event: Record<string, unknown>,
  now: number,
): PiSessionState {
  const error = asString(event.error);
  if (error === null) return state;
  const text = `prompt rejected: ${error}`;
  return {
    ...state,
    lastErrorText: text,
    blocks: [...state.blocks, { kind: "error", text, at: now }],
    seq: state.seq + 1,
  };
}

function withAskState(
  state: PiSessionState,
  index: number,
  askState: PiAskBlock["state"],
): PiSessionState {
  const block = state.blocks[index];
  if (block.kind !== "ask" || block.state === askState) return state;
  const blocks = state.blocks.slice();
  blocks[index] = { ...block, state: askState };
  return { ...state, blocks };
}

/** Optimistic local answer before the wire response confirms it. */
export function answerAsk(
  state: PiSessionState,
  requestId: string,
  answers: PiAskAnswer[],
): PiSessionState {
  const index = state.askPos[requestId];
  if (index === undefined || answers.length === 0) return state;
  return withAskState(state, index, "answered");
}

export function dismissAsk(
  state: PiSessionState,
  requestId: string,
): PiSessionState {
  const index = state.askPos[requestId];
  if (index === undefined) return state;
  return withAskState(state, index, "dismissed");
}

/** Reopens a card after a failed send so the user can answer again. */
export function resetAsk(
  state: PiSessionState,
  requestId: string,
): PiSessionState {
  const index = state.askPos[requestId];
  if (index === undefined) return state;
  return withAskState(state, index, "pending");
}
