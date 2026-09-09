import { invoke } from "@tauri-apps/api/core";
import { ensureMonoFontsLoaded } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BlockStore } from "./blocks";
import { parseJournalRecord, storageError, type JournalRecord, type StorageError } from "@/modules/terminal/lib/journal";
import { DormantRing } from "./dormantRing";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
  type PromptEvent,
  type PromptTracker,
} from "./osc-handlers";
import { openPty, type PtySession } from "./pty-bridge";
import {
  acquireSlot,
  applyBackgroundActive,
  applyFontFamily,
  applyFontSize,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyWebglPreference,
  configureRendererPool,
  focusSlot,
  getSlotForLeaf,
  releaseSlot,
  setSlotFocused,
} from "./rendererPool";

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  /** Null signals an unbound renderer; the session still retains its blocks. */
  onBlockStore?: (store: BlockStore | null) => void;
  onJournalError?: (error: StorageError | null) => void;
  onTerminalIdentity?: (identity: { terminalId: string; project: string }) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  project: string | undefined;
  journalRecords: Map<string, JournalRecord>;
  journalStarts: JournalRecord[];
  journalError: StorageError | null;
  shellState: ReturnType<typeof createShellIntegrationState>;
  initialCwd: string | undefined;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  searchQuery: string | null;
  dormantRing: DormantRing;
  hasSlot: boolean;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  /** Command metadata survives dormancy; only buffer markers are rebound. */
  blockStore: BlockStore | null;
};

const sessions = new Map<number, Session>();

const readyLeaves = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(leafId: number): void {
  if (readyLeaves.has(leafId)) return;
  readyLeaves.add(leafId);
  const waiters = readyWaiters.get(leafId);
  if (!waiters) return;
  readyWaiters.delete(leafId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(leafId: number, timeoutMs = 4000): Promise<void> {
  if (readyLeaves.has(leafId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(leafId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(leafId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(leafId, arr);
  });
}

export function writeToSession(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || !s.pty) return false;
  void s.pty.write(data);
  return true;
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line — macOS Terminal's ⌘K behaviour. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [leafId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForLeaf(leafId);
    if (!slot) continue;
    slot.term.clear();
    return true;
  }
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  for (const [leafId, s] of sessions) {
    if (s.pty?.id === ptyId) return leafId;
  }
  return null;
}

configureRendererPool({
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        s.pty?.write(data);
      },
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // Linux only emits SIGWINCH when the winsize ioctl actually
        // changes dims, so bump +1 row then restore. The TUI receives
        // (possibly two) SIGWINCHes and repaints from scratch.
        pty
          .resize(cols, rows + 1)
          .then(() => pty.resize(cols, rows))
          .catch((e) => console.warn("[terax] kickPty failed:", e));
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow && s.focusedNow;
  },
});

function ensureSession(leafId: number, initialCwd?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    ptyOpening: false,
    project: initialCwd,
    journalRecords: new Map(),
    journalStarts: [],
    journalError: null,
    shellState: createShellIntegrationState(),
    initialCwd,
    lastCwd: null,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    searchQuery: null,
    dormantRing: new DormantRing(),
    hasSlot: false,
    altScreenAtRelease: false,
    blockStore: new BlockStore({
      createMarker: () => getSlotForLeaf(leafId)?.term.registerMarker(0) ?? null,
    }),
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
  })();

  return session;
}

function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  const slot = getSlotForLeaf(leafId);
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
}

