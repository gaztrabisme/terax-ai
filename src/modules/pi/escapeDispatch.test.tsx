// @vitest-environment jsdom
// UX2-05 (G4): a keydown Escape dispatched on the focused chat composer
// element reaches the product's own handlers. While a turn is in flight it
// performs the Stop action; with the Sessions popover open it closes the
// popover. If these pass, the injected-key failures in the 2026-09-09 review
// sit at the operator's key-injection boundary, not in product code, and the
// code stays as written.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStateStore } from "@/modules/state/uiState";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  initialPiSessionState,
  type PiFeedItem,
  type PiSessionState,
} from "./lib/parse";
import { usePiStore } from "./lib/piStore";
import { useChildStore } from "./lib/childStore";
import {
  setLayoutStorageForTests,
  usePiLayoutStore,
} from "./lib/layoutStore";
import { PiTab } from "./PiTab";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/modules/settings/store", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/settings/store")
  >()),
  recordProjectOpen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./lib/rpc-client", () => ({
  watchTranscripts: () => Promise.resolve({ close: async () => {} }),
}));
vi.mock("./components/RunGraph", () => ({
  RunGraph: () => <div data-testid="run-graph" />,
}));
vi.mock("./components/Transcript", () => ({
  Transcript: ({ blocks }: { blocks: PiFeedItem[] }) => (
    <div data-uat="transcript">
      {blocks.map((block, i) =>
        block.kind === "message" ? (
          <p key={i}>
            {block.parts
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("")}
          </p>
        ) : null,
      )}
    </div>
  ),
}));

class ResizeObserverStub {
  static observers = new Map<Element, ResizeObserverCallback>();
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    ResizeObserverStub.observers.set(target, this.callback);
  }
  unobserve(target: Element) {
    ResizeObserverStub.observers.delete(target);
  }
  disconnect() {
    ResizeObserverStub.observers.clear();
  }
}

const kill = vi.fn().mockResolvedValue(undefined);
const abort = vi.fn().mockResolvedValue(undefined);
const send = vi.fn().mockResolvedValue(undefined);
const originalStore = usePiStore.getState();
const defaultShortcuts = usePreferencesStore.getState().shortcuts;

function message(text: string, streaming = false): PiFeedItem {
  return {
    kind: "message",
    id: "answer",
    role: "assistant",
    parts: [{ type: "text", text }],
    model: null,
    usage: null,
    streaming,
    at: 1,
  };
}

function seedTabs(ids: number[]) {
  for (const id of ids) {
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        [id]: {
          gen: 1,
          state: { ...initialPiSessionState(), sessionId: "current" },
          session: { id, send, kill, abort },
          exited: false,
          exitCode: null,
          error: null,
          roles: { provider: "", model: "", smol: "" },
        },
      },
    }));
  }
}

function setSession(id: number, patch: Partial<PiSessionState>) {
  act(() =>
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        [id]: { ...s.tabs[id], state: { ...s.tabs[id].state, ...patch } },
      },
    })),
  );
}

function mount() {
  return render(<PiTab tabId={1} cwd="/proj-1" active onOpenChild={() => {}} />);
}

function uat(id: string): HTMLElement | null {
  return document.querySelector(`[data-uat="${id}"]`);
}

/**
 * The driver path under test: a real keydown dispatched on the element the
 * operator focused, bubbling like a physical key. No fireEvent shortcuts on
 * the ancestor handlers.
 */
function dispatchEscape(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 1040, 800),
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  setLayoutStorageForTests(localStorage);
  usePiLayoutStore.setState({ layouts: {} });
  useUiStateStore.setState({ docs: {}, error: null, cleanAtLoad: {} });
  useChildStore.getState().reset();
  usePreferencesStore.setState({ shortcuts: defaultShortcuts });
  usePiStore.setState({
    ...originalStore,
    tabs: {},
    openSession: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  });
  seedTabs([1, 2]);
  kill.mockReset().mockResolvedValue(undefined);
  abort.mockReset().mockResolvedValue(undefined);
  send.mockReset().mockResolvedValue(undefined);
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "pi_paths")
      return { agent: { path: "/agent" }, runtimeAgentDir: { path: "/agent" } };
    if (cmd === "shell_run_command")
      return {
        exit_code: 0,
        stderr: "",
        stdout: JSON.stringify({ states: [], tickets: [], counts: {} }),
      };
    if (cmd === "pi_sessions_search")
      return [
        {
          path: "/sessions/date_current.jsonl",
          snippet: "matching prompt",
          startedAt: "2026-09-08",
          role: "user",
        },
      ];
    if (cmd === "pi_sessions_list")
      return [
        {
          path: "/sessions/date_current.jsonl",
          firstPrompt: "Recovered prompt",
          startedAt: "2026-09-08",
          turns: 1,
          tokens: 10,
        },
      ];
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ResizeObserverStub.observers.clear();
  usePiStore.setState({ ...originalStore, tabs: {} });
});

describe("Escape dispatched on the focused composer (UX2-05)", () => {
  it("performs the Stop action while a turn is in flight and keeps the view", async () => {
    setSession(1, {
      status: "thinking",
      blocks: [message("Partial answer stays", true)],
    });
    mount();
    const board = screen.getByRole("button", { name: "Board" });
    board.click();
    await waitFor(() => expect(uat("board-panel")).toBeTruthy());
    const composer = screen.getByLabelText("pi composer");
    composer.focus();
    expect(document.activeElement).toBe(composer);
    dispatchEscape(composer);
    await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(kill).not.toHaveBeenCalled();
    expect(uat("board-panel")).toBeTruthy();
    expect(usePiStore.getState().tabs[1].state.blocks[0]).toEqual(
      message("Partial answer stays", true),
    );
    // With nothing in flight the same dispatch reaches the K6 view handler
    // instead: the open Board panel closes, the composer Escape is a no-op.
    setSession(1, { status: "done" });
    composer.focus();
    dispatchEscape(composer);
    await waitFor(() => expect(uat("board-panel")).toBeNull());
    expect(abort).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("closes the Sessions popover", async () => {
    mount();
    screen.getByRole("button", { name: "Sessions" }).click();
    await waitFor(() => expect(uat("sessions-popover")).toBeTruthy());
    const composer = screen.getByLabelText("pi composer");
    composer.focus();
    dispatchEscape(composer);
    await waitFor(() => expect(uat("sessions-popover")).toBeNull());
    expect(abort).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
