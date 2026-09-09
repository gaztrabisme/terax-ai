// @vitest-environment jsdom
import type { IMarker } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockStore } from "../lib/blocks";
import {
  buildQuotation,
  SEND_TO_CHAT_MAX_LINES,
  sha256Hex,
  BlockChrome,
  BlockChromeRow,
} from "./BlockChrome";
import { SEND_TO_CHAT_EVENT, type SendToChatDetail } from "@/modules/pi/lib/sendToChat";
import { getSlotForLeaf, type Slot } from "@/modules/terminal/lib/rendererPool";
import { collectSnapshot } from "@/modules/uat/snapshot";
import type { Context, Geometry, Session } from "@/modules/uat/types";
import { readBlockOutput, type JournalRecord } from "@/modules/terminal/lib/journal";

vi.mock("@/modules/terminal/lib/rendererPool", () => ({ getSlotForLeaf: vi.fn() }));
vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({ writeToSession: vi.fn() }));
vi.mock("@/modules/terminal/lib/journal", async (original) => ({
  ...(await original<typeof import("@/modules/terminal/lib/journal")>()),
  readBlockOutput: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

let markerSeq = 0;

function fakeMarker(line = 4): IMarker {
  const marker = {
    id: markerSeq++,
    line,
    isDisposed: false,
    dispose: () => {
      marker.isDisposed = true;
      marker.line = -1;
    },
  };
  return marker as unknown as IMarker;
}

function completedBlock(command: string | null) {
  let now = 1000;
  const store = new BlockStore({ now: () => now, createMarker: fakeMarker });
  now += 5;
  store.onCommandStart(command);
  now += 15;
  store.onCommandDone(0);
  return { store, block: store.getBlocks()[0] };
}

const record: JournalRecord = {
  v: 1, seq: 2, terminalId: "terminal-saved", blockId: "block-saved", event: "finish",
  command: "echo private-argument", commandTruncated: false, cwd: "/project",
  startedAt: "2026-09-08T10:00:00.000Z", endedAt: "2026-09-08T10:00:01.000Z",
  durationMs: 1000, exit: 0, outputPath: ".pi/terminal/terminal-saved/output/block-saved.ansi", outputBytes: 0,
};
const context: Context = { cwd: "/project", tabs: [{ uat: "tab-active", key: "3", kind: "terminal", title: "Shell", active: true }] };
const session: Session = { cwd: "/project", runId: "run", windowId: "main", seq: 0, layoutSeq: 1 };
const geometry: Geometry = {
  generation: 1,
  window: {
    x: 0, y: 0, w: 800, h: 600, scale: 1, cssToPoint: 1, driverUnits: "macos-points",
    driverOrigin: { x: 0, y: 0 }, contentOffset: { x: 0, y: 0 }, displayId: "main",
    displayPhysicalOrigin: { x: 0, y: 0 }, displayDriverOrigin: { x: 0, y: 0 }, coordinateStatus: "supported",
  },
};
const snapshot = () => collectSnapshot(document, window, context, session, geometry, 1, null);

function fakeSlot() {
  const element = document.createElement("div");
  element.innerHTML = '<div class="xterm-screen"></div>';
  const events = new Map<string, () => void>();
  const on = (name: string) => (listener: () => void) => {
    events.set(name, listener);
    return { dispose: () => events.delete(name) };
  };
  const anchors: HTMLElement[] = [];
  const term = {
    element, rows: 24, buffer: { active: { type: "normal", viewportY: 0 } },
    onScroll: on("scroll"), onResize: on("resize"), onRender: on("render"),
    scrollToLine: vi.fn(),
    registerDecoration: vi.fn(() => {
      const anchor = document.createElement("div");
      anchor.style.height = "20px";
      anchors.push(anchor);
      return { element: anchor, onRender: on("decoration"), dispose: vi.fn() };
    }),
  };
  vi.mocked(getSlotForLeaf).mockReturnValue({ term } as unknown as Slot);
  return { term, events, anchors };
}

describe("persistent block overlay", () => {
  it("exposes blocks, status, action ids and a focusable menu to the snapshot without hover, keeping terminal text private", () => {
    fakeSlot();
    const { store, block } = completedBlock(record.command);
    store.applyJournal(block, record, "/project");
    const view = render(<div data-uat="terminal-tab" data-uat-key="3">
      <BlockChrome leafId={3} store={store} />
      <div data-uat="terminal-emulator">private-scrollback <button data-uat="should-stay-private" /></div>
    </div>);
    const menu = screen.getByRole("button", { name: "Block actions" });
    expect(menu.tabIndex).toBe(0);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    act(() => menu.focus());
    expect(document.activeElement).toBe(menu);
    const snap = snapshot();
    expect(snap.dupes).toEqual([]);
    expect(snap.elements.map((el) => el.uat)).toEqual(expect.arrayContaining([
      "terminal-block", "exit-dot-ok", "block-actions", "block-copy", "block-copy-ansi", "block-rerun", "block-send-to-chat",
    ]));
    expect(JSON.stringify(snap)).not.toContain("private-scrollback");
    expect(JSON.stringify(snap)).not.toContain("private-argument");
    expect(snap.elements.some((el) => el.uat === "should-stay-private")).toBe(false);
    expect(view.container.querySelector('[data-uat="terminal-emulator"]')?.querySelector('[data-uat="terminal-block"]')).toBeNull();
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const rerun = screen.getByRole("button", { name: "Rerun" });
    expect(rerun.tabIndex).toBe(0);
    act(() => rerun.focus());
    fireEvent.keyDown(rerun, { key: "Escape" });
    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(rerun.tabIndex).toBe(-1);
  });

  it("shares durable block and action identities between the live overlay and recovered chrome", () => {
    fakeSlot();
    const { store, block } = completedBlock(record.command);
    store.applyJournal(block, record, "/project");
    const view = render(<div data-uat="terminal-tab" data-uat-key="3"><BlockChrome leafId={3} store={store} /></div>);
    const identities = () => snapshot().elements.filter((el) => el.uat !== "terminal-tab").map(({ uat, key, scope }) => ({ uat, key, scope }));
    const live = identities();
    view.rerender(<div data-uat="terminal-tab" data-uat-key="3"><BlockChromeRow leafId={3} block={{ ...block, id: record.seq, marker: null }} recovered /></div>);
    expect(identities()).toEqual(live);
  });

  it("keeps DOM rows on tab switches and attaches geometry when the pooled slot returns after the render", () => {
    fakeSlot();
    const { store, block } = completedBlock("saved");
    store.applyJournal(block, record, "/project");
    const view = render(<BlockChrome leafId={3} store={store} />);
    const row = view.container.querySelector('[data-uat="terminal-block"]');
    act(() => store.detachMarkers(0));
    vi.mocked(getSlotForLeaf).mockReturnValue(null);
    view.rerender(<BlockChrome leafId={3} store={store} visible={false} />);
    view.rerender(<BlockChrome leafId={3} store={store} visible />);
    const next = fakeSlot();
    act(() => store.restoreMarkers(fakeMarker));
    expect(view.container.querySelector('[data-uat="terminal-block"]')).toBe(row);
    expect(next.term.registerDecoration).toHaveBeenCalledTimes(1);
    expect(row?.getAttribute("data-uat-key")).toBe("block-saved");
    expect(screen.getByRole("button", { name: "Block actions" })).toBeTruthy();
  });

  it("updates absolute overlay positions from decoration height on scroll and resize", async () => {
    const { term, events, anchors } = fakeSlot();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const isScreen = this.classList.contains("xterm-screen");
      return { x: isScreen ? 8 : 0, y: isScreen ? 12 : 0, left: isScreen ? 8 : 0, top: isScreen ? 12 : 0, width: 600, height: 480, right: 600, bottom: 480, toJSON: () => ({}) };
    });
    const { store } = completedBlock("saved");
    const view = render(<BlockChrome leafId={3} store={store} />);
    const row = view.container.querySelector<HTMLElement>('[data-uat="terminal-block"]')!;
    expect(row.style.top).toBe("92px");
    expect(row.style.left).toBe("8px");
    expect(row.style.width).toBe("600px");
    term.buffer.active.viewportY = 2;
    await act(async () => {
      events.get("scroll")?.();
      await new Promise(requestAnimationFrame);
    });
    expect(row.style.top).toBe("52px");
    anchors[0].style.height = "30px";
    await act(async () => {
      events.get("resize")?.();
      await new Promise(requestAnimationFrame);
    });
    expect(row.style.top).toBe("72px");
    expect(row.style.height).toBe("30px");
    view.unmount();
    expect(events.has("scroll")).toBe(false);
  });
});

describe("buildQuotation", () => {
  it("fences the command line, a blank line and the output, then names the block", () => {
    expect(buildQuotation("ls -la", "file1\nfile2", 12)).toBe(
      "```\nls -la\n\nfile1\nfile2\n```\nFrom terminal block 12",
    );
  });

  it("keeps an empty command line when the block has no command text", () => {
    expect(buildQuotation(null, "done", 7)).toBe(
      "```\n\n\ndone\n```\nFrom terminal block 7",
    );
  });

  it("leaves output up to the cap untruncated", () => {
    const output = Array.from(
      { length: SEND_TO_CHAT_MAX_LINES },
      (_, i) => `line ${i}`,
    ).join("\n");
    const text = buildQuotation("seq", output, 1);
    expect(text).not.toContain("output truncated");
    expect(text).toContain(`line ${SEND_TO_CHAT_MAX_LINES - 1}`);
  });

  it("caps longer output with a trailing line count", () => {
    const total = SEND_TO_CHAT_MAX_LINES + 5;
    const output = Array.from({ length: total }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const text = buildQuotation("seq", output, 2);
    expect(text).toContain("line 0\n");
    expect(text).toContain(`(output truncated, ${total} lines)`);
    expect(text).not.toContain(`line ${SEND_TO_CHAT_MAX_LINES}\n`);
    expect(text).not.toContain(`line ${total - 1}`);
  });
});

describe("sha256Hex", () => {
  it("matches the SHA-256 test vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("block actions", () => {
  it("labels itself for pointer and assistive tech and scopes the uat key", () => {
    const { block } = completedBlock("ls");
    render(<BlockChromeRow leafId={3} block={block} />);
    const btn = screen.getByRole("button", { name: "Send to chat" });
    expect(btn.textContent).toBe("Send to chat");
    expect(btn.getAttribute("aria-label")).toBe("Send to chat");
    expect(btn.getAttribute("data-uat")).toBe("block-send-to-chat");
    expect(btn.getAttribute("data-uat-key")).toBe(String(block.id));
  });

  it("dispatches the quotation and source hash for the block", async () => {
    const { block } = completedBlock("ls -la");
    const raw = "file1\nfile2";
    block.file = { project: "/project", record };
    vi.mocked(readBlockOutput).mockResolvedValue(raw);
    render(<BlockChromeRow leafId={3} block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Block actions" }));
    const btn = screen.getByRole("button", { name: "Send to chat" });
    const seen = new Promise<SendToChatDetail>((resolve) => {
      const listener = (e: Event) =>
        resolve((e as CustomEvent<SendToChatDetail>).detail);
      window.addEventListener(SEND_TO_CHAT_EVENT, listener, { once: true });
    });
    fireEvent.click(btn);
    const detail = await seen;
    expect(detail.text).toBe(buildQuotation("ls -la", raw, block.id));
    expect(detail.source).toEqual({
      blockId: block.id,
      terminalId: 3,
      sha256: await sha256Hex(raw),
    });
  });

  it("does not transfer a block without a saved output file", async () => {
    const { block } = completedBlock("ls");
    const marker = block.marker as IMarker;
    marker.dispose();
    render(<BlockChromeRow leafId={3} block={block} />);
    const btn = screen.getByRole("button", { name: "Send to chat" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const listener = vi.fn();
    window.addEventListener(SEND_TO_CHAT_EVENT, listener);
    fireEvent.click(btn);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SEND_TO_CHAT_EVENT, listener);
  });

  it("copies ANSI from the saved output file without stripping its attributes", async () => {
    const { store, block } = completedBlock(record.command);
    store.applyJournal(block, record, "/project");
    const ansi = "\x1b[31mred\x1b[0m\r\n";
    vi.mocked(readBlockOutput).mockResolvedValue(ansi);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<BlockChromeRow leafId={3} block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Block actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy ANSI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ansi));
    expect(readBlockOutput).toHaveBeenLastCalledWith({ project: "/project", record });
  });
});