function bindCommittedRecords(s: Session): void {
  if (!s.blockStore || !s.project) return;
  for (const block of s.blockStore.getBlocks()) {
    if (!block.file) {
      const index = s.journalStarts.findIndex((r) => (r.command || null) === block.command);
      if (index < 0) continue;
      const [start] = s.journalStarts.splice(index, 1);
      s.blockStore.applyJournal(block, s.journalRecords.get(start.blockId) ?? start, s.project);
    } else {
      const record = s.journalRecords.get(block.file.record.blockId);
      if (record && record.seq !== block.file.record.seq) s.blockStore.applyJournal(block, record, s.project);
    }
  }
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  return openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => deliverPtyBytes(leafId, bytes),
      onJournal: (event) => {
        if (event.kind === "storage-error") {
          s.journalError = storageError(event, `${s.project}/.pi/terminal`);
          s.callbacks.onJournalError?.(s.journalError);
        } else if (event.kind === "saved") {
          s.journalError = null;
          s.callbacks.onJournalError?.(null);
        } else {
          let record: JournalRecord;
          try { record = parseJournalRecord(event.record); }
          catch (error) {
            s.journalError = storageError(error, `${s.project}/.pi/terminal`);
            s.callbacks.onJournalError?.(s.journalError);
            return;
          }
          s.journalRecords.set(record.blockId, record);
          if (record.event === "start") s.journalStarts.push(record);
          while (s.journalRecords.size > 200) {
            const oldest = s.journalRecords.keys().next().value!;
            s.journalRecords.delete(oldest);
            s.journalStarts = s.journalStarts.filter((r) => r.blockId !== oldest);
          }
          bindCommittedRecords(s);
        }
      },
      onExit: (code) => {
        s.shellExited = true;
        const slot = getSlotForLeaf(leafId);
        if (slot) slot.term.options.disableStdin = true;
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
    s.project,
  );
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container) return;
  const altScreen = s.altScreenAtRelease;
  let acceptBlocks = false;
  const restoreMarkers = (term: Terminal) => {
    if (term.buffer.active.type !== "normal") return;
    const cursor = term.buffer.normal.baseY + term.buffer.normal.cursorY;
    s.blockStore?.restoreMarkers((line) => term.registerMarker(line - cursor) ?? null);
  };
  s.altScreenAtRelease = false;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: s.snapshot,
    onSnapshotRestored: (term) => {
      if (s.disposed || getSlotForLeaf(leafId)?.term !== term) return;
      restoreMarkers(term);
      acceptBlocks = true;
      bindCommittedRecords(s);
    },
    altScreen,
    drainRing: (write) => s.dormantRing.drain(write),
    shellExited: s.shellExited,
    searchQuery: s.searchQuery,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      const shellState = s.shellState;
      const blocks = s.blockStore!;
      s.callbacks.onBlockStore?.(blocks);
      let tracker: PromptTracker | null = null;
      let currentBlock: ReturnType<BlockStore["getBlocks"]>[number] | null = blocks.getBlocks()[blocks.getBlocks().length - 1] ?? null;
      const attachRecord = (block: ReturnType<BlockStore["getBlocks"]>[number]) => {
        const index = s.journalStarts.findIndex((r) => (r.command || null) === block.command);
        if (index < 0 || !s.project) return;
        const [start] = s.journalStarts.splice(index, 1);
        const record = s.journalRecords.get(start.blockId) ?? start;
        blocks.applyJournal(block, record, s.project);
      };
      const prompt = registerPromptTracker(term, shellState, (event: PromptEvent) => {
        if (!acceptBlocks) return;
        if (event.type === "A") {
          blocks.onPromptStart();
          currentBlock = null;
        } else if (event.type === "C") {
          blocks.onCommandStart(event.command);
          currentBlock = blocks.getBlocks()[blocks.getBlocks().length - 1] ?? null;
          if (currentBlock) attachRecord(currentBlock);
        } else {
          // Shells without C (bash 3.2, PowerShell) anchor their blind block
          // at the prompt marker drawn by the previous A.
          if (currentBlock?.file) {
            const record = s.journalRecords.get(currentBlock.file.record.blockId);
            if (record && s.project) blocks.applyJournal(currentBlock, record, s.project);
          } else {
            blocks.onCommandDone(event.exitCode, tracker?.getMarker() ?? null);
            const block = blocks.getBlocks()[blocks.getBlocks().length - 1];
            if (block && !block.file) attachRecord(block);
          }
          currentBlock = null;
        }
      });
      tracker = prompt;
      const cwd = registerCwdHandler(
        term,
        (next) => {
          markSessionReady(leafId);
          if (s.lastCwd === next) return;
          s.lastCwd = next;
          s.callbacks.onCwd?.(next);
        },
        shellState,
      );
      const bufferChange = term.buffer.onBufferChange(() => {
        if (acceptBlocks) restoreMarkers(term);
      });
      return [
        prompt.dispose,
        cwd,
        () => bufferChange.dispose(),
      ];
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  const out = releaseSlot(leafId, (firstLine) => s.blockStore?.detachMarkers(firstLine));
  if (out) {
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
  }
  s.hasSlot = false;
  s.callbacks.onBlockStore?.(null);
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  callbacks.onJournalError?.(s.journalError);
  if (s.pty) callbacks.onTerminalIdentity?.(s.pty);
  s.container = container;

  if (s.visibleNow) bindLeafToSlot(leafId, s);

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    openPtyForSession(leafId, s, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed) {
          pty.close();
          return;
        }
        s.pty = pty;
        s.project = pty.project;
        bindCommittedRecords(s);
        s.callbacks.onTerminalIdentity?.(pty);
        if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
      })
      .catch((e) => {
        s.ptyOpening = false;
        s.journalError = storageError(e, `${s.project}/.pi/terminal`);
        s.callbacks.onJournalError?.(s.journalError);
        console.error("[terax] openPty failed:", e);
      });
  }
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  await s.pty?.close();
  s.pty = null;
  s.snapshot = null;
  s.journalError = null;
  s.callbacks.onJournalError?.(null);
  s.journalRecords.clear();
  s.journalStarts = [];
  s.dormantRing = new DormantRing();
  s.shellExited = false;
  s.pendingExit = null;
  s.altScreenAtRelease = false;
  s.shellState.inCommand = false;

  const slot = getSlotForLeaf(leafId);
  if (slot) {
    slot.term.options.disableStdin = false;
    slot.term.clear();
    slot.term.reset();
  }
  // The old shell's blocks and their markers died with the reset buffer.
  s.blockStore?.reset();

  s.ptyOpening = true;
  let pty: PtySession;
  try {
    pty = await openPtyForSession(leafId, s, cwd ?? s.initialCwd);
  } catch (e) {
    s.ptyOpening = false;
    s.journalError = storageError(e, `${s.project}/.pi/terminal`);
    s.callbacks.onJournalError?.(s.journalError);
    throw e;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  s.pty = pty;
  s.project = pty.project;
  bindCommittedRecords(s);
  s.callbacks.onTerminalIdentity?.(pty);
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
}

