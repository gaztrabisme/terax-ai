import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import {
  blockDurationMs,
  extractBlockText,
  formatDuration,
  liveMarker,
  nextBlockStartLine,
  reconcileBlockDecorations,
  safeDispose,
  type Block,
  type BlockDecorationEntry,
  type BlockStore,
  type DecorationLike,
} from "../lib/blocks";
import { getSlotForLeaf, type Slot } from "../lib/rendererPool";
import { writeToSession } from "../lib/useTerminalSession";

/**
 * Block chrome for one pane (philosophy 9): one decoration pair per block
 * anchored to its marker. The left decoration carries the status dot and the
 * hover action row (Copy as plain text, Copy ANSI via serialize({range}),
 * Rerun); the right decoration shows the duration once the block closed.
 * Renders nothing itself: the decorations live inside the pooled emulator,
 * and the store notifies this component to create or dispose them.
 */

const STYLE_ID = "terax-block-chrome-style";

const BLOCK_CSS = `
.terax-block { pointer-events: none; }
.terax-block-dot {
  pointer-events: auto;
  position: absolute;
  left: 1px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 62%;
  border-radius: 9999px;
}
.terax-block-dot.is-running { background: var(--amber-400, #d29922); }
.terax-block-dot.is-ok { background: var(--green-400, #3fb950); }
.terax-block-dot.is-error { background: var(--red-400, #f85149); }
.terax-block-dot.is-unknown { background: var(--muted-foreground, #8b949e); }
.terax-block-duration {
  pointer-events: none;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  white-space: pre;
  font-size: 10px;
  line-height: 1;
  color: var(--muted-foreground);
  opacity: 0.8;
}
.terax-block-row {
  display: none;
  pointer-events: auto;
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--background);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
}
.terax-block-dot:hover ~ .terax-block-row,
.terax-block-row:hover { display: flex; }
.terax-block-btn {
  pointer-events: auto;
  border: 0;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--muted-foreground);
  background: transparent;
  cursor: pointer;
}
.terax-block-btn:hover {
  background: var(--muted);
  color: var(--foreground);
}
`;

function injectStyleOnce(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BLOCK_CSS;
  document.head.appendChild(style);
}

type Props = {
  leafId: number;
  store: BlockStore | null;
};

export function BlockChrome({ leafId, store }: Props) {
  const entriesRef = useRef(new Map<number, BlockDecorationEntry>());

  useEffect(() => {
    injectStyleOnce();
    if (!store) return;
    const entries = entriesRef.current;
    const disposeAll = () => {
      for (const [, entry] of [...entries]) safeDispose(entry.decoration);
      entries.clear();
    };
    const reconcile = () => {
      const slot = getSlotForLeaf(leafId);
      if (!slot) {
        // No pooled slot bound: nothing to anchor decorations to.
        disposeAll();
        return;
      }
      reconcileBlockDecorations(store.getBlocks(), entries, (block) =>
        createBlockDecorations(slot, leafId, store, block),
      );
    };
    const unsubscribe = store.subscribe(reconcile);
    reconcile();
    return () => {
      unsubscribe();
      disposeAll();
    };
  }, [store, leafId]);

  return null;
}

/**
 * The decoration pair for one block. Disposing the returned composite removes
 * both halves; reconcileBlockDecorations calls this again whenever a block's
 * visible state (status, exit code, duration, command) changes.
 */
function createBlockDecorations(
  slot: Slot,
  leafId: number,
  store: BlockStore,
  block: Block,
): DecorationLike | undefined {
  if (!liveMarker(block.marker)) return undefined;
  const term = slot.term;
  const dot = term.registerDecoration({
    marker: block.marker,
    anchor: "left",
    x: 0,
    width: 1,
    height: 1,
  });
  const duration =
    block.endedAt !== null
      ? term.registerDecoration({
          marker: block.marker,
          anchor: "right",
          width: 1,
          height: 1,
        })
      : undefined;
  if (!dot && !duration) return undefined;
  dot?.onRender((el) => renderDot(el, term, slot, leafId, store, block));
  duration?.onRender((el) => renderDuration(el, block));
  return {
    dispose: () => {
      safeDispose(dot);
      safeDispose(duration);
    },
  };
}

/** Dot plus hover action row, inside the one-cell left decoration element. */
function renderDot(
  el: HTMLElement,
  term: Terminal,
  slot: Slot,
  leafId: number,
  store: BlockStore,
  block: Block,
): void {
  // Never overwrite className: xterm positions the element through it.
  el.classList.add("terax-block");
  let dot = el.querySelector<HTMLDivElement>(":scope > .terax-block-dot");
  if (!dot) {
    dot = document.createElement("div");
    dot.className = "terax-block-dot";
    el.appendChild(dot);
  }
  dot.className = `terax-block-dot is-${block.status}`;
  // Only "unknown" carries a title: ok and error are self-evident.
  if (block.status === "unknown") dot.title = "exit status unknown";
  else dot.removeAttribute("title");

  let row = el.querySelector<HTMLDivElement>(":scope > .terax-block-row");
  if (!row) {
    row = buildActionRow(slot, leafId, store, block);
    el.appendChild(row);
  }
  // The row spans the terminal width so its actions right-align; width
  // follows resizes because xterm re-fires onRender on viewport refreshes.
  row.style.width = `${term.element?.clientWidth ?? 0}px`;
}

function buildActionRow(
  slot: Slot,
  leafId: number,
  store: BlockStore,
  block: Block,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "terax-block-row";
  const term = slot.term;

  row.appendChild(
    makeButton("Copy", () => {
      if (!liveMarker(block.marker)) return;
      const buf = term.buffer.active;
      const start = block.marker.line;
      const end = nextBlockStartLine(store.getBlocks(), block, buf.length);
      void navigator.clipboard
        .writeText(extractBlockText((y) => buf.getLine(y), start, end))
        .catch(() => {});
    }),
  );

  row.appendChild(
    makeButton("Copy ANSI", () => {
      if (!liveMarker(block.marker)) return;
      const start = block.marker.line;
      const end = Math.max(
        start,
        nextBlockStartLine(store.getBlocks(), block, term.buffer.active.length) - 1,
      );
      try {
        const text = slot.serializeAddon.serialize({
          range: { start, end },
        });
        void navigator.clipboard.writeText(text).catch(() => {});
      } catch (e) {
        console.warn("[terax] block serialize failed:", e);
      }
    }),
  );

  if (block.command) {
    row.appendChild(
      makeButton("Rerun", () => {
        writeToSession(leafId, `${block.command}\r`);
      }),
    );
  }
  return row;
}

/** Right-anchored duration label, shown once the block has closed. */
function renderDuration(el: HTMLElement, block: Block): void {
  el.classList.add("terax-block", "terax-block-duration");
  const duration = blockDurationMs(block);
  el.textContent = duration === null ? "" : formatDuration(duration);
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "terax-block-btn";
  btn.textContent = label;
  // Keep keyboard focus in the emulator when a block action is clicked.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}
