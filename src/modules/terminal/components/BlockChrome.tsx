import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { exportBlock, plainOutput, readBlockOutput, storageError, type StorageError } from "@/modules/terminal/lib/journal";
import { blockDurationMs, formatDuration, liveMarker, safeDispose, type Block, type BlockStore } from "@/modules/terminal/lib/blocks";
import { getSlotForLeaf } from "@/modules/terminal/lib/rendererPool";
import { writeToSession } from "@/modules/terminal/lib/useTerminalSession";
import { SEND_TO_CHAT_EVENT, type SendToChatDetail } from "@/modules/pi/lib/sendToChat";

const STYLE_ID = "terax-block-chrome-style";
const BLOCK_CSS = `
.terax-block-overlay { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 2; }
.terax-block { pointer-events: none; }
.terax-block-live { position: absolute; top: -10000px; }
.terax-block-dot { pointer-events: auto; position: absolute; left: 1px; top: 50%; transform: translateY(-50%); width: 4px; height: 62%; border-radius: 9999px; }
.terax-block-dot.is-running { background: var(--amber-400, #d29922); }
.terax-block-dot.is-ok { background: var(--green-400, #3fb950); }
.terax-block-dot.is-error { background: var(--red-400, #f85149); }
.terax-block-dot.is-unknown { background: var(--muted-foreground, #8b949e); }
.terax-block-duration { position: absolute; right: 100px; top: 50%; transform: translateY(-50%); white-space: pre; font-size: 10px; line-height: 1; color: var(--muted-foreground); opacity: 0.8; }
.terax-block-menu { position: absolute; right: 8px; top: 0; min-height: 100%; }
.terax-block-row { display: flex; position: absolute; right: 0; top: 0; width: 0; height: 0; overflow: hidden; pointer-events: none; align-items: center; justify-content: flex-end; gap: 8px; }
.terax-block[data-expanded="true"] { z-index: 3; }
.terax-block[data-expanded="true"] .terax-block-row { top: 100%; width: max-content; max-width: 100%; height: auto; overflow: visible; pointer-events: auto; flex-wrap: wrap; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--background); box-shadow: 0 1px 4px rgb(0 0 0 / 0.25); }
.terax-block[data-menu-above="true"] .terax-block-row { top: auto; bottom: 100%; }
.terax-block-btn { pointer-events: auto; border: 0; border-radius: 4px; padding: 0 8px; font-size: 10px; line-height: 1.4; color: var(--muted-foreground); background: transparent; cursor: pointer; }
.terax-block-row .terax-block-btn { pointer-events: inherit; white-space: nowrap; }
.terax-block-btn:disabled { opacity: 0.5; cursor: default; }
.terax-block-btn:focus-visible { outline: 1px solid var(--ring); }
.terax-block-btn:hover { background: var(--muted); color: var(--foreground); }
.terax-block-menu { background: var(--background); }
.terax-block-recovered { position: relative; pointer-events: auto; min-height: 1.4em; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding-right: 100px; }
.terax-block-command { padding-left: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.terax-block-recovered > .terax-block-duration { position: static; transform: none; line-height: 1.4; white-space: normal; text-align: right; max-width: 24ch; }
`;

export function injectStyleOnce(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BLOCK_CSS;
  document.head.appendChild(style);
}

export type BlockErrorHandler = (error: StorageError, retry: () => Promise<void>) => void;

type Anchor = { marker: IMarker; decoration: IDecoration };

