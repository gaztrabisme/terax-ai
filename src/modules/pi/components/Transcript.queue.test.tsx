// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript, TurnCards } from "@/modules/pi/components/Transcript";
import { applyEvent, initialPiSessionState, requestCancel, sessionExited } from "@/modules/pi/lib/parse";
import type { PiQueued } from "@/modules/pi/lib/piStore";
import { collectSnapshot } from "@/modules/uat/snapshot";

const settingsInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: settingsInvoke }));

vi.mock("@/components/chat", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Conversation: Container, ConversationContent: Container, MessageResponse: Container,
    Shimmer: Container, ConversationScrollButton: () => null, ConversationEmptyState: () => null };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const callbacks = { onAnswer: () => {}, onDismiss: () => {} };
const queued: PiQueued[] = ["q-one", "q-two"].map((id) => ({
  id, text: "same prompt", state: "not-sent", attachmentIds: [], images: [], submittedAt: "2026-09-09T00:00:00Z",
}));
const user = (text: string) => ({ type: "message_start", message: { role: "user", content: text } });
const apply = (state: ReturnType<typeof initialPiSessionState>, event: object) => applyEvent(state, JSON.stringify(event), 1000);

function snapshot() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 1, y: 1, width: 40, height: 20, top: 1, left: 1, bottom: 21, right: 41, toJSON: () => ({}) });
  return collectSnapshot(document, window,
    { cwd: "/project", tabs: [{ uat: "tab-active", key: "tab-a", kind: "pi", title: "Chat", active: true }] },
    { cwd: "/project", runId: "run-a", windowId: "main", seq: 0, layoutSeq: 0 },
    { generation: 1, window: { x: 0, y: 0, w: 800, h: 600, scale: 1, cssToPoint: 1, driverUnits: "macos-points",
      driverOrigin: { x: 0, y: 0 }, contentOffset: { x: 0, y: 0 }, displayId: "main", displayPhysicalOrigin: { x: 0, y: 0 },
      displayDriverOrigin: { x: 0, y: 0 }, coordinateStatus: "supported" } }, 1, null);
}

