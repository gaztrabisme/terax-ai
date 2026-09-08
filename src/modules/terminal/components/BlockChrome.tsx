import type { Terminal } from "@xterm/xterm";
import { exportBlock, plainOutput, readBlockOutput, storageError, type StorageError } from "@/modules/terminal/lib/journal";
import { useEffect, useRef } from "react";
import {
  blockDurationMs,
  formatDuration,
  liveMarker,
  reconcileBlockDecorations,
  safeDispose,
  type Block,
  type BlockDecorationEntry,
  type BlockStore,
  type DecorationLike,
} from "../lib/blocks";
import { getSlotForLeaf, type Slot } from "../lib/rendererPool";
import { writeToSession } from "../lib/useTerminalSession";
import {
  SEND_TO_CHAT_EVENT,
  type SendToChatDetail,
} from "@/modules/pi/lib/sendToChat";

/**
 * Block chrome for one pane (philosophy 9): one decoration pair per block
 * anchored to its marker. The left decoration carries the status dot and the
 * action row (file-backed Copy, Copy ANSI, editor export and Rerun); the right decoration shows the duration once the block closed.
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
  right: 8px;
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
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--background);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
}
.terax-block-dot:hover ~ .terax-block-row,
.terax-block-row:hover,
.terax-block:focus-within > .terax-block-row { display: flex; }
.terax-block-btn {
  pointer-events: auto;
  border: 0;
  border-radius: 4px;
  padding: 0 8px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--muted-foreground);
  background: transparent;
  cursor: pointer;
}
.terax-block-btn:disabled { opacity: 0.5; cursor: default; }
.terax-block-btn:focus-visible { outline: 1px solid var(--ring); }
.terax-block-recovered { position: relative; pointer-events: auto; min-height: 1.4em; }
.terax-block-recovered { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.terax-block-command { padding-left: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.terax-block-recovered > .terax-block-duration { position: static; transform: none; line-height: 1.4; white-space: normal; text-align: right; max-width: 24ch; }
.terax-block-recovered > .terax-block-row { z-index: 2; flex-wrap: wrap; }
.terax-block-state { font-size: 10px; color: var(--muted-foreground); white-space: nowrap; }
.terax-block-btn:hover {
  background: var(--muted);
  color: var(--foreground);
}
`;

export function injectStyleOnce(): void {
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
  onError?: BlockErrorHandler;
};

export type BlockErrorHandler = (error: StorageError, retry: () => Promise<void>) => void;

export function BlockChrome({ leafId, store, onError }: Props) {
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
        createBlockDecorations(slot, leafId, store, block, onError),
      );
    };
    const unsubscribe = store.subscribe(reconcile);
    reconcile();
    return () => {
      unsubscribe();
      disposeAll();
    };
  }, [store, leafId, onError]);

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
  onError?: BlockErrorHandler,
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
  dot?.onRender((el) => renderDot(el, term, slot, leafId, store, block, onError));
  duration?.onRender((el) => renderDuration(el, block));
  return {
    dispose: () => {
      safeDispose(dot);
      safeDispose(duration);
    },
  };
}

/** Canonical UAT id of a closed block's status dot; a running block has none. */
function exitDotUatId(status: Block["status"]): string | null {
  switch (status) {
    case "ok":
      return "exit-dot-ok";
    case "error":
      return "exit-dot-fail";
    case "unknown":
      return "exit-dot-unknown";
    default:
      return null;
  }
}