export function BlockChrome({ leafId, store, visible = true, onError }: {
  leafId: number;
  store: BlockStore | null;
  visible?: boolean;
  onError?: BlockErrorHandler;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const layout = useRef<(() => void) | null>(null);
  const [blocks, setBlocks] = useState<readonly Block[]>([]);

  useLayoutEffect(() => {
    injectStyleOnce();
    if (!store) { setBlocks([]); return; }
    let term: Terminal | undefined;
    let events: IDisposable[] = [];
    const anchors = new Map<number, Anchor>();
    let frame: number | null = null;
    const position = () => {
      const layer = overlay.current;
      const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!layer || !screen || !term) return;
      const bounds = layer.getBoundingClientRect();
      const screenBounds = screen.getBoundingClientRect();
      const scale = layer.offsetHeight ? bounds.height / layer.offsetHeight : 1;
      for (const block of store.getBlocks()) {
        const row = rows.current.get(block.id);
        if (!row) continue;
        const anchor = anchors.get(block.id)?.decoration.element;
        const height = Number.parseFloat(anchor?.style.height ?? "") || screenBounds.height / scale / term.rows;
        const available = liveMarker(block.marker) && term.buffer.active.type === "normal";
        const top = available ? (screenBounds.top - bounds.top) / scale + (block.marker!.line - term.buffer.active.viewportY) * height : -10000;
        row.style.top = `${top}px`;
        row.style.left = `${(screenBounds.left - bounds.left) / scale}px`;
        row.style.width = `${screenBounds.width / scale}px`;
        row.style.height = `${height}px`;
        row.dataset.menuAbove = String(top + height + 64 > layer.clientHeight && top > 64);
      }
    };
    const schedulePosition = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; position(); });
    };
    layout.current = position;
    const reconcile = () => {
      const nextTerm = visible ? getSlotForLeaf(leafId)?.term : undefined;
      if (term !== nextTerm) {
        for (const event of events) safeDispose(event);
        for (const anchor of anchors.values()) safeDispose(anchor.decoration);
        anchors.clear();
        term = nextTerm;
        events = term ? [term.onScroll(schedulePosition), term.onResize(schedulePosition), term.onRender(schedulePosition)] : [];
      }
      const current = store.getBlocks();
      const byId = new Map(current.map((block) => [block.id, block]));
      for (const [id, anchor] of anchors) {
        const block = byId.get(id);
        if (!block || block.marker !== anchor.marker || !liveMarker(block.marker)) {
          safeDispose(anchor.decoration);
          anchors.delete(id);
        }
      }
      for (const block of current) {
        if (!term || !liveMarker(block.marker) || anchors.has(block.id)) continue;
        const decoration = term.registerDecoration({ marker: block.marker, width: 1, height: 1 });
        if (decoration) {
          anchors.set(block.id, { marker: block.marker, decoration });
          decoration.onRender(schedulePosition);
        }
      }
      setBlocks([...current]);
      position();
    };
    const unsubscribe = store.subscribe(reconcile);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedulePosition);
    if (overlay.current) resize?.observe(overlay.current);
    reconcile();
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
      resize?.disconnect();
      for (const event of events) safeDispose(event);
      for (const anchor of anchors.values()) safeDispose(anchor.decoration);
      layout.current = null;
    };
  }, [leafId, store, visible]);
  useLayoutEffect(() => { layout.current?.(); }, [blocks]);

  return <div ref={overlay} className="terax-block-overlay" style={{ visibility: visible ? undefined : "hidden" }}>
    {blocks.map((block, index) => <BlockChromeRow
      key={block.id} block={block} leafId={leafId} index={index} onError={onError}
      rowRef={(row) => { if (row) rows.current.set(block.id, row); else rows.current.delete(block.id); }}
      onFocus={() => {
        const term = getSlotForLeaf(leafId)?.term;
        if (term && liveMarker(block.marker) && (block.marker.line < term.buffer.active.viewportY || block.marker.line >= term.buffer.active.viewportY + term.rows)) {
          term.scrollToLine(block.marker.line);
          layout.current?.();
        }
      }}
    />)}
  </div>;
}

