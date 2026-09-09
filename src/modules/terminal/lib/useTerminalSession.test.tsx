// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { useTerminalSession, disposeSession } from "@/modules/terminal/lib/useTerminalSession";
import { getSlotForLeaf, forEachSlot } from "@/modules/terminal/lib/rendererPool";
import { openPty, type PtyHandlers } from "@/modules/terminal/lib/pty-bridge";
import type { BlockStore } from "@/modules/terminal/lib/blocks";
import type { JournalRecord } from "@/modules/terminal/lib/journal";

const prefs = vi.hoisted(() => ({
  terminalFontFamily: "monospace", terminalFontSize: 14, terminalLetterSpacing: 0,
  terminalScrollback: 10000, terminalWebglEnabled: false, zoomLevel: 1,
  backgroundKind: "solid", backgroundImageId: null,
}));
vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: async () => {}, detectMonoFontFamily: () => "monospace" }));
vi.mock("@/styles/terminalTheme", () => ({ buildTerminalTheme: () => ({}) }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: Object.assign((select: (state: typeof prefs) => unknown) => select(prefs), { getState: () => prefs }),
}));
vi.mock("@/modules/terminal/lib/pty-bridge", () => ({ openPty: vi.fn() }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));

const report = vi.fn<(store: BlockStore | null) => void>();
let handlers: PtyHandlers;
const record: JournalRecord = {
  v: 1, seq: 1, terminalId: "terminal-one", blockId: "block-one", event: "start",
  command: "echo saved", commandTruncated: false, cwd: "/project",
  startedAt: "2026-09-08T10:00:00.000Z", endedAt: null, durationMs: null, exit: "running",
  outputPath: ".pi/terminal/terminal-one/output/block-one.ansi", outputBytes: 0,
};
function Harness({ visible }: { visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  useTerminalSession({ leafId: 4, container, visible, initialCwd: "/project", onBlockStore: report });
  return <div ref={container} />;
}
const parsed = async () => {
  const term = getSlotForLeaf(4)?.term;
  if (term) await new Promise<void>((resolve) => term.write("", resolve));
};
const feed = async (text: string) => {
  await act(async () => { handlers.onData(new TextEncoder().encode(text)); await parsed(); });
};
const journal = (next: JournalRecord) => act(() => handlers.onJournal?.({ kind: "record", record: next }));
async function complete(start = record) {
  journal(start);
  await feed(`\x1b]133;A\x07prompt> ${start.command}\r\n\x1b]133;B\x07\x1b]133;C;${start.command}\x07saved\r\n`);
  journal({ ...start, seq: start.seq + 1, event: "finish", exit: 0, durationMs: 1000, endedAt: "2026-09-08T10:00:01.000Z", outputBytes: 7 });
  await feed("\x1b]133;D;0\x07\x1b]133;A\x07prompt> ");
}

beforeEach(() => {
  report.mockClear();
  // Keep the real parser, buffer, serializer and renderer pool, without a GPU or DOM renderer.
  vi.spyOn(Terminal.prototype, "open").mockImplementation(() => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  vi.mocked(openPty).mockImplementation(async (_cols, _rows, callbacks) => {
    handlers = callbacks;
    return {
      id: 1, terminalId: record.terminalId, project: "/project",
      write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    };
  });
});
afterEach(() => {
  cleanup();
  disposeSession(4);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => forEachSlot((slot) => slot.term.dispose()));

describe("block persistence through the renderer pool", () => {
  it("keeps normal-screen block markers through tab switches while an alternate screen is active", async () => {
    const view = render(<Harness visible />);
    await waitFor(() => expect(report).toHaveBeenCalled());
    await complete();
    const store = report.mock.calls[0][0]!;
    const block = store.getBlocks()[0];
    const line = block.marker!.line;
    await feed("\x1b[?1049hAlternate screen");
    for (let i = 0; i < 2; i++) {
      view.rerender(<Harness visible={false} />);
      view.rerender(<Harness visible />);
      await act(parsed);
      expect(getSlotForLeaf(4)?.term.buffer.active.type).toBe("alternate");
      expect(block.marker).toBeNull();
    }
    await feed("\x1b[?1049l");
    expect(block.marker?.line).toBe(line);
    expect(block.file?.record.blockId).toBe("block-one");
  });

  it("preserves completed blocks and their journal ids through repeated tab switches", async () => {
    const view = render(<Harness visible />);
    await waitFor(() => expect(report).toHaveBeenCalled());
    await complete();
    const store = report.mock.calls[0][0]!;
    const block = store.getBlocks()[0];
    const line = block.marker!.line;
    expect(block.file?.record.blockId).toBe("block-one");
    expect(block.status).toBe("ok");
    for (let i = 0; i < 2; i++) {
      view.rerender(<Harness visible={false} />);
      expect(getSlotForLeaf(4)).toBeNull();
      expect(block.marker).toBeNull();
      view.rerender(<Harness visible />);
      await act(parsed);
      expect(report.mock.calls[report.mock.calls.length - 1][0]).toBe(store);
      expect(store.getBlocks()).toHaveLength(1);
      expect(store.getBlocks()[0]).toBe(block);
      expect(block.marker?.line).toBe(line);
      expect(block.marker?.isDisposed).toBe(false);
      expect(block.file?.record.blockId).toBe("block-one");
    }
  });

  it("restores markers before replaying dormant commands and binds repeated commands to distinct journal ids", async () => {
    const view = render(<Harness visible />);
    await waitFor(() => expect(report).toHaveBeenCalled());
    await complete();
    const store = report.mock.calls[0][0]!;
    view.rerender(<Harness visible={false} />);
    await complete({ ...record, seq: 3, blockId: "block-two", outputPath: ".pi/terminal/terminal-one/output/block-two.ansi" });
    expect(store.getBlocks()).toHaveLength(1);
    view.rerender(<Harness visible />);
    await act(parsed);
    const blocks = store.getBlocks();
    expect(blocks.map((block) => block.file?.record.blockId)).toEqual(["block-one", "block-two"]);
    expect(blocks.map((block) => block.status)).toEqual(["ok", "ok"]);
    expect(blocks[0].marker!.line).toBeLessThan(blocks[1].marker!.line);
  });
});