/** Dot plus hover action row, inside the one-cell left decoration element. */
function renderDot(
  el: HTMLElement,
  term: Terminal,
  _slot: Slot,
  leafId: number,
  store: BlockStore,
  block: Block,
  onError?: BlockErrorHandler,
): void {
  // Never overwrite className: xterm positions the element through it.
  el.classList.add("terax-block");
  el.setAttribute("data-uat", "terminal-block");
  el.setAttribute("data-uat-key", block.file?.record.blockId ?? String(block.id));
  el.tabIndex = 0;
  el.setAttribute("aria-label", `Terminal block ${block.command ?? "command unavailable"}`);
  el.setAttribute(
    "data-uat-index",
    String(Math.max(0, store.getBlocks().indexOf(block))),
  );
  let dot = el.querySelector<HTMLDivElement>(":scope > .terax-block-dot");
  if (!dot) {
    dot = document.createElement("div");
    dot.className = "terax-block-dot";
    el.appendChild(dot);
  }
  dot.className = `terax-block-dot is-${block.status}`;
  const exitDotId = exitDotUatId(block.status);
  if (exitDotId) dot.setAttribute("data-uat", exitDotId);
  else dot.removeAttribute("data-uat");
  // Only "unknown" carries a title: ok and error are self-evident.
  dot.setAttribute("aria-label", block.interrupted ? "interrupted / exit unknown" : `exit ${block.exitCode ?? block.status}`);
  if (block.status === "unknown") dot.title = block.interrupted ? "interrupted / exit unknown" : "exit status unknown";
  else dot.removeAttribute("title");

  let row = el.querySelector<HTMLDivElement>(":scope > .terax-block-row");
  if (!row) {
    row = buildActionRow(leafId, block, onError);
    el.appendChild(row);
  }
  // The row spans the terminal width so its actions right-align; width
  // follows resizes because xterm re-fires onRender on viewport refreshes.
  row.style.width = `${term.element?.clientWidth ?? 0}px`;
}

export function buildActionRow(
  leafId: number,
  block: Block,
  onError?: BlockErrorHandler,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "terax-block-row";
  const key = block.file?.record.blockId ?? block.id;
  const perform = (task: () => Promise<void>) => {
    void task().catch((error) => onError?.(storageError(error, block.file ? `${block.file.project}/${block.file.record.outputPath}` : "Terminal output"), task));
  };
  const fileAction = (label: string, uat: string, task: () => Promise<void>) => {
    const button = makeButton(label, () => perform(task), uat, key);
    button.disabled = !block.file || block.status === "running";
    row.appendChild(button);
  };
  fileAction("Copy", "block-copy", async () => {
    if (block.file) await navigator.clipboard.writeText(plainOutput(await readBlockOutput(block.file)));
  });
  fileAction("Copy ANSI", "block-copy-ansi", async () => {
    if (block.file) await navigator.clipboard.writeText(await readBlockOutput(block.file));
  });
  fileAction("Open in editor", "open-in-editor", async () => {
    if (block.file) await exportBlock(block.file);
  });
  const rerun = makeButton("Rerun", () => {
    if (!block.interrupted && block.command) writeToSession(leafId, `${block.command}\r`);
  }, "block-rerun", key);
  rerun.disabled = block.interrupted === true || !block.command || block.status === "running";
  row.appendChild(rerun);
  const send = makeSendToChatButton(leafId, block, async () => block.file ? plainOutput(await readBlockOutput(block.file)) : "", onError);
  send.disabled = !block.file || block.status === "running";
  row.appendChild(send);
  if (block.commandTruncated || block.interrupted || block.status === "unknown") {
    const state = document.createElement("span");
    state.className = "terax-block-state";
    state.textContent = [block.commandTruncated ? "Truncated command" : "", block.interrupted ? "interrupted / exit unknown" : block.status === "unknown" ? "exit unknown" : ""].filter(Boolean).join(" / ");
    row.appendChild(state);
  }
  return row;
}

