import type { BlockFile, JournalRecord } from "@/modules/terminal/lib/journal";
import type { IMarker } from "@xterm/xterm";

/**
 * Terminal blocks (philosophy 9): one command per block, fed by the OSC 133
 * prompt tracker (see osc-handlers.ts). The store is pure state plus marker
 * ownership; the visual chrome lives in components/BlockChrome.tsx.
 */

/**
 * "unknown" means the block closed without a parseable exit code (D lost,
 * crashed shell, partial shell integration): it never claims success.
 */
export type BlockStatus = "running" | "ok" | "error" | "unknown";

export type Block = {
  /** Monotonic per-store id, stable across status changes. */
  id: number;
  file?: BlockFile;
  commandTruncated?: boolean;
  interrupted?: boolean;
  durationMs?: number | null;
  /** Command text carried by the OSC 133 C payload, when the shell sends one. */
  command: string | null;
  /** Wall-clock ms at the C event, null for shells without C (bash 3.2, PowerShell). */
  startedAt: number | null;
  /** Wall-clock ms at the D event. */
  endedAt: number | null;
  /** Exit code from the D payload, null when D never arrived. */
  exitCode: number | null;
  status: BlockStatus;
  /** Buffer marker at the command line; anchors the block chrome. */
  marker: IMarker | null;
};

/** Blocks kept per session; older blocks are evicted with their markers. */
export const BLOCK_RING_CAPACITY = 200;

export type BlockStoreOptions = {
  /** Creates the buffer marker anchoring a block at its command line. */
  createMarker?: () => IMarker | null;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Ring capacity, defaults to BLOCK_RING_CAPACITY. */
  capacity?: number;
};

type Listener = () => void;

/**
 * Bounded ring of blocks for one session, mirroring the DormantRing pattern:
 * a fixed capacity, oldest-first eviction, and disposal of evicted resources
 * (here: buffer markers instead of byte chunks).
 */
export class BlockStore {
  private blocks: Block[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;
  private disposed = false;
  private readonly capacity: number;

  constructor(private readonly opts: BlockStoreOptions = {}) {
    this.capacity = opts.capacity ?? BLOCK_RING_CAPACITY;
  }

  /** OSC 133 C: open a block with the command text and a marker at the cursor line. */
  onCommandStart(command: string | null): void {
    if (this.disposed) return;
    // A still-open block means D was lost; close it as unknown before
    // opening the next.
    this.closeOpenBlock(null);
    this.push({
      id: this.nextId++,
      command,
      startedAt: this.opts.now?.() ?? null,
      endedAt: null,
      exitCode: null,
      status: "running",
      marker: this.safeMarker(),
    });
    this.notify();
  }

  /**
   * OSC 133 D: set exit code and duration on the open block. When no block is
   * open (bash 3.2 and PowerShell never send C) a blind block is created from
   * the anchor marker instead: it carries an exit code but no command text and
   * no duration. Without an anchor there is nothing to show, so the event is
   * dropped (the startup D every shell emits before the first prompt). A null
   * exit code (unparseable D payload) closes the block as "unknown" rather
   * than as success.
   */
  onCommandDone(exitCode: number | null, anchor?: IMarker | null): void {
    if (this.disposed) return;
    const open = this.openBlock();
    if (open) {
      open.exitCode = exitCode;
      open.status =
        exitCode === null ? "unknown" : exitCode === 0 ? "ok" : "error";
      open.endedAt = this.opts.now?.() ?? null;
    } else {
      if (!liveMarker(anchor)) return;
      this.push({
        id: this.nextId++,
        command: null,
        startedAt: null,
        endedAt: this.opts.now?.() ?? null,
        exitCode,
        status: exitCode === null ? "unknown" : exitCode === 0 ? "ok" : "error",
        marker: anchor,
      });
    }
    this.notify();
  }

  /** OSC 133 A: close any block still open (D lost) with status "unknown". */
  onPromptStart(): void {
    if (this.disposed) return;
    if (this.closeOpenBlock(null)) this.notify();
  }

  applyJournal(block: Block, record: JournalRecord, project: string): void {
    block.file = { project, record };
    block.command = record.command || null;
    block.commandTruncated = record.commandTruncated;
    block.interrupted = record.event === "interrupted";
    block.startedAt = record.startedAt === null ? null : Date.parse(record.startedAt);
    block.endedAt = record.endedAt === null ? null : Date.parse(record.endedAt);
    block.durationMs = record.durationMs;
    block.exitCode = typeof record.exit === "number" ? record.exit : null;
    block.status = record.exit === "running" ? "running" : record.exit === "unknown" ? "unknown" : record.exit === 0 ? "ok" : "error";
    this.notify();
  }

  /** Live ring contents, oldest first. */
  getBlocks(): readonly Block[] {
    return this.blocks;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Drop everything (markers disposed). Used when a session respawns its shell. */
  reset(): void {
    this.clear();
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.notify();
    this.listeners.clear();
  }

  private clear(): void {
    for (const b of this.blocks) {
      if (liveMarker(b.marker)) {
        try {
          b.marker.dispose();
        } catch {
          /* marker already gone with the buffer */
        }
      }
    }
    this.blocks = [];
  }

  private openBlock(): Block | null {
    return this.blocks.find((b) => b.status === "running") ?? null;
  }

  /**
   * Closes the open block; returns true when something changed. A null exit
   * code (closed by A or C instead of D) yields status "unknown": a block
   * with no evidence of success is never reported as ok.
   */
  private closeOpenBlock(exitCode: number | null): boolean {
    const open = this.openBlock();
    if (!open) return false;
    open.exitCode = exitCode;
    open.status = exitCode === null ? "unknown" : exitCode === 0 ? "ok" : "error";
    open.endedAt = this.opts.now?.() ?? null;
    return true;
  }

  private push(block: Block): void {
    this.blocks.push(block);
    while (this.blocks.length > this.capacity) {
      const evicted = this.blocks.shift();
      if (evicted && liveMarker(evicted.marker)) {
        try {
          evicted.marker.dispose();
        } catch {
          /* buffer went away first */
        }
      }
    }
  }

  private safeMarker(): IMarker | null {
    try {
      return this.opts.createMarker?.() ?? null;
    } catch {
      return null;
    }
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.warn("[terax] block listener failed:", e);
      }
    }
  }
}

