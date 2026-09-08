// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { actionRecord, assistantMessage, jsonLines, sourceRecord } from "@/modules/pi/lib/__fixtures__/ledger";
import { applyEvent, initialPiSessionState, type PiSessionState } from "@/modules/pi/lib/parse";
import { ledgerPath, refreshLedger, resetLedgerStore } from "@/modules/pi/lib/ledgerStore";
import { ToolRow } from "@/modules/pi/components/blocks/ToolRow";
import { Transcript } from "@/modules/pi/components/Transcript";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("@/components/chat", () => ({
  Conversation: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ConversationContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
  ConversationEmptyState: () => <div>Empty</div>,
  MessageResponse: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Shimmer: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function session(): PiSessionState {
  return [
    { type: "agent_start", sessionId: "session-1" },
    { type: "message_start", message: { role: "user", content: "Work" } },
    { type: "message_start", message: assistantMessage },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "true" } },
    { type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
    { type: "message_end", message: assistantMessage },
    sourceRecord().event,
    { type: "agent_end" },
  ].reduce<PiSessionState>((state, event) => applyEvent(state, JSON.stringify(event)), initialPiSessionState());
}

const files = new Map<string, string>();
const path = ledgerPath("/project", "session-1");
const sourcePath = "/project/.pi/logs/session.jsonl";
const cell = (id: string) => document.querySelector(`[data-uat="${id}"]`);

beforeEach(() => {
  resetLedgerStore(); files.clear();
  files.set(path, jsonLines(actionRecord({ kind: "tool" })));
  files.set(sourcePath, jsonLines(sourceRecord()));
  vi.mocked(invoke).mockImplementation(async (_command, args) => ({ kind: "text", content: files.get((args as { path: string }).path) ?? "" }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); resetLedgerStore(); vi.clearAllMocks(); });

describe("ledger action fields", () => {
  it("stays quiet until both folds expand, then links null usage to its owning footer", async () => {
    render(<Transcript blocks={session().blocks} cwd="/project" sessionId="session-1" onAnswer={() => {}} onDismiss={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(cell("action-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect turn 1 activity" }));
    expect(cell("action-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect bash call-1" }));
    expect(cell("action-row")?.getAttribute("data-uat-key")).toBe("call-1");
    expect(cell("action-role")?.textContent).toBe("Roleworker");
    expect(cell("action-agent")?.textContent).toBe("Agentworker-1");
    expect(cell("action-ticket")?.textContent).toBe("Ticketticket-1");
    expect(cell("action-duration")?.textContent).toBe("Duration2.5 s");
    expect(screen.getAllByText("not separately reported")).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "Tokens: not separately reported. Show owning turn usage" }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(document.activeElement).toBe(cell("usage-footer"));
  });

  it("updates the same expanded row from a correction without duplicating it", async () => {
    render(<Transcript blocks={session().blocks} cwd="/project" sessionId="session-1" onAnswer={() => {}} onDismiss={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Inspect turn 1 activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect bash call-1" }));
    files.set(path, jsonLines(actionRecord({ kind: "tool" }), actionRecord({ kind: "tool", eventId: "corrected", usage: { input: 8, output: 2, cacheRead: null, cost: 0.002, currency: "USD", sourceEventId: "source-1" } })));
    await act(() => refreshLedger("/project", "session-1"));
    expect(document.querySelectorAll('[data-uat="action-row"]')).toHaveLength(1);
    expect(cell("action-tokens")?.textContent).toBe("Tokens8 in, 2 out");
    expect(cell("action-cost")?.textContent).toBe("Cost0.002 USD");
  });

  it("keeps duration and currency unknown when the record does not supply them", () => {
    const block = session().blocks.find((b) => b.kind === "tool")!;
    if (block.kind !== "tool") throw new Error("fixture missing tool");
    render(<ToolRow block={block} action={actionRecord({ startedAt: null, usage: { ...actionRecord().usage, cost: 0 } })} defaultOpen />);
    expect(cell("action-duration")?.textContent).toBe("Durationunknown");
    expect(cell("action-cost")?.textContent).toBe("Cost0 currency unknown");
  });

  it("keeps a pending action inspectable and reflects its recorded cancellation", () => {
    const block = session().blocks.find((b) => b.kind === "tool")!;
    if (block.kind !== "tool") throw new Error("fixture missing tool");
    const running = { ...block, status: "running" as const, resultText: null };
    const view = render(<ToolRow block={running} action={actionRecord({ status: "running", endedAt: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect bash call-1" }));
    expect(cell("action-duration")?.textContent).toBe("Durationunknown");
    view.rerender(<ToolRow block={running} action={actionRecord({ status: "cancelled" })} />);
    expect(screen.getByLabelText("cancelled")).toBeTruthy();
    expect(cell("action-row")).not.toBeNull();
  });
});

describe("truthful usage cards", () => {
  it("shows displayed and event sums on conflict, and recovers on a correction", () => {
    const initial = session();
    const conflict = initial.blocks.map((block) => block.kind === "message" && block.role === "assistant" ? { ...block, usage: { ...block.usage!, input: 99 } } : block);
    const { rerender } = render(<Transcript blocks={conflict} onAnswer={() => {}} onDismiss={() => {}} />);
    expect(cell("error-card")?.textContent).toMatch(/^usage-discrepancy:.*displayed=.*"input":99.*source=.*"input":12.*\.pi\/logs\/session.jsonl/);
    expect(cell("usage-footer")).toBeNull();
    rerender(<Transcript blocks={initial.blocks} onAnswer={() => {}} onDismiss={() => {}} />);
    expect(cell("error-card")).toBeNull();
    expect(cell("usage-footer")?.textContent).toContain("12 in, 3 out");
    expect(cell("cache-qualifier")).not.toBeNull();
  });

  it("compares against the persisted source and recovers when the source is corrected", async () => {
    files.set(sourcePath, jsonLines(sourceRecord({ event: { ...sourceRecord().event, message: { ...assistantMessage, usage: { ...assistantMessage.usage, input: 42 } } } })));
    render(<Transcript blocks={session().blocks} cwd="/project" sessionId="session-1" onAnswer={() => {}} onDismiss={() => {}} />);
    await waitFor(() => expect(cell("error-card")?.textContent).toContain('"input":42'));
    files.set(sourcePath, jsonLines(sourceRecord()));
    await act(() => refreshLedger("/project", "session-1"));
    expect(cell("error-card")).toBeNull();
  });

  it("renders missing source evidence loudly and defers a reserved future source while running", async () => {
    files.set(sourcePath, "");
    const props = { blocks: session().blocks, cwd: "/project", sessionId: "session-1", onAnswer: () => {}, onDismiss: () => {} };
    const { rerender } = render(<Transcript {...props} inFlight />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(cell("error-card")).toBeNull();
    rerender(<Transcript {...props} inFlight={false} />);
    await waitFor(() => expect(cell("error-card")?.textContent).toContain("source=missing event source-1"));
  });

  it("a completed zero-usage turn gets one empty-completion card and no success footer", () => {
    const message = { ...assistantMessage, usage: { input: 0, output: 0, totalTokens: 0 } };
    const events = [{ type: "message_start", message: { role: "user", content: "Empty" } }, { type: "message_start", message }, { type: "message_end", message }, { type: "turn_end", message }, { type: "agent_end" }];
    const state = events.reduce((s, e) => applyEvent(s, JSON.stringify(e)), initialPiSessionState());
    expect(state.blocks.filter((block) => block.kind === "error")).toHaveLength(1);
    const view = render(<Transcript blocks={state.blocks.filter((block) => block.kind !== "error")} inFlight onAnswer={() => {}} onDismiss={() => {}} />);
    expect(cell("error-card")).toBeNull();
    view.rerender(<Transcript blocks={state.blocks} inFlight={false} onAnswer={() => {}} onDismiss={() => {}} />);
    expect(screen.getAllByText("empty completion: no usage reported")).toHaveLength(1);
    expect(cell("usage-footer")).toBeNull();
    const corrected = applyEvent(state, JSON.stringify({ type: "turn_end", message: assistantMessage }));
    view.rerender(<Transcript blocks={corrected.blocks} onAnswer={() => {}} onDismiss={() => {}} />);
    expect(cell("error-card")).toBeNull();
    expect(cell("usage-footer")?.textContent).toContain("12 in, 3 out");
  });

  it("does not count replayed turn_end updates twice and accepts corrections", () => {
    const state = session();
    const repeated = applyEvent(state, JSON.stringify(sourceRecord().event));
    expect(repeated.turnTokens).toBe(17);
    expect(repeated.sessionCost).toBe(0.04);
    const corrected = applyEvent(repeated, JSON.stringify({ ...sourceRecord().event, message: { ...assistantMessage, usage: { ...assistantMessage.usage, totalTokens: 20, output: 6 } } }));
    expect(corrected.turnTokens).toBe(20);
    expect(corrected.blocks.find((b) => b.kind === "message" && b.role === "assistant")).toMatchObject({ usage: { output: 6 } });
  });

  it("keeps the existing streaming prompt rejection card with its log path", () => {
    const state = applyEvent(session(), JSON.stringify({ type: "response", command: "prompt", success: false, error: "Agent is currently streaming; specify streamingBehavior" }));
    render(<Transcript blocks={state.blocks} onAnswer={() => {}} onDismiss={() => {}} />);
    expect(cell("error-card")?.textContent).toContain("Agent is currently streaming; specify streamingBehavior");
    expect(cell("error-card")?.textContent).toContain(".pi/logs/session.jsonl");
  });
});
