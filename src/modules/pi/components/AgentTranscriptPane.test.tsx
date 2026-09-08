// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentTranscriptPane } from "@/modules/pi/components/AgentTranscriptPane";
import { usePiStore } from "@/modules/pi/lib/piStore";
import { useChildStore } from "@/modules/pi/lib/childStore";
import { ledgerPath, resetLedgerStore, useLedgerStore } from "@/modules/pi/lib/ledgerStore";
import { actionRecord, jsonLines, ledgerSnapshot } from "@/modules/pi/lib/__fixtures__/ledger";
import { initialPiSessionState } from "@/modules/pi/lib/parse";
import { CHILD_NAVIGATION_EVENT, findChildOwner, type ChildNavigation } from "@/modules/pi/lib/childNavigation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("@/modules/pi/components/Transcript", () => ({ Transcript: () => <div>Child transcript</div>, ErrorCard: ({ block }: { block: { text: string } }) => <div>{block.text}</div> }));

const file = actionRecord().evidencePath!;
const original = usePiStore.getState();
function NavigationHarness() {
  const [active, setActive] = useState("child");
  return <><Tabs value={active} onValueChange={setActive}><TabsList><TabsTrigger value="1" data-tab-id={1}>Owning pi</TabsTrigger><TabsTrigger value="child">Child</TabsTrigger></TabsList></Tabs><AgentTranscriptPane path={file} /></>;
}

beforeEach(() => {
  resetLedgerStore(); useChildStore.getState().reset(); vi.clearAllMocks();
  usePiStore.setState({ tabs: { 1: { gen: 1, cwd: "/project", state: { ...initialPiSessionState(), sessionId: "session-1" }, session: null, exited: false, exitCode: null, error: null, roles: { provider: "", model: "", smol: "" } } } });
  useLedgerStore.setState({ sessions: { [ledgerPath("/project", "session-1")]: ledgerSnapshot() } });
  vi.mocked(invoke).mockResolvedValue({ kind: "text", content: jsonLines({ type: "message_start", message: { role: "user", content: "Task" } }) });
});
afterEach(() => { cleanup(); resetLedgerStore(); useChildStore.getState().reset(); usePiStore.setState(original); });

describe("child navigation", () => {
  it("Return to chat activates the exact owning pi tab and requests its chat view", async () => {
    const events: ChildNavigation[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<ChildNavigation>).detail);
    window.addEventListener(CHILD_NAVIGATION_EVENT, listener);
    try {
      render(<NavigationHarness />);
      const button = screen.getByRole("button", { name: "Return to chat" });
      expect(button.getAttribute("data-uat")).toBe("child-return-chat");
      act(() => button.focus());
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByRole("tab", { name: "Owning pi" }).getAttribute("aria-selected")).toBe("true"));
      expect(events).toEqual([{ tabId: 1, ticketId: null }]);
    } finally { window.removeEventListener(CHILD_NAVIGATION_EVENT, listener); }
  });

  it("Open ticket uses the delegation for the agent and opens that ticket in its owner", async () => {
    const events: ChildNavigation[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<ChildNavigation>).detail);
    window.addEventListener(CHILD_NAVIGATION_EVENT, listener);
    try {
      render(<NavigationHarness />);
      const button = screen.getByRole("button", { name: "Open ticket" });
      expect(button.getAttribute("data-uat")).toBe("child-open-ticket");
      fireEvent.click(button);
      await waitFor(() => expect(events).toEqual([{ tabId: 1, ticketId: "ticket-1" }]));
    } finally { window.removeEventListener(CHILD_NAVIGATION_EVENT, listener); }
  });

  it("disables Open ticket with a title when the delegation has no ticketId", async () => {
    useLedgerStore.setState({ sessions: { [ledgerPath("/project", "session-1")]: ledgerSnapshot([actionRecord({ ticketId: null })]) } });
    render(<NavigationHarness />);
    expect(screen.getByRole("button", { name: "Open ticket" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Open ticket" }).title).toContain("no ticketId");
    expect(screen.getByRole("button", { name: "Return to chat" }).hasAttribute("disabled")).toBe(false);
    await waitFor(() => expect(useChildStore.getState().children[file]).toBeTruthy());
  });

  it("never borrows a ticket from another agent or another session", () => {
    const sessions = { [ledgerPath("/project", "session-1")]: ledgerSnapshot([actionRecord({ agentId: "scout-2", evidencePath: null })]) };
    expect(findChildOwner(file, usePiStore.getState().tabs, sessions)).toBeNull();
    expect(findChildOwner(file, usePiStore.getState().tabs, useLedgerStore.getState().sessions, ledgerPath("/project", "another-session"))).toBeNull();
  });
});
