import { useCallback, useState } from "react";
import { create } from "zustand";
import { CHAT_VIEWS, type ChatView } from "./viewMachine";

/** localStorage bucket holding per-cwd pi layouts. */
export const PI_LAYOUT_STORAGE_KEY = "terax.pi.layout.v1";

export type PiLayout = {
  views: Record<ChatView, { widthCss: number | null }>;
  sessionsQuery: string;
  /** Rail width as a percentage of the horizontal [chat | rail] group. */
  rail: number;
  railCollapsed: boolean;
  /**
   * Run-graph height as a percentage of the vertical
   * [graph | board | artifact] group; the board takes the remainder.
   */
  graph: number;
  boardCollapsed: boolean;
  graphCollapsed: boolean;
  /** Artifact pane height as a percentage of the same vertical group. */
  artifact: number;
  artifactCollapsed: boolean;
};

export const DEFAULT_PI_LAYOUT: PiLayout = {
  views: {
    board: { widthCss: null },
    graph: { widthCss: null },
    sessions: { widthCss: null },
    artifact: { widthCss: null },
  },
  sessionsQuery: "",
  rail: 30,
  railCollapsed: false,
  graph: 40,
  boardCollapsed: false,
  graphCollapsed: false,
  artifact: 25,
  artifactCollapsed: false,
};

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

/** Test seam: point persistence at a fake storage (null disables it). */
export function setLayoutStorageForTests(next: StorageLike | null): void {
  storage = next;
}

function num(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/** Parse + sanitize a raw payload; corrupt input yields {} (all defaults). */
export function parseLayouts(raw: string | null): Record<string, PiLayout> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {};
  }
  const out: Record<string, PiLayout> = {};
  for (const [cwd, value] of Object.entries(data)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const v = value as Record<string, unknown>;
    const views = { ...DEFAULT_PI_LAYOUT.views };
    for (const view of CHAT_VIEWS) {
      const rawView = (v.views as Record<string, unknown> | null)?.[view];
      const width = (rawView as { widthCss?: unknown } | null)?.widthCss;
      views[view] = {
        widthCss:
          typeof width === "number" && Number.isFinite(width) && width > 0
            ? width
            : null,
      };
    }
    out[cwd] = {
      views,
      sessionsQuery: typeof v.sessionsQuery === "string" ? v.sessionsQuery : "",
      rail: num(v.rail, DEFAULT_PI_LAYOUT.rail, 0, 100),
      railCollapsed: bool(v.railCollapsed, DEFAULT_PI_LAYOUT.railCollapsed),
      graph: num(v.graph, DEFAULT_PI_LAYOUT.graph, 0, 100),
      boardCollapsed: bool(v.boardCollapsed, DEFAULT_PI_LAYOUT.boardCollapsed),
      graphCollapsed: bool(v.graphCollapsed, DEFAULT_PI_LAYOUT.graphCollapsed),
      artifact: num(v.artifact, DEFAULT_PI_LAYOUT.artifact, 0, 100),
      artifactCollapsed: bool(
        v.artifactCollapsed,
        DEFAULT_PI_LAYOUT.artifactCollapsed,
      ),
    };
  }
  return out;
}

export function loadLayouts(): Record<string, PiLayout> {
  try {
    return parseLayouts(storage?.getItem(PI_LAYOUT_STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

function persistLayouts(layouts: Record<string, PiLayout>): void {
  try {
    storage?.setItem(PI_LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // Storage can be unavailable (private mode / quota); layout still applies.
  }
}

export type PiLayoutPatch = Partial<Omit<PiLayout, "views">> & {
  views?: Partial<PiLayout["views"]>;
};

type PiLayoutStore = {
  layouts: Record<string, PiLayout>;
  update: (cwd: string, patch: PiLayoutPatch) => void;
};

export const usePiLayoutStore = create<PiLayoutStore>()((set) => ({
  layouts: loadLayouts(),
  update: (cwd, patch) =>
    set((s) => {
      const previous = s.layouts[cwd] ?? DEFAULT_PI_LAYOUT;
      const next = {
        ...previous,
        ...patch,
        views: { ...previous.views, ...patch.views },
      };
      const layouts = { ...s.layouts, [cwd]: next };
      persistLayouts(layouts);
      return { layouts };
    }),
}));

/** Per-cwd view over the store; unknown cwds fall back to the default. */
export function usePiLayout(cwd?: string) {
  const [localLayout, setLocalLayout] = useState(DEFAULT_PI_LAYOUT);
  const layouts = usePiLayoutStore((s) => s.layouts);
  const update = usePiLayoutStore((s) => s.update);
  const layout =
    cwd === undefined ? localLayout : (layouts[cwd] ?? DEFAULT_PI_LAYOUT);
  const updateLayout = useCallback(
    (patch: PiLayoutPatch) => {
      if (cwd !== undefined) update(cwd, patch);
      else
        setLocalLayout((previous) => ({
          ...previous,
          ...patch,
          views: { ...previous.views, ...patch.views },
        }));
    },
    [cwd, update],
  );
  return { layout, update: updateLayout };
}
