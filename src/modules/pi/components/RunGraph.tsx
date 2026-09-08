import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadChildTranscript, useChildStore, watchChildTranscripts } from "@/modules/pi/lib/childStore";
import {
  buildRunGraph,
  actionTranscriptPath,
  childAgentId,
  formatNodeStatus,
  type PiRunNode,
} from "@/modules/pi/lib/runGraph";
import { usePiStore } from "@/modules/pi/lib/piStore";
import { initialPiSessionState } from "@/modules/pi/lib/parse";
import { actionTurnKey, ledgerDiscrepancies, ledgerPath, useLedger } from "@/modules/pi/lib/ledgerStore";
import { LedgerActionRow, usageFooterId } from "@/modules/pi/components/blocks/ActionRow";
import { ErrorCard } from "@/modules/pi/components/Transcript";

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
    g.setNode(n.id, { width: 190, height: 84 });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { x: pos.x - 95, y: pos.y - 42 };
  });
}

export function RunGraph({ tabId, onOpenChild }: Props) {
  // tabId keeps the parent in sync with the pane's own session.
  const entry = usePiStore((s) => s.tabs[tabId]);
  const parent = entry?.state;
  const cwd = entry?.cwd;
  const sessionId = parent?.sessionId;
  const inFlight = !!parent && ["thinking", "tool", "awaiting-ask"].includes(parent.status);
  const ledger = useLedger(cwd, sessionId, inFlight);
  const children = useChildStore((s) => s.children);
  const owners = useChildStore((s) => s.owners);
  const childErrors = useChildStore((s) => s.errors);
  const owner = cwd && sessionId ? ledgerPath(cwd, sessionId) : null;
  const paths = useMemo(() => [...new Set(Object.values(ledger.actions).map((action) => actionTranscriptPath(action, cwd)).filter((path): path is string => !!path))], [ledger.actions, cwd]);
  useEffect(() => {
    for (const path of paths) void loadChildTranscript(path, owner ?? undefined);
  }, [paths, owner]);
  useEffect(() => {
    if (!cwd) return;
    return watchChildTranscripts(cwd, () => {
      const current = usePiStore.getState().tabs[tabId]?.state;
      return current?.sessionId && ["thinking", "tool", "awaiting-ask"].includes(current.status)
        ? ledgerPath(cwd, current.sessionId) : null;
    });
  }, [cwd, tabId]);
  const scopedChildren = useMemo(() => Object.fromEntries(Object.entries(children).filter(([path]) =>
    paths.includes(path) || (!!owner && owners[path] === owner) || Object.values(ledger.actions).some((action) => action.agentId !== null && action.agentId === childAgentId(path)),
  )), [children, owners, owner, paths, ledger.actions]);
  const graph = useMemo(
    () => buildRunGraph(parent ?? emptyParent, scopedChildren, ledger, cwd),
    [parent, scopedChildren, ledger, cwd],
  );
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [layoutError, setLayoutError] = useState<string | null>(null);
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
        setLayoutError(null);
        setPositions(
          Object.fromEntries(graph.nodes.map((n, i) => [n.id, pos[i]])),
        );
        fit(fitKey(graph.nodes, pos));
      })
      .catch((error: unknown) => {
        if (alive) setLayoutError(`Run graph layout: ${String(error)} (${cwd ?? "."}/.pi/logs/graph.jsonl)`);
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
        style: { width: 190, minHeight: 84 },
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
              {n.path ? <button type="button" aria-label={`Open transcript ${n.label}`} className="nodrag rounded text-xs text-muted-foreground underline hover:text-foreground" onClick={(event) => { event.stopPropagation(); onOpenChild(n.path!); }}>Open transcript</button> : null}
              {n.role === "child" && !n.path ? <div className="text-xs text-muted-foreground">Transcript path not reported</div> : null}
            </div>
          ),
        },
      })),
    [graph.nodes, positions, onOpenChild],
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

  const errors = [ledger.error, layoutError, ...Object.entries(childErrors)
    .filter(([path]) => paths.includes(path) || (owner && owners[path] === owner) || (cwd && (path === cwd || path === `${cwd}/.pi/agent-hub`)) || Object.values(ledger.actions).some((action) => action.agentId !== null && action.agentId === childAgentId(path)))
    .map(([, error]) => error)].filter((error): error is string => !!error);
  const discrepancies = ledgerDiscrepancies(ledger, inFlight);

  return (
    <div className="flex h-full w-full flex-col">
      {errors.length > 0 ? <div data-uat="graph-error" aria-label="Run graph error" role="alert" className="space-y-2 p-2">
        {errors.map((text) => <ErrorCard key={text} block={{ kind: "error", text, at: 0 }} />)}
        <div className="text-xs text-muted-foreground">Previous graph content is stale.</div>
      </div> : null}
      {discrepancies.map((text) => <ErrorCard key={text} block={{ kind: "error", text, at: 0 }} />)}
      <div className="min-h-0 flex-1" aria-label={errors.length ? "Stale run graph" : "Run graph"}>
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
            const path = graph.nodes.find((n) => n.id === node.id)?.path;
            if (path) onOpenChild(path);
          }}
        >
          <Background />
        </ReactFlow>
      </SuspenseWithFallback>
      </div>
      {Object.keys(ledger.actions).length > 0 ? <div className="max-h-[40%] space-y-1 overflow-auto border-t border-border/60 p-2" aria-label="Run actions">
        {Object.values(ledger.actions).map((action) => {
          const turnKey = actionTurnKey(action, ledger, parent?.blocks ?? []);
          return <LedgerActionRow key={action.actionId} action={action} footerId={turnKey ? usageFooterId(sessionId, turnKey) : undefined} />;
        })}
      </div> : null}
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

const emptyParent = initialPiSessionState();
