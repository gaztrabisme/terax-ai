import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import { useChildStore } from "@/modules/pi/lib/childStore";
import { buildRunGraph, type PiRunNode } from "@/modules/pi/lib/runGraph";
import { usePiStore } from "@/modules/pi/lib/piStore";

// React Flow and dagre load only when the pane first mounts.
const ReactFlow = lazy(() =>
  import("@xyflow/react").then((m) => ({ default: m.ReactFlow })),
);
const Background = lazy(() =>
  import("@xyflow/react").then((m) => ({ default: m.Background })),
);
import { lazy } from "react";
import type { Edge, Node } from "@xyflow/react";

type Props = {
  tabId: number;
  onOpenChild: (file: string) => void;
};

const statusColor: Record<PiRunNode["status"], string> = {
  running: "#3b82f6",
  done: "#22c55e",
  error: "#ef4444",
};

function statusText(node: PiRunNode): string {
  const elapsed =
    node.elapsedMs !== null ? `${(node.elapsedMs / 1000).toFixed(1)}s` : "-";
  return `${node.status} - ${elapsed} - ${node.tokens} tok - ${node.toolCalls} tools`;
}

// Dagre layout runs in a worker-free lazy import: the 15 kB layout dep stays
// out of the entry chunk next to React Flow.
async function layout(
  nodes: PiRunNode[],
  edges: { source: string; target: string }[],
) {
  const dagre = (await import("@dagrejs/dagre")).default;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 60 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: 190, height: 56 });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { x: pos.x - 95, y: pos.y - 28 };
  });
}

export function RunGraph({ tabId, onOpenChild }: Props) {
  // tabId keeps the parent in sync with the pane's own session.
  const parent = usePiStore((s) => s.tabs[tabId]?.state);
  const children = useChildStore((s) => s.children);
  const graph = useMemo(
    () => buildRunGraph(parent ?? { ...emptyParent }, children),
    [parent, children],
  );
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [layoutError, setLayoutError] = useState(false);

  useEffect(() => {
    let alive = true;
    void layout(graph.nodes, graph.edges)
      .then((pos) => {
        if (alive) setLayoutError(false);
        if (alive)
          setPositions(
            Object.fromEntries(graph.nodes.map((n, i) => [n.id, pos[i]])),
          );
      })
      .catch(() => {
        if (alive) setLayoutError(true);
      });
    return () => {
      alive = false;
    };
  }, [graph]);

  const flowNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: {
          label: (
            <div className="text-left">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ background: statusColor[n.status] }}
                />
                {n.label}
              </div>
              <div className="text-xs text-muted-foreground">
                {statusText(n)}
              </div>
            </div>
          ),
        },
      })),
    [graph.nodes, positions],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        animated: true,
      })),
    [graph.edges],
  );

  if (layoutError) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Run graph layout unavailable.
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <SuspenseWithFallback>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, node) => {
            if (node.id !== "parent") onOpenChild(node.id);
          }}
        >
          <Background />
        </ReactFlow>
      </SuspenseWithFallback>
    </div>
  );
}

import { Suspense } from "react";

function SuspenseWithFallback({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="p-3 text-xs text-muted-foreground">
          Loading graph...
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

const emptyParent = {
  status: "idle" as const,
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
