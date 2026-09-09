import { asUsage, type PiSessionState } from "./parse";
import { actionDuration, EMPTY_LEDGER, type ActionRecord, type LedgerSnapshot } from "@/modules/pi/lib/ledgerStore";

export type PiRunNodeStatus = "idle" | "running" | "done" | "error";

export type PiRunNode = {
  id: string;
  label: string;
  role: "parent" | "child";
  status: PiRunNodeStatus;
  /** From the first turn_start timestamp to the last. */
  elapsedMs: number | null;
  /** Sum of turn_end usage.totalTokens. */
  tokens: number;
  toolCalls: number;
  path?: string;
};

export type PiRunEdge = { source: string; target: string };

export type PiRunGraph = {
  nodes: PiRunNode[];
  edges: PiRunEdge[];
};

export const PARENT_NODE_ID = "parent";

/**
 * Display status for a node. The orchestrator's finished run reads "stopped"
 * (the session ended, whether by agent_end or stop), not "done"; children
 * keep their raw status.
 */
export function nodeStatusText(node: PiRunNode): string {
  if (node.role === "parent" && node.status === "done") return "stopped";
  return node.status;
}

/**
 * One-line status for a node, e.g. "done · 4,828 tok · 2 tools". Fields with
 * nothing to show are dropped: no elapsed yet, zero tokens, zero tool calls.
 */
export function formatNodeStatus(node: PiRunNode): string {
  const parts: string[] = [nodeStatusText(node)];
  if (node.elapsedMs !== null) {
    parts.push(`${(node.elapsedMs / 1000).toFixed(1)}s`);
  }
  if (node.tokens > 0) parts.push(`${node.tokens.toLocaleString("en-US")} tok`);
  if (node.toolCalls > 0) parts.push(`${node.toolCalls} tools`);
  return parts.join(" · ");
}

/**
 * Terminal states stick: agent_end (state.status "done") finishes the node as
 * done unless a tool ended in error, which stays error. A node never flips
 * back to running once its stream has ended.
 */
export function childStatus(state: PiSessionState): PiRunNodeStatus {
  if (state.status === "error" || state.blocks.some((b) => b.kind === "tool" && b.status === "error")) {
    return "error";
  }
  return state.status === "done" ? "done" : "running";
}

/**
 * Parent status differs from a child's: the parent exists before its first
 * turn, so PiStatus "idle" maps to its own idle node status; thinking, tool
 * and awaiting-ask all mean the run is live. A tool that ended in error keeps
 * the node in error.
 */
export function parentStatus(state: PiSessionState): PiRunNodeStatus {
  if (state.status === "error" || state.blocks.some((b) => b.kind === "tool" && b.status === "error")) {
    return "error";
  }
  if (state.status === "idle") return "idle";
  return state.status === "done" ? "done" : "running";
}

export function summarizeChild(file: string, state: PiSessionState): PiRunNode {
  const name = file.split(/[\\/]/).pop() ?? file;
  return {
    id: file,
    path: file,
    label: name.replace(/\.transcript\.jsonl$/, ""),
    role: "child",
    status: childStatus(state),
    elapsedMs:
      state.startedMs !== null && state.lastMs !== null
        ? Math.max(0, state.lastMs - state.startedMs)
        : null,
    tokens: state.turnTokens,
    toolCalls: state.blocks.filter((b) => b.kind === "tool").length,
  };
}

/**
 * Parent node plus one node per known child transcript, star-wired. The
 * orchestrator node always exists (UX-13): before the first turn it is the
 * session's idle anchor, so the empty graph explains itself. Children are
 * never filtered by status: a finished child stays a node carrying its final
 * status (done or error), so the graph keeps the full run shape after the
 * turn ends.
 */
export function buildRunGraph(
  parent: PiSessionState,
  children: Record<string, PiSessionState>,
  ledger: LedgerSnapshot = EMPTY_LEDGER,
  cwd?: string,
  model?: string,
): PiRunGraph {
  const records = Object.values(ledger.actions);
  const realChildren = Object.entries(children).filter(([, state]) => hasTask(state));
  const childNodes = new Map(realChildren.map(([file, state]) => [file, summarizeChild(file, state)]));
  for (const action of records.filter((r) => r.kind === "delegation")) {
    const file = actionTranscriptPath(action, cwd) ?? realChildren.find(([file]) => childAgentId(file) === action.agentId)?.[0];
    const id = file ?? `action:${action.actionId}`;
    const existing = childNodes.get(id);
    childNodes.set(id, {
      id, path: file, label: action.role ?? action.agentId ?? "delegation", role: "child",
      status: action.status === "failed" || action.status === "cancelled" ? "error"
        : action.status === "done" ? "done" : existing?.status ?? "running",
      elapsedMs: actionDuration(action),
      tokens: action.usage.input !== null && action.usage.output !== null ? action.usage.input + action.usage.output + (action.usage.cacheRead ?? 0) : existing?.tokens ?? 0,
      toolCalls: existing?.toolCalls ?? 0,
    });
  }
  const sourceIds = new Set(records.map((r) => r.usage.sourceEventId).filter((id): id is string => !!id));
  const sourceTokens = [...sourceIds].reduce((total, id) => {
    const message = ledger.sources[id]?.event.message as { usage?: unknown } | undefined;
    return total + (asUsage(message?.usage)?.totalTokens ?? 0);
  }, 0);
  const parentTokens = records.length ? sourceTokens : parent.turnTokens;
  const recordedStatus = records.some((r) => r.status === "failed" || r.status === "cancelled") ? "error"
    : records.some((r) => r.status === "running") ? "running" : "done";
  const nodes: PiRunNode[] = [
    {
      id: PARENT_NODE_ID,
      label: model ? `Orchestrator · ${model}` : "Orchestrator",
      role: "parent",
      status: hasTask(parent) || records.length === 0 ? parentStatus(parent) : recordedStatus,
      elapsedMs:
        parent.startedMs !== null && parent.lastMs !== null
          ? Math.max(0, parent.lastMs - parent.startedMs)
          : null,
      tokens: parentTokens,
      toolCalls: records.length ? records.filter((r) => r.kind === "tool" || r.kind === "delegation").length : parent.blocks.filter((b) => b.kind === "tool").length,
    },
    ...childNodes.values(),
  ];
  const edges: PiRunEdge[] = [...childNodes.keys()].map((file) => ({
    source: PARENT_NODE_ID,
    target: file,
  }));
  return { nodes, edges };
}

export function hasTask(state: PiSessionState): boolean {
  return state.blocks.some((block) => block.kind === "message" || block.kind === "tool" || block.kind === "ask");
}

export function childAgentId(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.transcript\.jsonl$/, "");
}

export function actionTranscriptPath(action: ActionRecord, cwd?: string): string | undefined {
  const path = action.evidencePath?.replace(/\\/g, "/");
  if (!path?.endsWith(".transcript.jsonl")) return undefined;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return path;
  if (!cwd || path.split("/").includes("..")) return undefined;
  return `${cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
}
