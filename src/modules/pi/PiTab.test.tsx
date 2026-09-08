// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/modules/tabs";
import { MOD_PROP } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  initialPiSessionState,
  type PiFeedItem,
  type PiSessionState,
} from "./lib/parse";
import { usePiStore } from "./lib/piStore";
import { useChildStore } from "./lib/childStore";
import {
  loadLayouts,
  PI_LAYOUT_STORAGE_KEY,
  setLayoutStorageForTests,
  usePiLayoutStore,
} from "./lib/layoutStore";
import { PiStack, PiTab } from "./PiTab";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
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
vi.mock("./components/Transcript", async () => {
  const { KeystoneCard } = await import("./components/blocks/KeystoneCard");
  return {
    formatCost: (n: number) => String(n),
    Transcript: ({
      blocks,
      onDismiss,
    }: {
      blocks: PiFeedItem[];
      onDismiss: (id: string) => void;
    }) => (
      <div data-uat="transcript">
        {blocks.map((block, i) =>
          block.kind === "ask" ? (
            <KeystoneCard
              key={i}
              block={block}
              onAnswer={() => {}}
              onDismiss={() => onDismiss(block.requestId)}
            />
          ) : block.kind === "message" ? (
            <p key={i}>
              {block.parts
                .map((p) => (p.type === "text" ? p.text : ""))
                .join("")}
            </p>
          ) : null,
        )}
      </div>
    ),
  };
});

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
    for (const [target, callback] of ResizeObserverStub.observers) {
      if (callback === this.callback)
        ResizeObserverStub.observers.delete(target);
    }
  }
}

const kill = vi.fn().mockResolvedValue(undefined);
const send = vi.fn().mockResolvedValue(undefined);
const originalStore = usePiStore.getState();
const defaultShortcuts = usePreferencesStore.getState().shortcuts;
let boardTickets: { id: string; status: string; title?: string }[];
let draftPromise: Promise<{ kind: string; content: string }> | null;

