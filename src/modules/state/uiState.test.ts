import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { UAT_IDS_K11_STATEFUL } from "@/lib/uatIds";
import {
  defaultUiState,
  parseUiState,
  PI_LAYOUT_IMPORTED_KEY,
  PI_LAYOUT_STORAGE_KEY,
  recordWindowTabs,
  resetUiStateForTests,
  setUiStateStorageForTests,
  uiStatePath,
  useUiStateStore,
  type UiTabRecord,
} from "./uiState";

const WORKSPACE = { kind: "local" } as const;

/** In-memory project files backing fs_read_file / fs_write_file. */
function fakeProjectFiles() {
  const files = new Map<string, string>();
  invoke.mockImplementation(
    async (cmd: string, args: { path?: string; content?: string }) => {
      if (cmd === "fs_create_dir") return undefined;
      if (cmd === "fs_read_file") {
        const key = args.path ?? "";
        if (!files.has(key)) throw new Error(`no such file: ${key}`);
        return { kind: "text", content: files.get(key) };
      }
      if (cmd === "fs_write_file") {
        files.set(args.path ?? "", args.content ?? "");
        return undefined;
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  );
  return files;
}

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function writes() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "fs_write_file");
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  resetUiStateForTests();
  setUiStateStorageForTests(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("uiState round trip", () => {
  it("writes the debounced doc through the drafts' fs commands and reloads it", async () => {
    const files = fakeProjectFiles();
    await useUiStateStore.getState().load("/w");

    // Startup reset: a fresh project gets its file right after the open.
    await vi.advanceTimersByTimeAsync(250);
    expect(invoke).toHaveBeenNthCalledWith(2, "fs_create_dir", {
      path: "/w/.pi",
      workspace: WORKSPACE,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "fs_write_file", {
      path: "/w/.pi/ui-state.json",
      content: JSON.stringify(defaultUiState()),
      workspace: WORKSPACE,
    });

    useUiStateStore.getState().update("/w", {
      views: { board: { widthCss: 360 }, graph: { widthCss: 420 } },
      sessionsQuery: "auth flow",
      folds: { "turn-1": true },
      selectedArtifact: "doc-2",
      sidebarVisible: true,
    });
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(250);
    expect(writes()).toHaveLength(1);
    const written = JSON.parse(files.get(uiStatePath("/w")) ?? "null");
    expect(written).toMatchObject({
      v: 1,
      sessionsQuery: "auth flow",
      folds: { "turn-1": true },
      selectedArtifact: "doc-2",
      sidebarVisible: true,
    });
    expect(written.views.board).toEqual({ widthCss: 360 });
    expect(written.views.graph).toEqual({ widthCss: 420 });
    expect(useUiStateStore.getState().error).toBeNull();

    // Restart: fresh memory, same file.
    resetUiStateForTests();
    await useUiStateStore.getState().load("/w");
    expect(useUiStateStore.getState().docs["/w"]).toEqual({
      v: 1,
      windows: {},
      views: {
        board: { widthCss: 360 },
        graph: { widthCss: 420 },
        sessions: { widthCss: null },
        artifact: { widthCss: null },
      },
      sessionsQuery: "auth flow",
      folds: { "turn-1": true },
      selectedArtifact: "doc-2",
      sidebarVisible: true,
    });
  });

  it("loads a cwd once per session", async () => {
    fakeProjectFiles();
    await Promise.all([
      useUiStateStore.getState().load("/w"),
      useUiStateStore.getState().load("/w"),
    ]);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "fs_read_file"),
    ).toHaveLength(1);
  });

  it("keeps unrelated file fields when an edit lands after the load", async () => {
    const files = fakeProjectFiles();
    files.set(
      uiStatePath("/w"),
      JSON.stringify({
        v: 1,
        views: { sessions: { widthCss: 500 } },
        sessionsQuery: "from file",
        folds: { kept: true },
      }),
    );
    await useUiStateStore.getState().load("/w");
    useUiStateStore.getState().update("/w", { sessionsQuery: "edited" });
    await vi.advanceTimersByTimeAsync(250);
    const written = JSON.parse(files.get(uiStatePath("/w")) ?? "null");
    expect(written.sessionsQuery).toBe("edited");
    expect(written.views.sessions).toEqual({ widthCss: 500 });
    expect(written.folds).toEqual({ kept: true });
  });
});

describe("uiState debounce", () => {
  it("coalesces rapid edits into one write carrying the merged state", async () => {
    fakeProjectFiles();
    await useUiStateStore.getState().load("/w");
    invoke.mockClear();
    useUiStateStore.getState().update("/w", { sessionsQuery: "fi" });
    useUiStateStore.getState().update("/w", {
      sessionsQuery: "first",
      views: { graph: { widthCss: 420 } },
    });
    await vi.advanceTimersByTimeAsync(240);
    expect(writes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes()).toHaveLength(1);
    const doc = JSON.parse(writes()[0][1].content as string);
    expect(doc.sessionsQuery).toBe("first");
    expect(doc.views.graph).toEqual({ widthCss: 420 });
  });
});

describe("uiState localStorage import", () => {
  it("imports widths and the query once, never visibility", async () => {
    const backing = fakeStorage({
      [PI_LAYOUT_STORAGE_KEY]: JSON.stringify({
        "/w": {
          views: { board: { widthCss: 420 }, sessions: { widthCss: 300 } },
          sessionsQuery: "alpha",
          railCollapsed: true,
          rail: 77,
          graphCollapsed: true,
        },
        "/other": {
          views: { graph: { widthCss: 999 } },
          sessionsQuery: "beta",
        },
      }),
    });
    setUiStateStorageForTests(backing);
    fakeProjectFiles();

    await useUiStateStore.getState().load("/w");
    const doc = useUiStateStore.getState().docs["/w"];
    expect(doc.views.board).toEqual({ widthCss: 420 });
    expect(doc.views.sessions).toEqual({ widthCss: 300 });
    expect(doc.sessionsQuery).toBe("alpha");
    expect(doc.sidebarVisible).toBe(false);
    expect(doc).not.toHaveProperty("rail");
    expect(backing.map.get(PI_LAYOUT_IMPORTED_KEY)).toBe("1");

    // The bucket is never read again: the later open imports nothing.
    backing.map.set(
      PI_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        "/other": { views: { graph: { widthCss: 1 } }, sessionsQuery: "nope" },
      }),
    );
    await useUiStateStore.getState().load("/other");
    expect(useUiStateStore.getState().docs["/other"]).toEqual(defaultUiState());
  });

  it("prefers the committed file over the bucket and skips the startup write", async () => {
    setUiStateStorageForTests(
      fakeStorage({
        [PI_LAYOUT_STORAGE_KEY]: JSON.stringify({
          "/w": { views: { board: { widthCss: 999 } } },
        }),
      }),
    );
    const files = fakeProjectFiles();
    files.set(
      uiStatePath("/w"),
      JSON.stringify({
        v: 1,
        views: { board: { widthCss: 360 } },
        sessionsQuery: "from file",
      }),
    );

    await useUiStateStore.getState().load("/w");
    expect(useUiStateStore.getState().docs["/w"].views.board).toEqual({
      widthCss: 360,
    });
    expect(useUiStateStore.getState().docs["/w"].sessionsQuery).toBe(
      "from file",
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(writes()).toHaveLength(0);
  });

  it("treats corrupt and wrong-version files as absent", async () => {
    const files = fakeProjectFiles();
    files.set(uiStatePath("/w"), "{not json");
    await useUiStateStore.getState().load("/w");
    expect(useUiStateStore.getState().docs["/w"]).toEqual(defaultUiState());

    files.set(uiStatePath("/v"), JSON.stringify({ v: 2 }));
    await useUiStateStore.getState().load("/v");
    expect(useUiStateStore.getState().docs["/v"]).toEqual(defaultUiState());

    expect(parseUiState(null)).toBeNull();
    expect(parseUiState("42")).toBeNull();
    expect(
      parseUiState(
        JSON.stringify({
          v: 1,
          views: { board: { widthCss: -5 } },
          sessionsQuery: 9,
          folds: { a: "yes", b: false },
          selectedArtifact: 7,
          sidebarVisible: "true",
        }),
      ),
    ).toEqual(Object.assign(defaultUiState(), { folds: { b: false } }));
  });
});

