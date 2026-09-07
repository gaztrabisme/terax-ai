export type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

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
  streaming: boolean;
  /** Creation epoch ms; applyEvent pins it from its optional `now` argument. */
  at: number;
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

export type PiBlock = PiMessageBlock | PiToolBlock | PiAskBlock;

export type PiStatus = "idle" | "thinking" | "tool" | "awaiting-ask" | "done";

export type PiSessionState = {
  status: PiStatus;
  sessionId: string | null;
  blocks: PiBlock[];
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asUsage(value: unknown): PiUsage | null {
  if (!isRecord(value) || typeof value.totalTokens !== "number") return null;
  return {
    input: typeof value.input === "number" ? value.input : 0,
    output: typeof value.output === "number" ? value.output : 0,
    cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
    cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
    totalTokens: value.totalTokens,
  };
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

export function promptLine(message: string): string {
  return JSON.stringify({ type: "prompt", message });
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

  switch (event.type) {
    case "agent_start":
    case "turn_start": {
      const sessionId = asString(event.sessionId);
      const ts = typeof event.timestamp === "number" ? event.timestamp : null;
      return {
        ...state,
        status: state.status === "awaiting-ask" ? state.status : "thinking",
        ...(sessionId !== null && { sessionId }),
        ...(ts !== null && {
          startedMs: state.startedMs ?? ts,
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
      const usage = asUsage(
        isRecord(event.message) ? event.message.usage : null,
      );
      if (!usage) return state;
      return {
        ...state,
        tokens: usage,
        turnTokens: state.turnTokens + usage.totalTokens,
      };
    }
    case "agent_end":
      return { ...state, status: "done" };
    case "tool_execution_start":
      return applyToolStart(state, event, now);
    case "tool_execution_update":
      return applyToolUpdate(state, event);
    case "tool_execution_end":
      return applyToolEnd(state, event, now);
    case "ask_request":
      return applyAskRequest(state, event, now);
    case "response":
      return applyResponse(state, event);
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
    blocks: [...state.blocks, block],
    openMessageId: role === "assistant" ? block.id : state.openMessageId,
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
): PiSessionState {
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