function seedTabs(ids: number[]) {
  for (const id of ids) {
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        [id]: {
          gen: 1,
          state: { ...initialPiSessionState(), sessionId: "current" },
          session: { id, send, kill },
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
function tabs(): Tab[] {
  return [1, 2].map((id) => ({
    id,
    kind: "pi",
    title: "pi",
    cwd: `/proj-${id}`,
  }));
}
function mount() {
  return render(
    <PiTab tabId={1} cwd="/proj-1" active onOpenChild={() => {}} />,
  );
}
function uat(id: string, scope: ParentNode = document): HTMLElement | null {
  return scope.querySelector(`[data-uat="${id}"]`);
}
function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}
function escape(target: HTMLElement = document.activeElement as HTMLElement) {
  return fireEvent.keyDown(target, { key: "Escape" });
}
function resize(width: number) {
  const root = uat("pi-tab")!;
  act(() =>
    ResizeObserverStub.observers.get(root)?.(
      [
        {
          target: root,
          contentRect: new DOMRect(0, 0, width, 800),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    ),
  );
}
function shortcut(
  key: string,
  shiftKey = false,
  target: Element | Window = window,
) {
  return fireEvent.keyDown(target, {
    key,
    shiftKey,
    [MOD_PROP === "meta" ? "metaKey" : "ctrlKey"]: true,
  });
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
  send.mockReset().mockResolvedValue(undefined);
  boardTickets = [];
  draftPromise = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "pi_paths")
      return { agent: { path: "/agent" }, runtimeAgentDir: { path: "/agent" } };
    if (cmd === "shell_run_command")
      return {
        exit_code: 0,
        stderr: "",
        stdout: JSON.stringify({
          states: ["align", "verify", "review", "land", "done"],
          tickets: boardTickets,
          counts: {},
        }),
      };
    if (cmd === "fs_read_file")
      return draftPromise ?? { kind: "text", content: "" };
    if (cmd === "pi_prompts_list")
      return [
        {
          name: "review",
          description: "Review the diff",
          path: "/prompts/review.md",
          source: "agent",
        },
      ];
    if (cmd === "pi_sessions_list")
      return [
        {
          path: "/sessions/date_other.jsonl",
          firstPrompt: "Recovered prompt",
          startedAt: "2026-09-08",
          turns: 1,
          tokens: 10,
        },
      ];
    if (cmd === "pi_sessions_search")
      return [
        {
          path: "/sessions/date_current.jsonl",
          snippet: "matching prompt",
          startedAt: "2026-09-08",
          role: "user",
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

describe("PiTab mode strip", () => {
  it("starts with a quiet 40px toolbar, in order, and no view bodies", () => {
    mount();
    const strip = screen.getByRole("toolbar", { name: "Chat views" });
    expect(strip.style.width).toBe("40px");
    for (const button of within(strip).getAllByRole("button")) {
      expect(button.title).toBe(button.getAttribute("aria-label"));
    }
    expect(
      within(strip)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Board", "Graph", "Sessions"]);
    expect(
      within(strip)
        .getAllByRole("button")
        .every((b) => b.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
    expect(document.querySelectorAll("section[data-mode]")).toHaveLength(0);
    expect(uat("transcript")).toBeTruthy();
    expect(uat("sessions-search")).toBeNull();
    expect(screen.queryByTestId("run-graph")).toBeNull();
  });

  it("opens one view at a time and closes an own-button toggle to that button", () => {
    mount();
    click("Board");
    expect(uat("board-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Board" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    click("Sessions");
    expect(uat("board-panel")).toBeNull();
    expect(uat("sessions-popover")?.style.width).toBe("360px");
    expect(document.activeElement).toBe(uat("sessions-search"));
    click("Graph");
    expect(uat("sessions-popover")).toBeNull();
    expect(uat("graph-panel")).toBeTruthy();
    click("Graph");
    expect(document.querySelectorAll("section[data-mode]")).toHaveLength(0);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Graph" }),
    );
  });

  it.each([
    "Board",
    "Graph",
    "Artifact",
  ])("traverses %s panel, fullscreen, Back, Escape", (name) => {
    setSession(1, { blocks: [message("```html\n<h1>Artifact</h1>\n```")] });
    mount();
    const id = name.toLowerCase();
    click(name);
    click(`Full screen ${name}`);
    expect(uat(`${id}-fullscreen`)).toBeTruthy();
    expect(
      document.querySelector("[data-pi-chat]")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(uat("mode-strip")).toBeTruthy();
    click("Back");
    expect(uat(`${id}-panel`)).toBeTruthy();
    escape();
    expect(uat(`${id}-panel`)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name }));
  });

  it("preserves the Sessions query and search focus across all its modes and closure", () => {
    mount();
    click("Sessions");
    fireEvent.change(uat("sessions-search")!, {
      target: { value: "saved query" },
    });
    expect(loadLayouts()["/proj-1"].sessionsQuery).toBe("saved query");
    click("Expand Sessions");
    expect(uat("sessions-panel")).toBeTruthy();
    expect(document.activeElement).toBe(uat("sessions-search"));
    click("Full screen Sessions");
    expect(uat("sessions-fullscreen")).toBeTruthy();
    escape();
    expect(uat("sessions-panel")).toBeTruthy();
    expect(document.activeElement).toBe(uat("sessions-search"));
    escape();
    expect(uat("sessions-panel")).toBeNull();
    click("Sessions");
    expect((uat("sessions-search") as HTMLInputElement).value).toBe(
      "saved query",
    );
    click("Full screen Sessions");
    escape();
    expect(uat("sessions-popover")).toBeTruthy();
    fireEvent.pointerDown(uat("transcript")!);
    expect(uat("sessions-popover")).toBeNull();
    expect(loadLayouts()["/proj-1"].sessionsQuery).toBe("saved query");
  });

  it("closes a popover on successful hit activation, then scrolls to the recovered turn", async () => {
    mount();
    click("Sessions");
    fireEvent.click(await screen.findByText("Recovered prompt"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "switch_session",
          sessionPath: "/sessions/date_other.jsonl",
        }),
      ),
    );
    expect(uat("sessions-popover")).toBeTruthy();
    setSession(1, {
      sessionId: "other",
      blocks: [message("Recovered prompt")],
    });
    expect(uat("sessions-popover")).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
    });
  });

  it("keeps the popover and query when switching a hit fails", async () => {
    send.mockRejectedValueOnce(new Error("Cannot recover session"));
    mount();
    click("Sessions");
    fireEvent.click(await screen.findByText("Recovered prompt"));
    expect(await screen.findByText("Cannot recover session")).toBeTruthy();
    expect(uat("sessions-popover")).toBeTruthy();
  });

  it("shows board and child badge updates and artifact availability without opening", async () => {
    boardTickets = [
      "align",
      "verify",
      "review",
      "land",
      "in_progress",
      "done",
    ].map((status, i) => ({ id: `t${i}`, status }));
    mount();
    await waitFor(() =>
      expect(
        screen.getByLabelText("4 tickets awaiting a human decision"),
      ).toBeTruthy(),
    );
    act(() =>
      useChildStore.setState({
        children: {
          "/proj-1/running.transcript.jsonl": {
            ...initialPiSessionState(),
            status: "thinking",
          },
          "/proj-1/finished.transcript.jsonl": {
            ...initialPiSessionState(),
            status: "done",
          },
          "/proj-1/idle.transcript.jsonl": initialPiSessionState(),
        },
      }),
    );
    expect(screen.getByLabelText("1 running children")).toBeTruthy();
    setSession(1, { blocks: [message("```html\n<p>new artifact</p>\n```")] });
    expect(uat("artifact-button")).toBeTruthy();
    expect(document.querySelectorAll("section[data-mode]")).toHaveLength(0);
    const polls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "shell_run_command",
    ).length;
    click("Board");
    await act(async () => {});
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "shell_run_command"),
    ).toHaveLength(polls);
  });

  it("keeps Open in tab actions in panel headers", () => {
    const onOpenBoard = vi.fn();
    const onOpenRunGraph = vi.fn();
    render(
      <PiTab
        tabId={1}
        cwd="/proj-1"
        active
        onOpenChild={() => {}}
        onOpenBoard={onOpenBoard}
        onOpenRunGraph={onOpenRunGraph}
      />,
    );
    click("Board");
    click("Open Board in tab");
    expect(onOpenBoard).toHaveBeenCalledWith("/proj-1");
    click("Graph");
    click("Open Graph in tab");
    expect(onOpenRunGraph).toHaveBeenCalledWith("/proj-1", 1);
  });
});

describe("dimensions and tab lifetime", () => {
  it("opens each project's own remembered width after starting closed", () => {
    usePiLayoutStore
      .getState()
      .update("/proj-1", { views: { board: { widthCss: 360 } } });
    usePiLayoutStore
      .getState()
      .update("/proj-2", { views: { board: { widthCss: 420 } } });
    const { rerender } = render(
      <PiStack tabs={tabs()} activeId={1} onOpenChild={() => {}} />,
    );
    expect(document.querySelectorAll("section[data-mode]")).toHaveLength(0);
    click("Board");
    expect(uat("board-panel")?.style.width).toBe("360px");
    rerender(<PiStack tabs={tabs()} activeId={2} onOpenChild={() => {}} />);
    click("Board");
    const active = document.querySelector(
      '[data-uat="pi-tab"][aria-hidden="false"]',
    )!;
    expect(uat("board-panel", active)?.style.width).toBe("420px");
  });

  it("hides a ticket sheet with its inactive tab and restores its selection on return", async () => {
    boardTickets = [{ id: "ticket-1", status: "align", title: "Decision" }];
    const { rerender } = render(
      <PiStack tabs={tabs()} activeId={1} onOpenChild={() => {}} />,
    );
    click("Board");
    fireEvent.click(await screen.findByText("Decision"));
    await waitFor(() => expect(uat("ticket-sheet")).toBeTruthy());
    rerender(<PiStack tabs={tabs()} activeId={2} onOpenChild={() => {}} />);
    await waitFor(() => expect(uat("ticket-sheet")).toBeNull());
    rerender(<PiStack tabs={tabs()} activeId={1} onOpenChild={() => {}} />);
    await waitFor(() =>
      expect(uat("ticket-sheet")?.getAttribute("data-uat-key")).toBe(
        "ticket-1",
      ),
    );
  });

  it("commits separator drags and 16px keys per view and cwd without persisting visibility", () => {
    const { unmount } = mount();
    click("Board");
    let handle = screen.getByRole("separator", { name: "Resize Board panel" });
    expect(uat("board-panel")?.style.width).toBe("300px");
    fireEvent.pointerDown(handle, { button: 0, clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 640, pointerId: 1 });
    expect(uat("board-panel")?.style.width).toBe("360px");
    expect(loadLayouts()["/proj-1"]).toBeUndefined();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(loadLayouts()["/proj-1"].views.board.widthCss).toBe(360);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(uat("board-panel")?.style.width).toBe("376px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    click("Graph");
    handle = screen.getByRole("separator", { name: "Resize Graph panel" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(loadLayouts()["/proj-1"].views.graph.widthCss).toBe(316);
    act(() =>
      usePiLayoutStore
        .getState()
        .update("/proj-2", { views: { board: { widthCss: 420 } } }),
    );
    click("Board");
    click("Full screen Board");
    unmount();
    usePiLayoutStore.setState({ layouts: loadLayouts() });
    mount();
    expect(document.querySelectorAll("section[data-mode]")).toHaveLength(0);
    click("Board");
    expect(uat("board-panel")?.style.width).toBe("360px");
    expect(loadLayouts()["/proj-2"].views.board.widthCss).toBe(420);
    expect(
      JSON.parse(localStorage.getItem(PI_LAYOUT_STORAGE_KEY)!)["/proj-1"],
    ).not.toHaveProperty("view");
  });

  it("clamps without overwriting width and collapses/restores only automatically", () => {
    usePiLayoutStore
      .getState()
      .update("/proj-1", { views: { board: { widthCss: 500 } } });
    mount();
    click("Board");
    resize(640);
    expect(uat("board-panel")?.style.width).toBe("280px");
    expect(loadLayouts()["/proj-1"].views.board.widthCss).toBe(500);
    resize(599);
    expect(uat("board-panel")).toBeNull();
    expect(document.activeElement).toBe(uat("board-button"));
    resize(1040);
    expect(uat("board-panel")?.style.width).toBe("500px");
    resize(599);
    escape();
    resize(1040);
    expect(uat("board-panel")).toBeNull();
    expect(loadLayouts()["/proj-1"].views.board.widthCss).toBe(500);
  });

  it.each([
    "Board",
    "Graph",
    "Sessions",
    "Artifact",
  ])("opens %s fullscreen in a narrow window and Back closes", (name) => {
    setSession(1, { blocks: [message("```html\n<p>artifact</p>\n```")] });
    mount();
    resize(599);
    click(name);
    expect(uat(`${name.toLowerCase()}-fullscreen`)).toBeTruthy();
    resize(1040);
    expect(uat(`${name.toLowerCase()}-fullscreen`)).toBeTruthy();
    click("Back");
    expect(document.querySelectorAll("section[data-mode]")).toHaveLength(0);
  });

  it("keeps each tab's view and focus while only mounting the active graph", () => {
    const { rerender } = render(
      <PiStack tabs={tabs()} activeId={1} onOpenChild={() => {}} />,
    );
    click("Graph");
    const first = uat("pi-tab")!;
    const closeGraph = within(first).getByRole("button", {
      name: "Close Graph",
    });
    closeGraph.focus();
    rerender(<PiStack tabs={tabs()} activeId={2} onOpenChild={() => {}} />);
    expect(first.hasAttribute("inert")).toBe(true);
    expect(screen.queryByTestId("run-graph")).toBeNull();
    click("Sessions");
    const search = screen.getByLabelText("Search pi sessions");
    fireEvent.change(search, { target: { value: "tab two" } });
    rerender(<PiStack tabs={tabs()} activeId={1} onOpenChild={() => {}} />);
    expect(screen.getAllByTestId("run-graph")).toHaveLength(1);
    expect(document.activeElement).toBe(closeGraph);
    expect(uat("graph-panel", first)).toBeTruthy();
    rerender(<PiStack tabs={tabs()} activeId={2} onOpenChild={() => {}} />);
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).value).toBe("tab two");
    expect(screen.queryByTestId("run-graph")).toBeNull();
  });
});

describe("focused-control priority and active-tab shortcuts", () => {
  it("uses all four shortcuts only on the active tab and refocuses an already-open Sessions search", () => {
    setSession(1, { blocks: [message("```html\n<p>artifact</p>\n```")] });
    render(<PiStack tabs={tabs()} activeId={1} onOpenChild={() => {}} />);
    shortcut("b", true);
    expect(uat("board-panel")).toBeTruthy();
    shortcut("g", true);
    expect(uat("graph-panel")).toBeTruthy();
    shortcut("a", true);
    expect(uat("artifact-panel")).toBeTruthy();
    shortcut("j");
    expect(document.activeElement).toBe(uat("sessions-search"));
    click("Expand Sessions");
    shortcut("j");
    expect(uat("sessions-popover")).toBeTruthy();
    expect(document.activeElement).toBe(uat("sessions-search"));
    const hidden = document.querySelector(
      '[data-uat="pi-tab"][aria-hidden="true"]',
    )!;
    expect(hidden.querySelector("section[data-mode]")).toBeNull();
  });

  it("does not consume Artifact when unavailable or shell Tab, Enter, Escape and view shortcuts", () => {
    mount();
    expect(shortcut("a", true)).toBe(true);
    click("Board");
    const terminal = document.createElement("textarea");
    terminal.dataset.uat = "terminal-composer";
    uat("pi-tab")!.append(terminal);
    terminal.focus();
    const shell = vi.fn();
    terminal.addEventListener("keydown", shell);
    for (const key of ["Tab", "Enter", "Escape"])
      expect(fireEvent.keyDown(terminal, { key })).toBe(true);
    expect(shortcut("g", true, terminal)).toBe(true);
    expect(shell).toHaveBeenCalledTimes(4);
    expect(uat("board-panel")).toBeTruthy();
    expect(uat("graph-panel")).toBeNull();
  });

  it("lets a focused modal or editor consume Escape before the view", () => {
    mount();
    click("Board");
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    const input = document.createElement("input");
    modal.append(input);
    uat("pi-tab")!.append(modal);
    input.focus();
    escape(input);
    shortcut("g", true, input);
    expect(uat("board-panel")).toBeTruthy();
    expect(uat("graph-panel")).toBeNull();
    modal.remove();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    uat("pi-tab")!.append(editor);
    editor.focus();
    editor.addEventListener("keydown", (event) => event.preventDefault());
    escape(editor);
    expect(uat("board-panel")).toBeTruthy();
  });

  it("requires two Escapes on a focused keystone without closing the panel or stopping", () => {
    setSession(1, {
      status: "awaiting-ask",
      blocks: [
        {
          kind: "ask",
          requestId: "req",
          state: "pending",
          timeoutMs: 1000,
          at: 1,
          questions: [
            {
              question: "Proceed?",
              multi: false,
              recommended: 0,
              options: [{ label: "Yes" }],
            },
          ],
        },
      ],
    });
    mount();
    click("Board");
    const option = screen.getByRole("button", { name: "Yes" });
    option.focus();
    escape();
    expect(screen.getByRole("status").textContent).toContain(
      "Press Escape again",
    );
    expect(send).not.toHaveBeenCalled();
    escape();
    expect(send).toHaveBeenCalledTimes(1);
    expect(uat("board-panel")).toBeTruthy();
    expect(kill).not.toHaveBeenCalled();
  });

  it("Escape during a turn in the composer performs Stop and retains the partial answer and open view", () => {
    const partial = message("Partial answer stays", true);
    setSession(1, { status: "thinking", blocks: [partial] });
    mount();
    click("Board");
    const composer = screen.getByLabelText("pi composer");
    composer.focus();
    escape();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(uat("board-panel")).toBeTruthy();
    expect(screen.getByText("Partial answer stays")).toBeTruthy();
    expect(usePiStore.getState().tabs[1].state.blocks).toEqual([partial]);
    fireEvent.click(uat("stop-button")!);
    expect(kill).toHaveBeenCalledTimes(2);
    setSession(1, { status: "done" });
    composer.focus();
    escape();
    expect(uat("board-panel")).toBeNull();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("prompt-menu Escape dismisses only the menu before Stop or view Escape", async () => {
    let release!: (value: { kind: string; content: string }) => void;
    draftPromise = new Promise((resolve) => {
      release = resolve;
    });
    setSession(1, { status: "thinking" });
    mount();
    click("Board");
    const composer = screen.getByLabelText("pi composer");
    composer.focus();
    await act(async () => release({ kind: "text", content: "/rev" }));
    await screen.findByText("/review");
    escape();
    expect(uat("prompt-menu")).toBeNull();
    expect(uat("board-panel")).toBeTruthy();
    expect(kill).not.toHaveBeenCalled();
    expect(composer.textContent).toBe("/rev");
  });
});
