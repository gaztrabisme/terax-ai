import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChildStore } from "@/modules/pi/lib/childStore";
import {
  buildRunGraph,
  formatNodeStatus,
  type PiRunNode,
} from "@/modules/pi/lib/runGraph";
import { usePiStore } from "@/modules/pi/lib/piStore";

// React Flow and dagre load only when the pane first mounts.
const ReactFlow = lazy(() =>
  import("@xyflow/react").then((m) => ({ default: m.ReactFlow })),
);
const Background = lazy(() =>
  import("@xyflow/react").then((m) => ({ default: m.Background })),
);
import { lazy } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";

type Props = {
  tabId: number;
  onOpenChild: (file: string) => void;
};

const statusColor: Record<PiRunNode["status"], string> = {
  idle: "#94a3b8",
  running: "#3b82f6",
  done: "#22c55e",
  error: "#ef4444",
};

// Identity of a laid-out graph: node ids plus their rounded positions, so a
// re-landing with moved nodes refits while identical landings do not.
function fitKey(
  nodes: PiRunNode[],
  pos: { x: number; y: number }[],
): string {
  return nodes
    .map((n, i) => `${n.id}@${Math.round(pos[i].x)},${Math.round(pos[i].y)}`)
    .join("|");
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
  // React Flow instance + a snapshot of what the viewport was last fitted
  // for. The `fitView` prop only applies at mount, which is before the async
  // dagre layout has placed anything: the fitted viewport then stays behind
  // while nodes are moved (a lone node gets zoomed in until the post-layout
  // position lands outside it, so the pane looks empty). We refit whenever
  // the laid-out graph differs from the fitted snapshot, and only once the
  // instance exists: marking the snapshot without an instance used to swallow
  // the fit for good, because the same node set never re-fitted.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const fittedFor = useRef<string | null>(null);

  const fit = (key: string) => {
    if (fittedFor.current === key) return;
    const rf = rfRef.current;
    if (!rf) return;
    fittedFor.current = key;
    rf.fitView({ padding: 0.2, maxZoom: 1, duration: 200 });
  };

  useEffect(() => {
    let alive = true;
    void layout(graph.nodes, graph.edges)
      .then((pos) => {
        if (!alive) return;
        setLayoutError(false);
        setPositions(
          Object.fromEntries(graph.nodes.map((n, i) => [n.id, pos[i]])),
        );
        fit(fitKey(graph.nodes, pos));
      })
      .catch(() => {
        if (alive) setLayoutError(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Zero-based position of each child node within the child collection; the
  // orchestrator ("parent") is the singleton graph-node-orchestrator target.
  const childIndexById = new Map(
    graph.nodes
      .filter((n) => n.id !== "parent")
      .map((n, i) => [n.id, i] as const),
  );

  const flowNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: {
          label: (
            <div
              className="text-left"
              data-uat={
                n.id === "parent"
                  ? "graph-node-orchestrator"
                  : "graph-node-child"
              }
              data-uat-key={n.id}
              data-uat-index={n.id === "parent" ? undefined : childIndexById.get(n.id)}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ background: statusColor[n.status] }}
                />
                {n.label}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatNodeStatus(n)}
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
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onInit={(instance) => {
            rfRef.current = instance;
            // A layout may have landed before mount and dropped its fit on
            // the null instance; clear the snapshot so the next landing
            // (or nothing, if positions are unchanged) can restore it.
            fittedFor.current = null;
          }}
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
  lastErrorText: null,
};
