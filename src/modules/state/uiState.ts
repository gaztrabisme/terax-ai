import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { currentWorkspaceEnv } from "@/modules/workspace";

/**
 * Unit K11b: the project view-state file (docs/design.md section 3.4, row
 * "Layout and view state"). The committed document lives at
 * <project>/.pi/ui-state.json and is written through the same atomic
 * project-file write the drafts use (fs_write_file, temp file plus rename on
 * the Rust side). Browser storage may cache what this file holds, never
 * replace it, so the old localStorage layout bucket is imported once and then
 * ignored.
 */

export const UI_STATE_VERSION = 1;

/** Views whose panel widths the file remembers. */
export const UI_VIEWS = ["board", "graph", "sessions", "artifact"] as const;
export type UiView = (typeof UI_VIEWS)[number];

/** The localStorage bucket the pre-file layout store persisted to. */
export const PI_LAYOUT_STORAGE_KEY = "terax.pi.layout.v1";
/**
 * Marker written after the one-time import so the bucket is never read
 * again, even though browser storage may evict it at any time.
 */
export const PI_LAYOUT_IMPORTED_KEY = "terax.pi.layout.v1.imported";

export type UiViewWidths = Record<UiView, { widthCss: number | null }>;

/** Open modes a chat tab's view can be recorded in (design.md section 3.1). */
export const UI_VIEW_MODES = ["popover", "panel", "fullscreen"] as const;
export type UiViewMode = (typeof UI_VIEW_MODES)[number];

/**
 * One chat tab's recorded open view (F9 restore offer). The record exists
 * only while a view is open; a closed tab carries no entry, so views still
 * start closed by default.
 */
export type UiChatViewRecord = { view: string; mode: UiViewMode };

/**
 * How the previous app process ended, read from the file at load. Only the
 * app's own quit path (markCleanExit, App.tsx) writes "clean"; anything
 * else, including a missing or malformed field, counts as interrupted.
 */
export type UiLastExit = "clean" | "interrupted";

/**
 * One tab of a recorded window (K11c). `id` is the tab's stable opaque id,
 * never the numeric list position. `sessionId` is reserved for the pi session
 * locator a later unit records once K11a's manifest exposes it.
 */
export type UiTabRecord = {
  id: string;
  kind: string;
  cwd?: string;
  path?: string;
  sessionId?: string;
};

export type UiWindowState = {
  tabs: UiTabRecord[];
  activeTabId: string;
};

/** Window id of the single app window until multi-window lands. */
export const MAIN_WINDOW_ID = "main";

export type UiStateDoc = {
  v: 1;
  /** Open-tab records per window, written by the tab store (K11c). */
  windows: Record<string, UiWindowState>;
  views: UiViewWidths;
  sessionsQuery: string;
  folds: Record<string, boolean>;
  selectedArtifact: string | null;
  sidebarVisible: boolean;
  /**
   * Open chat-tab views per tab stable id (F9). The pi tab records every
   * transition through recordChatView; the entry is removed when the tab's
   * views close, so a fresh open always starts closed.
   */
  chatViews: Record<string, UiChatViewRecord>;
  /** How the previous process ended: "clean" only after markCleanExit. */
  lastExit: UiLastExit;
};

export function defaultUiState(): UiStateDoc {
  return {
    v: 1,
    windows: {},
    views: {
      board: { widthCss: null },
      graph: { widthCss: null },
      sessions: { widthCss: null },
      artifact: { widthCss: null },
    },
    sessionsQuery: "",
    folds: {},
    selectedArtifact: null,
    // design.md:160: the sidebar starts collapsed for every launch and no
    // background event restores a saved visibility flag.
    sidebarVisible: false,
    chatViews: {},
    // Without a file (or with a malformed one) the previous exit is treated
    // as interrupted; "clean" is only ever written through markCleanExit.
    lastExit: "interrupted",
  };
}

export type UiStatePatch = {
  views?: Partial<UiViewWidths>;
  windows?: Record<string, UiWindowState>;
  sessionsQuery?: string;
  folds?: Record<string, boolean>;
  selectedArtifact?: string | null;
  sidebarVisible?: boolean;
};