export async function retryTerminalStorage(leafId: number): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return;
  if (s.pty) await s.pty.retry();
  else if (!s.ptyOpening) await respawnSession(leafId);
}

export async function terminalHistoryCanReplace(leafId: number): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return true;
  const busy = await invoke<boolean>("pty_has_foreground_process", { id: s.pty.id });
  if (!busy) return true;
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  return confirm("This terminal has a running process. Close it and open a fresh shell with the selected history?", { title: "Reopen terminal history", kind: "warning" });
}

export async function leafHasForegroundProcess(leafId: number): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  try {
    const result = await invoke<boolean>("pty_has_foreground_process", { id: s.pty.id });
    return result;
  } catch (e) {
    console.error("[terax] pty_has_foreground_process failed for leaf", leafId, e);
    return false;
  }
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  unbindLeafFromSlot(leafId, s);
  s.blockStore?.dispose();
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  sessions.delete(leafId);
  readyLeaves.delete(leafId);
  const waiters = readyWaiters.get(leafId);
  if (waiters) {
    readyWaiters.delete(leafId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onBlockStore?: (store: BlockStore | null) => void;
  onJournalError?: (error: StorageError | null) => void;
  onTerminalIdentity?: (identity: { terminalId: string; project: string }) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  onSearchReady,
  onExit,
  onCwd,
  onBlockStore,
  onJournalError,
  onTerminalIdentity,
}: Options) {
  const cbRef = useRef({ onSearchReady, onExit, onCwd, onBlockStore, onJournalError, onTerminalIdentity });
  cbRef.current = { onSearchReady, onExit, onCwd, onBlockStore, onJournalError, onTerminalIdentity };

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(leafId, initialCwd);
    s.ready.then(() => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) return;
      attachSession(leafId, node, {
        onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
        onExit: (c) => cbRef.current.onExit?.(c),
        onCwd: (c) => cbRef.current.onCwd?.(c),
        onBlockStore: (st) => cbRef.current.onBlockStore?.(st),
        onJournalError: (error) => cbRef.current.onJournalError?.(error),
        onTerminalIdentity: (identity) => cbRef.current.onTerminalIdentity?.(identity),
      });
      if (s.visibleNow && s.focusedNow) focusSlot(leafId);
    });
    return () => {
      cancelled = true;
      detachSession(leafId);
    };
  }, [leafId, container, initialCwd]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useEffect(() => {
    applyFontSize(Math.max(4, Math.round(fontSize * zoomLevel)));
  }, [fontSize, zoomLevel]);

  const fontFamily = usePreferencesStore((p) => p.terminalFontFamily);
  useEffect(() => {
    applyFontFamily(fontFamily);
  }, [fontFamily]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);
      setSlotFocused(leafId, focused);
      if (focused) focusSlot(leafId);
    } else if (s.hasSlot) {
      unbindLeafFromSlot(leafId, s);
    }
  }, [leafId, visible, focused]);

  const write = useCallback(
    (data: string) => sessions.get(leafId)?.pty?.write(data),
    [leafId],
  );

  const focus = useCallback(() => focusSlot(leafId), [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  return useMemo(
    () => ({ write, focus, getBuffer, getSelection, applyTheme }),
    [write, focus, getBuffer, getSelection, applyTheme],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
