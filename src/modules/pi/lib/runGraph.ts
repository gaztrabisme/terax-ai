import type { PiSessionState } from "./parse";

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
};

export type PiRunEdge = { source: string; target: string };

export type PiRunGraph = {
  nodes: PiRunNode[];
  edges: PiRunEdge[];
};

export const PARENT_NODE_ID = "parent";

/**
 * Terminal states stick: agent_end (state.status "done") finishes the node as
 * done unless a tool ended in error, which stays error. A node never flips
 * back to running once its stream has ended.
 */
export function childStatus(state: PiSessionState): PiRunNodeStatus {
  if (state.blocks.some((b) => b.kind === "tool" && b.status === "error")) {
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
  if (state.blocks.some((b) => b.kind === "tool" && b.status === "error")) {
    return "error";
  }
  if (state.status === "idle") return "idle";
  return state.status === "done" ? "done" : "running";
}

export function summarizeChild(file: string, state: PiSessionState): PiRunNode {
  const name = file.split(/[\\/]/).pop() ?? file;
  return {
    id: file,
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
 * Parent node plus one node per known child transcript, star-wired. Children
 * are never filtered by status: a finished child stays a node carrying its
 * final status (done or error), so the graph keeps the full run shape after
 * the turn ends.
 */
export function buildRunGraph(
  parent: PiSessionState,
  children: Record<string, PiSessionState>,
): PiRunGraph {
  const parentTokens = parent.tokens?.totalTokens ?? parent.turnTokens;
  const nodes: PiRunNode[] = [
    {
      id: PARENT_NODE_ID,
      label: "pi (parent)",
      role: "parent",
      status: parentStatus(parent),
      elapsedMs:
        parent.startedMs !== null && parent.lastMs !== null
          ? Math.max(0, parent.lastMs - parent.startedMs)
          : null,
      tokens: parentTokens,
      toolCalls: parent.blocks.filter((b) => b.kind === "tool").length,
    },
    ...Object.entries(children).map(([file, state]) =>
      summarizeChild(file, state),
    ),
  ];
  const edges: PiRunEdge[] = Object.keys(children).map((file) => ({
    source: PARENT_NODE_ID,
    target: file,
  }));
  return { nodes, edges };
}