export function BlockChromeRow({ block, leafId, index, recovered = false, rowRef, onFocus, onError }: {
  block: Block;
  leafId: number;
  index?: number;
  recovered?: boolean;
  rowRef?: Ref<HTMLDivElement>;
  onFocus?: () => void;
  onError?: BlockErrorHandler;
}) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expanded = open || hovered;
  const key = block.file?.record.blockId ?? String(block.id);
  const duration = blockDurationMs(block);
  const status = block.interrupted ? "interrupted / exit unknown" : block.status === "unknown" ? "exit unknown" : "";
  const exitDot = block.status === "ok" ? "exit-dot-ok" : block.status === "error" ? "exit-dot-fail" : block.status === "unknown" ? "exit-dot-unknown" : undefined;
  useLayoutEffect(injectStyleOnce, []);
  useLayoutEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const perform = (task: () => Promise<void>) => {
    void task().catch((error) => onError?.(storageError(error, block.file ? `${block.file.project}/${block.file.record.outputPath}` : "Terminal output"), task));
  };
  const fileDisabled = !block.file || block.status === "running";
  const action = (label: string, uat: string, disabled: boolean, task: () => Promise<void>, title?: string) => (
    <button type="button" className="terax-block-btn" aria-label={label} title={title}
      data-uat={uat} data-uat-key={key} disabled={disabled} tabIndex={expanded ? 0 : -1}
      onClick={() => perform(task)}>{label}</button>
  );
  return <div ref={rowRef} data-uat="terminal-block" data-uat-key={key} data-uat-index={index}
    data-uat-status={block.status} data-uat-exit={block.exitCode ?? (block.status === "running" ? "running" : "unknown")}
    data-uat-duration-ms={duration ?? "null"} role="group" aria-label={`Terminal block ${key}`} aria-describedby={`${menuId}-command`}
    className={`terax-block ${recovered ? "terax-block-recovered" : "terax-block-live"}`}
    data-expanded={expanded} onFocus={onFocus}
    onMouseEnter={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(true); }}
    onMouseLeave={() => { hoverTimer.current = setTimeout(() => setHovered(false), 100); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false); setHovered(false); trigger.current?.focus();
      }
    }}>
    <span className={`terax-block-dot is-${block.status}`} data-uat={exitDot} role="status"
      aria-label={block.interrupted ? "interrupted / exit unknown" : `exit ${block.exitCode ?? block.status}`}
      title={block.status === "unknown" ? status : undefined} />
    <span id={`${menuId}-command`} className={recovered ? "terax-block-command" : "sr-only"}
      title={recovered ? block.command ?? "Command unavailable" : undefined}>{block.command ?? "Command unavailable"}</span>
    <span className="terax-block-duration">{[
      block.commandTruncated ? "Truncated command" : "", status,
      duration === null ? (block.status === "running" ? "" : "duration unknown") : formatDuration(duration),
    ].filter(Boolean).join(" / ")}</span>
    <button ref={trigger} type="button" className="terax-block-btn terax-block-menu"
      data-uat="block-actions" data-uat-key={key} aria-label="Block actions" aria-expanded={expanded} aria-controls={menuId}
      onClick={() => { setOpen(!open); setHovered(false); }}>Block actions</button>
    <div id={menuId} className="terax-block-row" role="group" aria-label="Block commands">
      {action("Copy", "block-copy", fileDisabled, async () => {
        if (block.file) await navigator.clipboard.writeText(plainOutput(await readBlockOutput(block.file)));
      })}
      {action("Copy ANSI", "block-copy-ansi", fileDisabled, async () => {
        if (block.file) await navigator.clipboard.writeText(await readBlockOutput(block.file));
      })}
      {action("Open in editor", "open-in-editor", fileDisabled, async () => {
        if (block.file) await exportBlock(block.file);
      })}
      {action("Rerun", "block-rerun", block.interrupted === true || !block.command || block.status === "running", async () => {
        if (!block.interrupted && block.command) writeToSession(leafId, `${block.command}\r`);
      }, block.interrupted ? "Command did not finish" : undefined)}
      {action("Send to chat", "block-send-to-chat", fileDisabled, async () => {
        if (!block.file) return;
        const raw = plainOutput(await readBlockOutput(block.file));
        const detail: SendToChatDetail = {
          text: buildQuotation(block.command, raw, block.id),
          source: { blockId: block.id, terminalId: leafId, sha256: await sha256Hex(raw) },
        };
        window.dispatchEvent(new CustomEvent<SendToChatDetail>(SEND_TO_CHAT_EVENT, { detail }));
      })}
    </div>
  </div>;
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
