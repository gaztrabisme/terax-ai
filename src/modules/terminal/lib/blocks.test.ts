import { describe, expect, it, vi } from "vitest";
import type { IMarker } from "@xterm/xterm";
import {
  BlockStore,
  blockDurationMs,
  extractBlockText,
  formatDuration,
  liveMarker,
  nextBlockStartLine,
  reconcileBlockDecorations,
  type Block,
  type BlockDecorationEntry,
  type DecorationLike,
} from "./blocks";

let markerSeq = 0;

function fakeMarker(line = 10): IMarker {
  const marker = {
    id: markerSeq++,
    line,
    isDisposed: false,
    dispose: vi.fn(() => {
      marker.isDisposed = true;
      marker.line = -1;
    }),
  };
  return marker as unknown as IMarker;
}

/** Store with a deterministic clock and a marker factory we can observe. */
function makeStore(capacity = 200) {
  const markers: IMarker[] = [];
  let now = 1000;
  const store = new BlockStore({
    capacity,
    now: () => now,
    createMarker: () => {
      const m = fakeMarker();
      markers.push(m);
      return m;
    },
  });
  return {
    store,
    markers,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("BlockStore", () => {
  it("opens a running block on C with command text, start time and marker", () => {
    const h = makeStore();
    h.tick(5);
    h.store.onCommandStart("ls -la");

    const blocks = h.store.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("ls -la");
    expect(blocks[0].status).toBe("running");
    expect(blocks[0].startedAt).toBe(1005);
    expect(blocks[0].endedAt).toBeNull();
    expect(blocks[0].exitCode).toBeNull();
    expect(blocks[0].marker).toBe(h.markers[0]);
  });

  it("closes on D with exit code and duration; non-zero exit is an error", () => {
    const h = makeStore();
    h.tick(10);
    h.store.onCommandStart("false");
    h.tick(2500);
    h.store.onCommandDone(1);

    const b = h.store.getBlocks()[0];
    expect(b.exitCode).toBe(1);
    expect(b.status).toBe("error");
    expect(b.endedAt).toBe(3510);
    expect(blockDurationMs(b)).toBe(2500);

    h.store.onCommandStart("true");
    h.store.onCommandDone(0);
    expect(h.store.getBlocks()[1].status).toBe("ok");
  });

  it("A closes a block whose D was lost", () => {
    const h = makeStore();
    h.store.onCommandStart("sleep 100");
    h.store.onPromptStart();

    const b = h.store.getBlocks()[0];
    expect(b.status).toBe("ok");
    expect(b.exitCode).toBeNull();
    // no further notifications on an already-quiet store
    expect(h.store.getBlocks()).toHaveLength(1);
  });

  it("D without an open block creates a blind block anchored at the prompt marker", () => {
    // bash 3.2 and PowerShell never send C: the block hangs off the marker
    // the tracker registered on the previous A.
    const h = makeStore();
    h.store.onPromptStart();
    h.markers.length = 0; // the A marker is the tracker's, not the store's
    const anchor = fakeMarker(42);
    h.store.onCommandDone(3, anchor);

    const b = h.store.getBlocks()[0];
    expect(b.command).toBeNull();
    expect(b.startedAt).toBeNull();
    expect(blockDurationMs(b)).toBeNull();
    expect(b.exitCode).toBe(3);
    expect(b.status).toBe("error");
    expect(b.marker).toBe(anchor);
  });

  it("drops a marker-less D (startup noise before the first prompt)", () => {
    const h = makeStore();
    h.store.onCommandDone(0, null);
    expect(h.store.getBlocks()).toHaveLength(0);
  });

  it("evicts the oldest block past the ring capacity and disposes its marker", () => {
    const h = makeStore(2);
    h.store.onCommandStart("a");
    h.store.onCommandStart("b");
    h.store.onCommandStart("c");

    const blocks = h.store.getBlocks();
    expect(blocks.map((b) => b.command)).toEqual(["b", "c"]);
    expect(h.markers[0].isDisposed).toBe(true);
    expect(h.markers[1].isDisposed).toBe(false);
    expect(h.markers[2].isDisposed).toBe(false);
  });

  it("reset clears blocks and disposes markers; dispose stops all events", () => {
    const h = makeStore();
    const listener = vi.fn();
    h.store.subscribe(listener);

    h.store.onCommandStart("ls");
    h.store.reset();
    expect(h.store.getBlocks()).toHaveLength(0);
    expect(h.markers[0].isDisposed).toBe(true);
    expect(listener).toHaveBeenCalled();

    h.store.dispose();
    listener.mockClear();
    h.store.onCommandStart("after dispose");
    h.store.onCommandDone(0);
    h.store.onPromptStart();
    expect(h.store.getBlocks()).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies subscribers on every state change and supports unsubscribe", () => {
    const h = makeStore();
    const listener = vi.fn();
    const unsubscribe = h.store.subscribe(listener);
    h.store.onCommandStart("ls");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    h.store.onCommandDone(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("block helpers", () => {
  it("formatDuration renders ms, seconds and minutes", () => {
    expect(formatDuration(40)).toBe("40ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(65_000)).toBe("1m05s");
  });

  it("extractBlockText joins lines and trims the trailing blank", () => {
    const lines = ["ls -la", "file1", "file2", "", ""];
    const text = extractBlockText(
      (y) =>
        lines[y] === undefined
          ? undefined
          : { translateToString: () => lines[y] },
      0,
      lines.length,
    );
    expect(text).toBe("ls -la\nfile1\nfile2");
  });

  it("nextBlockStartLine finds the closest marker below and defaults to buffer end", () => {
    const mk = (line: number) => ({ id: line, line, isDisposed: false });
    const a = { id: 1, marker: mk(3) } as never;
    const b = { id: 2, marker: mk(9) } as never;
    const c = { id: 3, marker: null } as never;
    const blocks = [a, b, c];
    expect(nextBlockStartLine(blocks, a, 100)).toBe(9);
    expect(nextBlockStartLine(blocks, b, 100)).toBe(100);
  });
});

describe("reconcileBlockDecorations", () => {
  type FakeDecoration = DecorationLike & { disposed: boolean };
  const registry: {
    created: FakeDecoration[];
    register: () => FakeDecoration;
  } = {
    created: [],
    register: () => {
      const d: FakeDecoration = {
        disposed: false,
        dispose: () => {
          d.disposed = true;
        },
      };
      registry.created.push(d);
      return d;
    },
  };

  const block = (id: number, overrides: Partial<Block> = {}): Block =>
    ({
      id,
      command: "ls",
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      status: "running",
      marker: fakeMarker(5),
      ...overrides,
    }) as Block;

  it("creates once per block, recreates on state change, disposes on eviction", () => {
    const entries = new Map<number, BlockDecorationEntry>();
    const running = block(1);
    registry.created.length = 0;

    reconcileBlockDecorations([running], entries, () => registry.register());
    expect(entries.size).toBe(1);
    expect(registry.created).toHaveLength(1);

    // No-op when nothing changed.
    reconcileBlockDecorations([running], entries, () => registry.register());
    expect(registry.created).toHaveLength(1);

    // D arrived: signature changes, old decoration disposed, new created.
    const done = { ...running, status: "ok", exitCode: 0, endedAt: 9 } as typeof running;
    const first = entries.get(1)!.decoration as FakeDecoration;
    reconcileBlockDecorations([done], entries, () => registry.register());
    expect(first.disposed).toBe(true);
    expect(registry.created).toHaveLength(2);

    // Evicted (or trimmed) blocks lose their decorations.
    const second = entries.get(1)!.decoration as FakeDecoration;
    reconcileBlockDecorations([], entries, () => registry.register());
    expect(second.disposed).toBe(true);
    expect(entries.size).toBe(0);
  });

  it("ignores blocks whose marker is disposed and keeps live ones", () => {
    const entries = new Map<number, BlockDecorationEntry>();
    const live = block(1);
    const dead = block(2, { marker: fakeMarker(0) });
    (dead.marker as IMarker).dispose();
    expect(liveMarker(dead.marker)).toBe(false);

    reconcileBlockDecorations([live, dead], entries, () => registry.register());
    expect([...entries.keys()]).toEqual([1]);
  });
});
