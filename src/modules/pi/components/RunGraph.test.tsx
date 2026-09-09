// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { RunGraph } from "@/modules/pi/components/RunGraph";
import { usePiStore } from "@/modules/pi/lib/piStore";
import { loadChildTranscript, useChildStore } from "@/modules/pi/lib/childStore";
import { ledgerPath, resetLedgerStore } from "@/modules/pi/lib/ledgerStore";
import { initialPiSessionState } from "@/modules/pi/lib/parse";
import { actionRecord, jsonLines, sourceRecord } from "@/modules/pi/lib/__fixtures__/ledger";
import { watchTranscripts } from "@/modules/pi/lib/rpc-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("@/modules/pi/lib/rpc-client", () => ({ watchTranscripts: vi.fn(), openPiSession: vi.fn() }));
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes, children }: { nodes: { id: string; data: { label: ReactNode } }[]; children: ReactNode }) => <div>{nodes.map((node) => <div key={node.id}>{node.data.label}</div>)}{children}</div>,
  Background: () => null,
}));

const file = actionRecord().evidencePath!;
const files = new Map<string, string>();
const original = usePiStore.getState();
const childText = jsonLines(
  { type: "session", id: "child-session" },
  { type: "agent_start", sessionId: "child-session" },
  { type: "message_start", message: { role: "user", content: "Real task" } },
  { type: "agent_end" },
);

beforeEach(() => {
  resetLedgerStore(); useChildStore.getState().reset(); vi.clearAllMocks(); files.clear();
  files.set(ledgerPath("/project", "session-1"), jsonLines(actionRecord({ status: "running", eventId: "start" }), actionRecord()));
  files.set("/project/.pi/logs/session.jsonl", jsonLines(sourceRecord()));
  files.set(file, childText);
  vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
    const path = (args as { path: string }).path;
    if (!files.has(path)) throw new Error("ENOENT");
    return { kind: "text", content: files.get(path) };
  });
  vi.mocked(watchTranscripts).mockResolvedValue({ id: 1, close: vi.fn().mockResolvedValue(undefined) });
  usePiStore.setState({ tabs: { 1: { gen: 1, cwd: "/project", state: { ...initialPiSessionState(), sessionId: "session-1" }, session: null, exited: false, exitCode: null, error: null, roles: { provider: "", model: "", smol: "" } } } });
});
afterEach(() => { cleanup(); resetLedgerStore(); useChildStore.getState().reset(); usePiStore.setState(original); });