describe("G1 transcript recovery", () => {
  it("updates one summary over three retries and exposes the attempt history", () => {
    let state = apply(initialPiSessionState(), user("first"));
    state = apply(state, { type: "agent_end", error: "initial error" });
    const view = render(<Transcript {...callbacks} blocks={state.blocks} />);
    const key = view.container.querySelector('[data-uat="error-card"]')!.getAttribute("data-uat-key");
    for (let attempt = 1; attempt <= 3; attempt++) {
      state = apply(state, { type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: attempt * 2000, errorMessage: `error ${attempt}` });
      view.rerender(<Transcript {...callbacks} blocks={state.blocks} />);
      const cards = view.container.querySelectorAll('[data-uat="retry-card"], [data-uat="error-card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0].getAttribute("data-uat-key")).toBe(key);
      expect(cards[0].textContent).toContain(`Last error: error ${attempt}`);
    }
    state = apply(state, { type: "agent_start" });
    view.rerender(<Transcript {...callbacks} blocks={state.blocks} />);
    expect(view.getByText("Attempt 3/3 running")).toBeTruthy();
    const details = view.container.querySelector("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(true);
    const attempts = view.container.querySelectorAll('[data-uat="retry-attempt"]');
    expect(attempts).toHaveLength(4);
    state = apply(state, { type: "auto_retry_end", attempt: 3, success: false, finalError: "offline" });
    view.rerender(<Transcript {...callbacks} blocks={state.blocks} />);
    expect(view.container.querySelectorAll('[data-uat="retry-card"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-uat="retry-card"]')!.textContent).toContain("Final failure after 3 retries");
    expect(view.container.querySelector('[data-uat="retry-card"]')!.textContent).toContain("Last error: offline");
    expect(view.container.querySelector("details")!.open).toBe(true);
  });

  it.each(["cancel", "exit"])("replaces the pending retry status after %s", (ending) => {
    let state = apply(initialPiSessionState(), user("first"));
    state = apply(state, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "offline" });
    state = ending === "cancel" ? requestCancel(state) : sessionExited(state);
    const { container } = render(<Transcript {...callbacks} blocks={state.blocks} queued={queued} />);
    const card = container.querySelector('[data-uat="retry-card"]')!;
    expect(card.textContent).toContain(ending === "cancel" ? "Cancelled after 2 retries" : "Session exited after 2 retries");
    expect(container.querySelectorAll('[data-uat="retry-card"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-uat="turn-queued"]')).toHaveLength(2);
  });

  it("scopes Retry, Edit and Cancel to each queued record and gates Retry while busy", () => {
    const retry = vi.fn(), edit = vi.fn(), cancel = vi.fn();
    const view = render(<Transcript {...callbacks} blocks={[]} queued={queued} onRetryQueued={retry} onEditQueued={edit} onCancelQueued={cancel} />);
    expect(view.getAllByText("Queued, not sent")).toHaveLength(2);
    fireEvent.click(view.getAllByText("Retry")[1]);
    fireEvent.click(view.getAllByText("Edit")[0]);
    fireEvent.click(view.getAllByText("Cancel")[1]);
    expect(retry).toHaveBeenCalledWith("q-two");
    expect(edit).toHaveBeenCalledWith("q-one");
    expect(cancel).toHaveBeenCalledWith("q-two");
    view.rerender(<Transcript {...callbacks} blocks={[]} queued={queued} queueRetryDisabled onRetryQueued={retry} onEditQueued={edit} onCancelQueued={cancel} />);
    expect((view.getAllByText("Retry")[0] as HTMLButtonElement).disabled).toBe(true);
    expect((view.getAllByText("Edit")[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("gives repeated turns, status cards, history and queue actions unique UAT identities", () => {
    let state = initialPiSessionState();
    for (let turn = 0; turn < 2; turn++) {
      state = apply(state, user("same"));
      state = apply(state, { type: "agent_end", error: "same error" });
      for (let attempt = 1; attempt <= 3; attempt++) {
        state = apply(state, { type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2000, errorMessage: "same error" });
      }
      state = apply(state, { type: "auto_retry_end", attempt: 3, success: false, finalError: "same error" });
      state = apply(state, { type: "response", command: "prompt", success: false, error: "same rejection" });
      state = apply(state, { type: "response", command: "prompt", success: false, error: "same rejection" });
    }
    const { container } = render(<Transcript {...callbacks} blocks={state.blocks} queued={queued} />);
    for (const details of container.querySelectorAll("details")) details.open = true;
    expect(container.querySelectorAll('[data-uat="retry-card"]')).toHaveLength(2);
    for (const id of ["retry-card", "retry-attempt", "retry-history", "error-card", "pi-turn", "turn-user", "turn-queued", "queued-edit", "queued-cancel", "queued-retry", "cache-qualifier"]) {
      const elements = [...container.querySelectorAll(`[data-uat="${id}"]`)];
      const keys = elements.map((el) => el.getAttribute("data-uat-key"));
      expect(keys.every(Boolean), id).toBe(true);
      expect(new Set(keys).size, id).toBe(keys.length);
    }
    const result = snapshot();
    expect(result.lastError).toBeNull();
    expect(result.health).toBe("ok");
  });
});

it("names the refused host and opens settings or retries from the failure summary", () => {
  const retry = vi.fn();
  const view = render(<TurnCards turnKey="t" cards={[{ kind: "error", text: "Connection refused (os error 61)", at: 0 }]} endpoint="http://user:secret@localhost:8080/v1?key=secret" onRetry={retry} />);
  expect(view.container.textContent).toContain("localhost:8080: Connection refused");
  expect(view.container.textContent).not.toContain("secret");
  fireEvent.click(view.getByRole("button", { name: "Retry now" }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(view.getByRole("button", { name: "Open provider settings" }));
  expect(settingsInvoke).toHaveBeenCalledWith("open_settings_window", { tab: "pi" });
});
it("keeps the empty transcript area blank", () => {
  const view = render(<Transcript {...callbacks} blocks={[]} cwd="/proj" />);
  expect(view.container.querySelector('[data-uat="transcript"]')?.textContent).toBe("");
});
