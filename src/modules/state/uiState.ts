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

export type UiStateDoc = {
  v: 1;
  /** Reserved for the window/tab tree; nothing writes it yet. */
  windows: Record<string, unknown>;
  views: UiViewWidths;
  sessionsQuery: string;
  folds: Record<string, boolean>;
  selectedArtifact: string | null;
  sidebarVisible: boolean;
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
  };
}

export type UiStatePatch = {
  views?: Partial<UiViewWidths>;
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
  if (
    typeof value.windows === "object" &&
    value.windows !== null &&
    !Array.isArray(value.windows)
  ) {
    doc.windows = { ...(value.windows as Record<string, unknown>) };
  }
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

function mergeDocs(base: UiStateDoc, overlay: UiStateDoc): UiStateDoc {
  return {
    ...base,
    ...overlay,
    views: { ...base.views, ...overlay.views },
    folds: { ...base.folds, ...overlay.folds },
  };
}

/**
 * Read <cwd>/.pi/ui-state.json once per cwd. A missing or unusable file
 * falls back to the one-time localStorage import, then to defaults, and
 * schedules the startup write so the file exists after the first open.
 */
export async function loadUiState(cwd: string): Promise<void> {
  if (loaded.has(cwd)) return;
  loaded.add(cwd);
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
  } catch {
    // First open on a fresh project has no file yet.
    parsed = null;
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
  const next = previous && touched.has(cwd) ? mergeDocs(base, previous) : base;
  useUiStateStore.setState({ docs: { ...state.docs, [cwd]: next } });
  if (!parsed) scheduleSave(cwd); // startup reset writes the fresh file
}

type UiStateStore = {
  docs: Record<string, UiStateDoc>;
  error: UiStateError | null;
  load: (cwd: string) => Promise<void>;
  update: (cwd: string, patch: UiStatePatch) => void;
  retry: () => Promise<void>;
};

export const useUiStateStore = create<UiStateStore>()(() => ({
  docs: {},
  error: null,
  load: (cwd) => loadUiState(cwd),
  update: (cwd, patch) => {
    const state = useUiStateStore.getState();
    const previous = state.docs[cwd] ?? defaultUiState();
    const next: UiStateDoc = {
      ...previous,
      views: patch.views
        ? { ...previous.views, ...patch.views }
        : previous.views,
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

/** Test seam: forget docs, pending writes, loaded cwds and the import flag. */
export function resetUiStateForTests(): void {
  loaded.clear();
  touched.clear();
  queue.length = 0;
  ensuredDirs.clear();
  bucketConsumed = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  inFlight = null;
  useUiStateStore.setState({ docs: {}, error: null });
}
