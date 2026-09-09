import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  initialPiSessionState,
  type PiSessionState,
} from "./parse";
import {
  buildRunGraph,
  formatNodeStatus,
  nodeStatusText,
  parentStatus,
  PARENT_NODE_ID,
  summarizeChild,
} from "./runGraph";

const here = path.dirname(fileURLToPath(import.meta.url));

// The q6 fixture is a raw child transcript: the child's own event stream
// (session header, agent_start, message_*, turn_*, agent_end), exactly what
// pi_watch_transcripts streams line by line.
const FIXTURE_LINES = readFileSync(
  path.join(here, "__fixtures__", "q6-child-transcript-sample.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0);

const CHILD_FILE = "agent-hub/22838/worker-1.transcript.jsonl";

// The q1 capture is a driver log of a full parent-session turn: wire frames
// with dir "stdin"/"stdout", the stdout entries byte-for-byte what the Rust
// pi module forwards over the event channel. agent_end included.
const Q1_LINES = readFileSync(
  path.join(here, "__fixtures__", "q1-rpc-basic.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as { dir: string; raw: string })
  .filter((entry) => entry.dir === "stdout")
  .map((entry) => entry.raw);

function replayParent(lines: string[]): PiSessionState {
  let state = initialPiSessionState();
  for (const line of lines) {
    state = applyEvent(state, line);
  }
  return state;
}

function replayChild(lines: string[] = FIXTURE_LINES): PiSessionState {
  let state = initialPiSessionState();
  for (const line of lines) {
    state = applyEvent(state, line);
  }
  return state;
}

describe("runGraph over the q6 child transcript", () => {
  it("marks the child done from agent_end presence", () => {
    const state = replayChild();
    const node = summarizeChild(CHILD_FILE, state);
    expect(node.status).toBe("done");
    expect(node.role).toBe("child");
  });

  it("reports running when the stream has no agent_end yet", () => {
    const state = replayChild(
      FIXTURE_LINES.filter((l) => !l.includes('"agent_end"')),
    );
    expect(summarizeChild(CHILD_FILE, state).status).toBe("running");
  });

  it("sums turn_end usage into tokens", () => {
    const node = summarizeChild(CHILD_FILE, replayChild());
    expect(node.tokens).toBe(3912);
  });

  it("measures elapsed from the first to the last turn timestamp", () => {
    const node = summarizeChild(CHILD_FILE, replayChild());
    expect(node.elapsedMs).toBe(0);
    const late = replayChild(
      FIXTURE_LINES.map((l) =>
        l.includes('"turnIndex":0')
          ? l.replace('"turnIndex":0', '"turnIndex":1')
          : l,
      ),
    );
    expect(late.startedMs).not.toBeNull();
  });

  it("counts tool calls", () => {
    const withTool = replayChild([
      ...FIXTURE_LINES,
      '{"type":"tool_execution_start","toolCallId":"call_x","toolName":"bash","args":{}}',
      '{"type":"tool_execution_end","toolCallId":"call_x","toolName":"bash","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}',
    ]);
    expect(summarizeChild(CHILD_FILE, withTool).toolCalls).toBe(1);
  });

  it("wires the parent to every child and summarizes the parent", () => {
    const graph = buildRunGraph(replayChild(), {
      [CHILD_FILE]: replayChild(),
      "agent-hub/22838/scout-1.transcript.jsonl": replayChild(
        FIXTURE_LINES.filter((l) => !l.includes('"agent_end"')),
      ),
    });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([
      { source: PARENT_NODE_ID, target: CHILD_FILE },
      {
        source: PARENT_NODE_ID,
        target: "agent-hub/22838/scout-1.transcript.jsonl",
      },
    ]);
    const parent = graph.nodes.find((n) => n.id === PARENT_NODE_ID);
    expect(parent?.role).toBe("parent");
    expect(parent?.status).toBe("done");
    const labels = graph.nodes.map((n) => n.label);
    expect(labels).toContain("worker-1");
  });

  it("ignores the session header line like any unknown type", () => {
    const state = replayChild();
    expect(state.sessionId).toBe("8b394965-ac25-4144-8d5e-87dc14d04ad6");
  });

  it("keeps finished children as nodes with final status and a done parent", () => {
    const done = replayChild();
    const graph = buildRunGraph(done, { [CHILD_FILE]: done });
    expect(graph.nodes.map((n) => n.id)).toEqual([PARENT_NODE_ID, CHILD_FILE]);
    const parent = graph.nodes.find((n) => n.id === PARENT_NODE_ID);
    const child = graph.nodes.find((n) => n.id === CHILD_FILE);
    expect(parent?.status).toBe("done");
    expect(child?.status).toBe("done");
    expect(child?.role).toBe("child");
  });

  it("parent only, running, tokens > 0 produces one node", () => {
    const running = replayChild(
      FIXTURE_LINES.filter((l) => !l.includes('"agent_end"')),
    );
    expect(running.status).toBe("thinking");
    const graph = buildRunGraph(running, {});
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe(PARENT_NODE_ID);
    expect(graph.nodes[0].role).toBe("parent");
    expect(graph.nodes[0].status).toBe("running");
    expect(graph.nodes[0].tokens).toBeGreaterThan(0);
    expect(graph.edges).toEqual([]);
  });

  it("an idle parent is always its own idle node so the empty graph explains itself", () => {
    expect(parentStatus(initialPiSessionState())).toBe("idle");
    const graph = buildRunGraph(initialPiSessionState(), {});
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe(PARENT_NODE_ID);
    expect(graph.nodes[0].role).toBe("parent");
    expect(graph.nodes[0].status).toBe("idle");
    expect(graph.edges).toEqual([]);
  });

  it("labels the orchestrator with its role and the session model", () => {
    expect(buildRunGraph(initialPiSessionState(), {}).nodes[0].label).toBe(
      "Orchestrator",
    );
    expect(
      buildRunGraph(initialPiSessionState(), {}, undefined, undefined, "glm-4")
        .nodes[0].label,
    ).toBe("Orchestrator · glm-4");
  });

  it("displays a finished orchestrator run as stopped, children as done", () => {
    const parent = buildRunGraph(replayChild(), {}).nodes[0];
    expect(parent.status).toBe("done");
    expect(nodeStatusText(parent)).toBe("stopped");
    expect(formatNodeStatus(parent).startsWith("stopped")).toBe(true);
    const child = summarizeChild(CHILD_FILE, replayChild());
    expect(nodeStatusText(child)).toBe("done");
  });

  it("a finished child keeps error as its final status when a tool failed", () => {
    const failed = replayChild([
      ...FIXTURE_LINES,
      '{"type":"tool_execution_start","toolCallId":"call_e","toolName":"bash","args":{}}',
      '{"type":"tool_execution_end","toolCallId":"call_e","toolName":"bash","result":{"content":[]},"isError":true}',
    ]);
    const graph = buildRunGraph(replayChild(), { [CHILD_FILE]: failed });
    expect(graph.nodes.map((n) => n.id)).toContain(CHILD_FILE);
    expect(graph.nodes.find((n) => n.id === CHILD_FILE)?.status).toBe("error");
    // The parent itself is unaffected by the child's failed tool.
    expect(graph.nodes.find((n) => n.id === PARENT_NODE_ID)?.status).toBe(
      "done",
    );
  });
});

describe("runGraph over the q1 parent session capture", () => {
  const final = replayParent(Q1_LINES);
  const graph = buildRunGraph(final, {});

  it("keeps the parent node after agent_end with done status", () => {
    expect(final.status).toBe("done");
    expect(graph.nodes).toHaveLength(1);
    const parent = graph.nodes[0];
    expect(parent.id).toBe(PARENT_NODE_ID);
    expect(parent.role).toBe("parent");
    expect(parent.status).toBe("done");
  });

  it("carries the session token total and tool count on the parent", () => {
    const parent = graph.nodes[0];
    expect(parent.tokens).toBe(4939);
    expect(parent.toolCalls).toBe(0);
    expect(graph.edges).toEqual([]);
  });
});