describe("uiState windows record (K11c)", () => {
  it("records the window's tabs and active tab, keeping other fields", async () => {
    const files = fakeProjectFiles();
    files.set(
      uiStatePath("/w"),
      JSON.stringify({
        v: 1,
        views: { board: { widthCss: 360 } },
        sessionsQuery: "kept",
      }),
    );
    await useUiStateStore.getState().load("/w");

    const tabs: UiTabRecord[] = [
      { id: "term1a", kind: "terminal", cwd: "/w" },
      { id: "pita8b2", kind: "pi", cwd: "/w" },
      { id: "ed1tor3", kind: "editor", path: "/w/src/a.ts" },
    ];
    recordWindowTabs("/w", tabs, "pita8b2");
    await vi.advanceTimersByTimeAsync(250);
    const written = JSON.parse(files.get(uiStatePath("/w")) ?? "null");
    expect(written.windows.main).toEqual({
      tabs,
      activeTabId: "pita8b2",
    });
    expect(written.views.board).toEqual({ widthCss: 360 });
    expect(written.sessionsQuery).toBe("kept");

    // A second open sees the same window record from the file.
    resetUiStateForTests();
    await useUiStateStore.getState().load("/w");
    expect(useUiStateStore.getState().docs["/w"].windows.main).toEqual({
      tabs,
      activeTabId: "pita8b2",
    });
  });

  it("skips the write when the window snapshot is unchanged", async () => {
    fakeProjectFiles();
    await useUiStateStore.getState().load("/w");
    invoke.mockClear();
    const tabs: UiTabRecord[] = [{ id: "pita8b2", kind: "pi", cwd: "/w" }];
    recordWindowTabs("/w", tabs, "pita8b2");
    await vi.advanceTimersByTimeAsync(250);
    expect(writes()).toHaveLength(1);

    recordWindowTabs("/w", tabs.map((t) => ({ ...t })), "pita8b2");
    await vi.advanceTimersByTimeAsync(250);
    expect(writes()).toHaveLength(1);

    recordWindowTabs("/w", tabs, "term1a");
    await vi.advanceTimersByTimeAsync(250);
    expect(writes()).toHaveLength(2);
  });

  it("sanitizes windows from the file: shape-valid rows survive, junk drops", async () => {
    const files = fakeProjectFiles();
    files.set(
      uiStatePath("/w"),
      JSON.stringify({
        v: 1,
        windows: {
          main: {
            tabs: [
              { id: "pita8b2", kind: "pi", cwd: "/w", sessionId: "s-1" },
              { id: 7, kind: "terminal" },
              { kind: "editor" },
              { id: "ed1tor3", kind: "editor", path: "/w/a.ts", cwd: 9 },
              "junk",
            ],
            activeTabId: "pita8b2",
          },
          broken: { tabs: "nope", activeTabId: "x" },
          "": { tabs: [], activeTabId: "x" },
        },
      }),
    );
    await useUiStateStore.getState().load("/w");
    const doc = useUiStateStore.getState().docs["/w"];
    expect(doc.windows.main).toEqual({
      tabs: [
        { id: "pita8b2", kind: "pi", cwd: "/w", sessionId: "s-1" },
        // id and kind are required; a malformed optional field only drops
        // that field, never the row.
        { id: "ed1tor3", kind: "editor", path: "/w/a.ts" },
      ],
      activeTabId: "pita8b2",
    });
    expect(doc.windows.broken).toBeUndefined();
    expect(doc.windows[""]).toBeUndefined();
  });
});