export function renderRecoveredChrome(el: HTMLElement, leafId: number, block: Block, onError?: BlockErrorHandler): void {
  injectStyleOnce();
  el.replaceChildren();
  el.className = "terax-block terax-block-recovered";
  el.tabIndex = 0;
  el.setAttribute("aria-label", `Terminal block ${block.command ?? "command unavailable"}`);
  const dot = document.createElement("span");
  dot.className = `terax-block-dot is-${block.status}`;
  dot.setAttribute("data-uat", exitDotUatId(block.status) ?? "exit-dot-unknown");
  dot.setAttribute("aria-label", block.interrupted ? "interrupted / exit unknown" : `exit ${block.exitCode ?? "unknown"}`);
  el.appendChild(dot);
  const command = document.createElement("span");
  command.className = "terax-block-command";
  command.textContent = block.command ?? "Command unavailable";
  el.appendChild(command);
  const duration = document.createElement("span");
  renderDuration(duration, block);
  el.appendChild(duration);
  const row = buildActionRow(leafId, block, onError);
  row.style.width = "100%";
  el.appendChild(row);
}

/** Output lines carried into a transfer quotation before truncation. */
export const SEND_TO_CHAT_MAX_LINES = 200;

/**
 * The quotation a "Send to chat" click builds (K8): a bare fenced block
 * holding the command line, a blank line and the captured output (capped at
 * SEND_TO_CHAT_MAX_LINES lines with a trailing counter when longer), and
 * below the fence one line naming the source block.
 */
export function buildQuotation(
  command: string | null,
  output: string,
  blockId: number,
): string {
  const lines = output.length === 0 ? [] : output.split("\n");
  let body = lines;
  if (lines.length > SEND_TO_CHAT_MAX_LINES) {
    body = [
      ...lines.slice(0, SEND_TO_CHAT_MAX_LINES),
      `(output truncated, ${lines.length} lines)`,
    ];
  }
  return [
    "```",
    command ?? "",
    "",
    ...body,
    "```",
    `From terminal block ${blockId}`,
  ].join("\n");
}

/** Hex SHA-256 over the raw output text (Web Crypto subtle.digest). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The K8 button: builds the quotation from the block's captured output and
 * hands {text, source:{blockId, terminalId, sha256}} to the shell through the
 * window CustomEvent "pi:send-to-chat". App retargets it to a chat tab whose
 * composer appends it to the draft; nothing here ever sends.
 */
export function makeSendToChatButton(
  leafId: number,
  block: Block,
  getRawOutput: () => string | Promise<string>,
  onError?: BlockErrorHandler,
): HTMLButtonElement {
  const btn = makeButton(
    "Send to chat",
    () => {
      if (!block.file && !liveMarker(block.marker)) return;
      const transfer = async () => {
        const raw = await getRawOutput();
        const sha256 = await sha256Hex(raw);
        const detail: SendToChatDetail = {
          text: buildQuotation(block.command, raw, block.id),
          source: { blockId: block.id, terminalId: leafId, sha256 },
        };
        window.dispatchEvent(new CustomEvent<SendToChatDetail>(SEND_TO_CHAT_EVENT, { detail }));
      };
      void transfer().catch((error) => onError?.(storageError(error, block.file?.record.outputPath ?? "Terminal output"), transfer));
    },
    "block-send-to-chat",
    block.file?.record.blockId ?? block.id,
  );
  btn.setAttribute("aria-label", "Send to chat");
  return btn;
}

/** Right-anchored duration label, shown once the block has closed. */
function renderDuration(el: HTMLElement, block: Block): void {
  el.classList.add("terax-block", "terax-block-duration");
  const duration = blockDurationMs(block);
  el.textContent = [block.commandTruncated ? "Truncated command" : "", block.interrupted ? "interrupted / exit unknown" : block.status === "unknown" ? "exit unknown" : "", duration === null ? (block.endedAt ? "duration unknown" : "") : formatDuration(duration)].filter(Boolean).join(" / ");
}

function makeButton(
  label: string,
  onClick: () => void,
  uatId?: string,
  uatKey?: number | string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.className = "terax-block-btn";
  btn.textContent = label;
  if (uatId) {
    btn.setAttribute("data-uat", uatId);
    if (uatKey !== undefined) btn.setAttribute("data-uat-key", String(uatKey));
  }
  // Keep keyboard focus in the emulator when a block action is clicked.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}