/** A marker that still points at a live buffer line. */
export function liveMarker(m: IMarker | null | undefined): m is IMarker {
  return !!m && !m.isDisposed && m.line >= 0;
}

export function blockDurationMs(b: Block): number | null {
  if (b.durationMs !== undefined) return b.durationMs;
  if (b.startedAt === null || b.endedAt === null) return null;
  return Math.max(0, b.endedAt - b.startedAt);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** Plain text of the buffer lines in [startLine, endLineExclusive). */
export function extractBlockText(
  getLine: (y: number) => { translateToString(trimRight?: boolean): string } | undefined,
  startLine: number,
  endLineExclusive: number,
): string {
  const lines: string[] = [];
  const end = Math.max(startLine, endLineExclusive);
  for (let y = startLine; y < end; y++) {
    lines.push(getLine(y)?.translateToString(true) ?? "");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * The line where the next block starts: the closest live marker below this
 * block's marker, else the end of the buffer.
 */
export function nextBlockStartLine(
  blocks: readonly Block[],
  block: Block,
  bufferLength: number,
): number {
  const own = block.marker?.line ?? -1;
  let next = bufferLength;
  for (const other of blocks) {
    if (other.id === block.id) continue;
    const line = other.marker?.line ?? -1;
    if (line > own && line < next) next = line;
  }
  return next;
}

export type DecorationLike = { dispose(): void };

export type BlockDecorationEntry = {
  /** What the decoration was drawn for; a change means dispose and redraw. */
  signature: string;
  decoration: DecorationLike;
};

export function blockSignature(b: Block): string {
  return [b.status, b.exitCode ?? "", b.endedAt ?? "", b.command ?? "", b.commandTruncated, b.interrupted, b.file?.record.blockId].join("|");
}

/**
 * Reconciles one decoration set against the store's blocks: creates for new
 * blocks, recreates when a block's visible state changed, and disposes for
 * evicted or trimmed blocks. The entries map is owned by the caller so React
 * effects can dispose everything they created on cleanup.
 */
export function reconcileBlockDecorations(
  blocks: readonly Block[],
  entries: Map<number, BlockDecorationEntry>,
  createDecoration: (block: Block) => DecorationLike | undefined,
): void {
  const kept = new Set<number>();
  for (const b of blocks) {
    if (!liveMarker(b.marker)) continue;
    kept.add(b.id);
    const signature = blockSignature(b);
    const existing = entries.get(b.id);
    if (existing && existing.signature === signature) continue;
    if (existing) safeDispose(existing.decoration);
    const decoration = createDecoration(b);
    if (decoration) entries.set(b.id, { signature, decoration });
    else entries.delete(b.id);
  }
  for (const [id, entry] of [...entries]) {
    if (!kept.has(id)) {
      safeDispose(entry.decoration);
      entries.delete(id);
    }
  }
}

export function safeDispose(d: DecorationLike | undefined): void {
  try {
    d?.dispose();
  } catch {
    /* already disposed with the terminal */
  }
}