describe("uiState write failure", () => {
  it("surfaces path and message, keeps the edit unsaved, and clears on Retry", async () => {
    let failWrites = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_create_dir") return undefined;
      if (cmd === "fs_write_file") {
        if (failWrites) throw "disk full"; // Tauri rejects with strings
        return undefined;
      }
      if (cmd === "fs_read_file") throw new Error("no such file");
      throw new Error(`unexpected command: ${cmd}`);
    });

    await useUiStateStore.getState().load("/w");
    useUiStateStore.getState().update("/w", { sessionsQuery: "keep me" });
    await vi.advanceTimersByTimeAsync(250);
    expect(useUiStateStore.getState().error).toEqual({
      path: "/w/.pi/ui-state.json",
      message: "disk full",
    });
    // The edit stays in the doc while the error stands: no saved state.
    expect(useUiStateStore.getState().docs["/w"].sessionsQuery).toBe("keep me");

    failWrites = false;
    await useUiStateStore.getState().retry();
    expect(useUiStateStore.getState().error).toBeNull();
    expect(writes().length).toBeGreaterThan(0);
    expect(
      JSON.parse(
        invoke.mock.calls.find(([cmd]) => cmd === "fs_write_file")![1]
          .content as string,
      ).sessionsQuery,
    ).toBe("keep me");
  });
});

describe("K11b UAT ids", () => {
  it("marks the stateful banner ids on the pi tab source", () => {
    const root = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const files = new Set(UAT_IDS_K11_STATEFUL.map((entry) => entry.file));
    for (const entry of UAT_IDS_K11_STATEFUL) {
      const source = readFileSync(path.join(root, entry.file), "utf8");
      expect(source).toContain(`data-uat="${entry.id}"`);
      expect(entry.state.length).toBeGreaterThan(0);
    }
    expect(files.size).toBe(1);
  });
});