export type UiStateError = { path: string; message: string };

export function uiStateDir(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/.pi`;
}

export function uiStatePath(cwd: string): string {
  return `${uiStateDir(cwd)}/ui-state.json`;
}

function sanitizeWidths(raw: unknown): UiViewWidths {
  const views = defaultUiState().views;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return views;
  }
  const record = raw as Record<string, unknown>;
  for (const name of UI_VIEWS) {
    const width = (record[name] as { widthCss?: unknown } | null)?.widthCss;
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      views[name] = { widthCss: width };
    }
  }
  return views;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Keep only well-formed window records; anything else is dropped. */
export function sanitizeWindows(
  raw: unknown,
): Record<string, UiWindowState> {
  const windows: Record<string, UiWindowState> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return windows;
  }
  for (const [windowId, entry] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!nonEmptyString(windowId)) continue;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const value = entry as Record<string, unknown>;
    if (!Array.isArray(value.tabs) || !nonEmptyString(value.activeTabId)) {
      continue;
    }
    const tabs: UiTabRecord[] = [];
    for (const tab of value.tabs) {
      if (typeof tab !== "object" || tab === null || Array.isArray(tab)) {
        continue;
      }
      const t = tab as Record<string, unknown>;
      if (!nonEmptyString(t.id) || !nonEmptyString(t.kind)) continue;
      tabs.push({
        id: t.id,
        kind: t.kind,
        ...(nonEmptyString(t.cwd) && { cwd: t.cwd }),
        ...(nonEmptyString(t.path) && { path: t.path }),
        ...(nonEmptyString(t.sessionId) && { sessionId: t.sessionId }),
      });
    }
    windows[windowId] = { tabs, activeTabId: value.activeTabId };
  }
  return windows;
}

/** Parse and sanitize the file payload; unusable input yields null. */
export function parseUiState(raw: string | null): UiStateDoc | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const value = data as Record<string, unknown>;
  if (value.v !== UI_STATE_VERSION) return null;
  const doc = defaultUiState();
  doc.windows = sanitizeWindows(value.windows);
  doc.views = sanitizeWidths(value.views);
  if (typeof value.sessionsQuery === "string") {
    doc.sessionsQuery = value.sessionsQuery;
  }
  if (
    typeof value.folds === "object" &&
    value.folds !== null &&
    !Array.isArray(value.folds)
  ) {
    const folds: Record<string, boolean> = {};
    for (const [key, entry] of Object.entries(value.folds)) {
      if (typeof entry === "boolean") folds[key] = entry;
    }
    doc.folds = folds;
  }
  if (typeof value.selectedArtifact === "string") {
    doc.selectedArtifact = value.selectedArtifact;
  }
  if (typeof value.sidebarVisible === "boolean") {
    doc.sidebarVisible = value.sidebarVisible;
  }
  if (
    typeof value.chatViews === "object" &&
    value.chatViews !== null &&
    !Array.isArray(value.chatViews)
  ) {
    const chatViews: Record<string, UiChatViewRecord> = {};
    for (const [tabKey, record] of Object.entries(value.chatViews)) {
      if (!nonEmptyString(tabKey)) continue;
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        continue;
      }
      const r = record as Record<string, unknown>;
      if (
        nonEmptyString(r.view) &&
        UI_VIEW_MODES.includes(r.mode as UiViewMode)
      ) {
        chatViews[tabKey] = { view: r.view, mode: r.mode as UiViewMode };
      }
    }
    doc.chatViews = chatViews;
  }
  // Anything the file says other than exactly "clean" counts as interrupted.
  if (value.lastExit === "clean") doc.lastExit = "clean";
  return doc;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

let storage: StorageLike | null = defaultStorage();

/** Test seam: point the import at a fake storage (null disables it). */
export function setUiStateStorageForTests(next: StorageLike | null): void {
  storage = next;
}

let bucketConsumed = false;

type ImportedLayout = {
  views?: Partial<UiViewWidths>;
  sessionsQuery?: string;
};

/**
 * One-time import from the localStorage layout bucket: per-cwd panel widths
 * and the sessions query only, never visibility (docs/design.md:160). The
 * first call marks the bucket imported so it is never read again.
 */
function consumeLayoutBucketFor(cwd: string): ImportedLayout | null {
  if (bucketConsumed) return null;
  bucketConsumed = true;
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PI_LAYOUT_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  try {
    storage?.setItem(PI_LAYOUT_IMPORTED_KEY, "1");
  } catch {
    // Marking is best effort; the in-memory flag already stops re-reads.
  }
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const entry = (data as Record<string, unknown>)[cwd];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const value = entry as Record<string, unknown>;
  const imported: ImportedLayout = {};
  const views = sanitizeWidths(value.views);
  if (UI_VIEWS.some((name) => views[name].widthCss !== null)) {
    imported.views = views;
  }
  if (typeof value.sessionsQuery === "string") {
    imported.sessionsQuery = value.sessionsQuery;
  }
  return imported.views || imported.sessionsQuery !== undefined
    ? imported
    : null;
}

const SAVE_DEBOUNCE_MS = 250;

const touched = new Set<string>();
const queue: string[] = [];
const ensuredDirs = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function scheduleSave(cwd: string): void {
  touched.add(cwd);
  if (!queue.includes(cwd)) queue.push(cwd);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushSaves();
  }, SAVE_DEBOUNCE_MS);
}

async function writeDoc(cwd: string): Promise<void> {
  const path = uiStatePath(cwd);
  await loadUiState(cwd);
  if (!loaded.has(cwd)) throw new Error(`Could not load ${path} before saving`);
  if (!ensuredDirs.has(cwd)) {
    // fs_write_file renames within the target's parent, so `.pi` must exist
    // first (the same preamble the drafts use).
    try {
      await invoke("fs_create_dir", {
        path: uiStateDir(cwd),
        workspace: currentWorkspaceEnv(),
      });
    } catch {
      // The directory existing is the normal steady state.
    }
    ensuredDirs.add(cwd);
  }
  const doc = useUiStateStore.getState().docs[cwd] ?? defaultUiState();
  await invoke("fs_write_file", {
    path,
    content: JSON.stringify(doc),
    workspace: currentWorkspaceEnv(),
  });
}

function flushSaves(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // Only the entries queued when the flush started; edits made while it
      // runs schedule their own timer.
      let budget = queue.length;
      while (budget-- > 0 && queue.length > 0) {
        const cwd = queue[0];
        const path = uiStatePath(cwd);
        try {
          await writeDoc(cwd);
        } catch (error) {
          useUiStateStore.setState({
            error: { path, message: messageOf(error) },
          });
          // The failing entry stays queued; Retry flushes it.
          return;
        }
        queue.shift();
        touched.delete(cwd);
        const standing = useUiStateStore.getState().error;
        if (standing && standing.path === path) {
          useUiStateStore.setState({ error: null });
        }
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function retryUiStateSave(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flushSaves();
}

const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

function mergeDocs(base: UiStateDoc, overlay: UiStateDoc): UiStateDoc {
  return {
    ...base,
    ...overlay,
    windows: { ...base.windows, ...overlay.windows },
    views: { ...base.views, ...overlay.views },
    folds: { ...base.folds, ...overlay.folds },
    chatViews: { ...base.chatViews, ...overlay.chatViews },
  };
}

/**
 * Read once per cwd. Missing files use the one-time layout import or defaults.
 * Unreadable or invalid records stay on disk with a visible recovery error.
 */
export function loadUiState(cwd: string): Promise<void> {
  if (loaded.has(cwd)) return Promise.resolve();
  const pending = loading.get(cwd);
  if (pending) return pending;
  const load = readUiState(cwd).finally(() => loading.delete(cwd));
  loading.set(cwd, load);
  return load;
}

async function readUiState(cwd: string): Promise<void> {
  const path = uiStatePath(cwd);
  let parsed: UiStateDoc | null = null;
  try {
    const res = await invoke<{ kind: string; content?: string }>(
      "fs_read_file",
      { path, workspace: currentWorkspaceEnv() },
    );
    if (res.kind === "text" && typeof res.content === "string") {
      parsed = parseUiState(res.content);
    }
    if (!parsed) throw new Error("Invalid UI state record");
  } catch (error) {
    if (!/no such file|not found|os error [23]\b/i.test(String(error))) {
      useUiStateStore.setState({ error: { path, message: messageOf(error) } });
      return;
    }
  }
  const seeded = consumeLayoutBucketFor(cwd);
  const state = useUiStateStore.getState();
  const previous = state.docs[cwd];
  let base = defaultUiState();
  if (parsed) {
    base = parsed;
  } else if (seeded) {
    base = {
      ...base,
      views: { ...base.views, ...seeded.views },
      sessionsQuery: seeded.sessionsQuery ?? base.sessionsQuery,
    };
  }
  // Edits made before the read finished win over the file snapshot.
  let next = previous && touched.has(cwd) ? mergeDocs(base, previous) : base;
  // F9: the previous run's "clean" counts only at this load. This process is
  // live from here on, so the doc runs as interrupted until markCleanExit
  // fires; the flip is written so a later crash cannot inherit the clean.
  const staleClean = next.lastExit === "clean";
  if (staleClean) next = { ...next, lastExit: "interrupted" };
  loaded.add(cwd);
  useUiStateStore.setState({
    docs: { ...state.docs, [cwd]: next },
    error: state.error?.path === path ? null : state.error,
    cleanAtLoad: {
      ...useUiStateStore.getState().cleanAtLoad,
      [cwd]: parsed?.lastExit === "clean",
    },
  });
  if (!parsed || staleClean) scheduleSave(cwd); // startup reset, and the flip
}

export async function loadWindowState(cwd: string): Promise<UiWindowState | undefined> {
  await loadUiState(cwd);
  if (!loaded.has(cwd)) {
    throw new Error(`${uiStatePath(cwd)}: ${useUiStateStore.getState().error?.message ?? "Recovery failed"}`);
  }
  return useUiStateStore.getState().docs[cwd]?.windows[MAIN_WINDOW_ID];
}

type UiStateStore = {
  docs: Record<string, UiStateDoc>;
  error: UiStateError | null;
  /**
   * Per cwd: true only when the file's loaded lastExit was "clean" (F9). The
   * restore offer consults this, not the live doc, because readUiState flips
   * the in-memory value to interrupted for the running process.
   */
  cleanAtLoad: Record<string, boolean>;
  load: (cwd: string) => Promise<void>;
  update: (cwd: string, patch: UiStatePatch) => void;
  retry: () => Promise<void>;
};

export const useUiStateStore = create<UiStateStore>()(() => ({
  docs: {},
  error: null,
  cleanAtLoad: {},
  load: (cwd) => loadUiState(cwd),
  update: (cwd, patch) => {
    const state = useUiStateStore.getState();
    const previous = state.docs[cwd] ?? defaultUiState();
    const next: UiStateDoc = {
      ...previous,
      views: patch.views
        ? { ...previous.views, ...patch.views }
        : previous.views,
      windows: patch.windows
        ? { ...previous.windows, ...patch.windows }
        : previous.windows,
      sessionsQuery: patch.sessionsQuery ?? previous.sessionsQuery,
      folds: patch.folds
        ? { ...previous.folds, ...patch.folds }
        : previous.folds,
      selectedArtifact:
        patch.selectedArtifact !== undefined
          ? patch.selectedArtifact
          : previous.selectedArtifact,
      sidebarVisible: patch.sidebarVisible ?? previous.sidebarVisible,
    };
    useUiStateStore.setState({ docs: { ...state.docs, [cwd]: next } });
    scheduleSave(cwd);
  },
  retry: () => retryUiStateSave(),
}));

/**
 * Persistence delegation target for the localStorage layout store: it keeps
 * its API and hands the file-backed subset (widths, sessions query, sidebar
 * visibility) here once a project cwd is known.
 */
export function recordUiLayout(cwd: string, patch: UiStatePatch): void {
  if (!cwd) return;
  const views =
    patch.views && Object.keys(patch.views).length > 0
      ? patch.views
      : undefined;
  if (
    views === undefined &&
    patch.sessionsQuery === undefined &&
    patch.sidebarVisible === undefined
  ) {
    return;
  }
  useUiStateStore.getState().update(cwd, { ...patch, views });
}

/**
 * Input shape the tab store hands over for one window snapshot (K11c).
 */
export type WindowTabInput = {
  id: string;
  kind: string;
  cwd?: string;
  path?: string;
  sessionId?: string;
};

/** Last serialized window record per cwd: identical snapshots never rewrite. */
const lastWindows = new Map<string, string>();

/**
 * Record the open tabs of a window into the project's ui-state doc (K11c,
 * design.md row "Layout and view state"). Called by the tab store on every
 * tab change; a snapshot identical to the last one schedules no write.
 * Startup reads this record before creating project tabs.
 */
export function recordWindowTabs(
  cwd: string,
  tabs: WindowTabInput[],
  activeTabId: string,
  windowId: string = MAIN_WINDOW_ID,
): void {
  if (!cwd) return;
  const windowState: UiWindowState = {
    tabs: tabs.map((t) => ({ ...t })),
    activeTabId,
  };
  const serialized = JSON.stringify({ [windowId]: windowState });
  if (lastWindows.get(cwd) === serialized) return;
  lastWindows.set(cwd, serialized);
  useUiStateStore.getState().update(cwd, {
    windows: { [windowId]: windowState },
  });
}

/**
 * Records one chat tab's open view and mode into the project doc (F9). The
 * pi tab calls this on every view transition; `null` removes the tab's
 * entry so a closed tab never offers a stale restore. An identical record
 * schedules no write.
 */
export function recordChatView(
  cwd: string,
  tabKey: string,
  open: { view: string; mode: UiViewMode } | null,
): void {
  if (!cwd || !tabKey) return;
  const state = useUiStateStore.getState();
  const previous = state.docs[cwd];
  const current = previous?.chatViews ?? {};
  const entry = current[tabKey];
  const same =
    open === null
      ? entry === undefined
      : entry !== undefined &&
        entry.view === open.view &&
        entry.mode === open.mode;
  if (same) return;
  const chatViews: Record<string, UiChatViewRecord> = { ...current };
  if (open) chatViews[tabKey] = { view: open.view, mode: open.mode };
  else delete chatViews[tabKey];
  const doc: UiStateDoc = previous
    ? { ...previous, chatViews }
    : { ...defaultUiState(), chatViews };
  useUiStateStore.setState({ docs: { ...state.docs, [cwd]: doc } });
  scheduleSave(cwd);
}

/**
 * The app's own quit path (App.tsx registers it on the window close
 * request, whose handler the webview awaits before destroying): every
 * loaded project's doc is marked lastExit "clean" and flushed now, outside
 * the debounce. Process loss of any other kind leaves the interrupted
 * value this run started with on disk.
 */
export async function markCleanExit(): Promise<void> {
  const state = useUiStateStore.getState();
  const cwds = Object.keys(state.docs);
  if (cwds.length === 0) return;
  const docs: Record<string, UiStateDoc> = { ...state.docs };
  for (const cwd of cwds) docs[cwd] = { ...docs[cwd], lastExit: "clean" };
  useUiStateStore.setState({ docs });
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const cwd of cwds) {
    touched.add(cwd);
    if (!queue.includes(cwd)) queue.push(cwd);
  }
  await flushSaves();
}

/** Test seam: forget docs, pending writes, loaded cwds and the import flag. */
export function resetUiStateForTests(): void {
  loaded.clear();
  loading.clear();
  touched.clear();
  queue.length = 0;
  ensuredDirs.clear();
  bucketConsumed = false;
  lastWindows.clear();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  inFlight = null;
  useUiStateStore.setState({ docs: {}, error: null, cleanAtLoad: {} });
}