describe("run graph reconstruction", () => {
  it("rebuilds a finished child from persisted records after unmount and a cold store reset", async () => {
    const onOpen = vi.fn();
    let view = render(<RunGraph tabId={1} onOpenChild={onOpen} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open transcript worker" })).toBeTruthy());
    await waitFor(() => expect(useChildStore.getState().children[file]?.status).toBe("done"));
    expect(view.container.querySelector('[data-uat="graph-node-child"]')?.textContent).toContain("done");
    fireEvent.click(screen.getByRole("button", { name: "Open transcript worker" }));
    expect(onOpen).toHaveBeenCalledWith(file);
    fireEvent.click(screen.getByRole("button", { name: "Inspect delegation call-1" }));
    expect(view.container.querySelector('[data-uat="action-ticket"]')?.textContent).toContain("ticket-1");
    view.unmount();
    resetLedgerStore(); useChildStore.getState().reset();
    view = render(<RunGraph tabId={1} onOpenChild={onOpen} />);
    await waitFor(() => expect(view.container.querySelector('[data-uat="graph-node-child"]')?.textContent).toContain("done"));
    await waitFor(() => expect(useChildStore.getState().children[file]?.blocks.length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll('[data-uat="graph-node-child"]')).toHaveLength(1);
  });

  it("renders only the idle orchestrator for an unused slot or another session's child", async () => {
    files.set(ledgerPath("/project", "session-1"), "");
    useChildStore.setState({ children: { "/project/.pi/agent-hub/idle.transcript.jsonl": initialPiSessionState() } });
    const { container } = render(<RunGraph tabId={1} onOpenChild={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-uat="graph-node-child"]')).toBeNull();
    const orchestrator = container.querySelector('[data-uat="graph-node-orchestrator"]');
    expect(orchestrator).not.toBeNull();
    expect(orchestrator?.textContent).toContain("Orchestrator");
    expect(orchestrator?.textContent).toContain("idle");
  });

  it("renders the orchestrator with its role and model, diagnostics compactly below the canvas", async () => {
    usePiStore.setState({
      tabs: {
        ...usePiStore.getState().tabs,
        1: {
          ...usePiStore.getState().tabs[1]!,
          roles: { provider: "ollama", model: "glm-4", smol: "" },
        },
      },
    });
    vi.mocked(watchTranscripts).mockRejectedValue(new Error("watch permission denied"));
    const { container } = render(<RunGraph tabId={1} onOpenChild={() => {}} />);
    await waitFor(() => {
      const node = container.querySelector('[data-uat="graph-node-orchestrator"]');
      expect(node?.textContent).toContain("Orchestrator · glm-4");
    });
    const orchestrator = container.querySelector('[data-uat="graph-node-orchestrator"]')!;
    // The done delegation record replaced the running one (keyed by actionId),
    // so the finished orchestrator run reads stopped.
    expect(orchestrator.textContent).toContain("stopped");
    // With a standing failure the canvas is labelled as the stale graph.
    const canvas = container.querySelector('[aria-label="Stale run graph"]')!;
    const errorLine = await waitFor(() => {
      const el = container.querySelector('[data-uat="graph-error"]');
      expect(el?.textContent).toContain("watch permission denied");
      return el!;
    });
    // Below the canvas, one compact line: no large red region above the work.
    expect(
      canvas.compareDocumentPosition(errorLine) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(errorLine.querySelector('[data-uat="error-card"]')).toBeNull();
    expect(errorLine.className).toContain("text-xs");
    expect(errorLine.textContent).toContain("Previous graph content is stale.");
  });

  it("shows watcher failures with their path while retaining the recorded graph", async () => {
    vi.mocked(watchTranscripts).mockRejectedValue(new Error("watch permission denied"));
    const { container } = render(<RunGraph tabId={1} onOpenChild={() => {}} />);
    await waitFor(() => expect(container.querySelector('[data-uat="graph-error"]')?.textContent).toContain("watch permission denied"));
    expect(container.querySelector('[data-uat="graph-error"]')?.textContent).toContain("/project/.pi/agent-hub");
    await waitFor(() => expect(container.querySelector('[data-uat="graph-node-child"]')).not.toBeNull());
    expect(screen.getByLabelText("Stale run graph")).toBeTruthy();
  });

  it("shows ledger read and transcript parse errors verbatim with paths", async () => {
    files.delete(ledgerPath("/project", "session-1"));
    const view = render(<RunGraph tabId={1} onOpenChild={() => {}} />);
    await waitFor(() => expect(view.container.querySelector('[data-uat="graph-error"]')?.textContent).toContain("actions.jsonl"));
    expect(view.container.querySelector('[data-uat="graph-error"]')?.textContent).toContain("ENOENT");
    view.unmount(); resetLedgerStore();
    files.set(ledgerPath("/project", "session-1"), jsonLines(actionRecord()));
    files.set(file, childText + "bad json\n");
    const next = render(<RunGraph tabId={1} onOpenChild={() => {}} />);
    await waitFor(() => expect(next.container.querySelector('[data-uat="graph-error"]')?.textContent).toContain("line 5"));
    expect(next.container.querySelector('[data-uat="graph-error"]')?.textContent).toContain(file);
  });

  it("keeps child replay idempotent and tolerates a partial final line", async () => {
    files.set(file, childText + '{"type":"message');
    await loadChildTranscript(file);
    const first = useChildStore.getState().children[file];
    await loadChildTranscript(file);
    expect(useChildStore.getState().children[file]).toBe(first);
    expect(first.blocks).toHaveLength(1);
    files.set(file, childText + jsonLines({ type: "message_start", message: { role: "user", content: "Next" } }));
    await act(() => loadChildTranscript(file));
    expect(useChildStore.getState().children[file].blocks).toHaveLength(2);
  });
});
