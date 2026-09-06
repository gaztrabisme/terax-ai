import type { PiSessionState } from "./parse";

export type PiRunNodeStatus = "running" | "done" | "error";

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

/** agent_end seen means done; a tool that ended in error marks error. */
export function childStatus(state: PiSessionState): PiRunNodeStatus {
  if (state.blocks.some((b) => b.kind === "tool" && b.status === "error")) {
    return "error";
  }
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

/** Parent node plus one node per known child transcript, star-wired. */
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
      status: childStatus(parent),
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
