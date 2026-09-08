import { beforeEach, expect, it, vi } from "vitest";

// Same Tauri seams as preferences.terminalComposer.test.ts: the settings
// module talks to the plugin store on disk and mirrors writes through a
// Tauri event so other windows see them.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));

const { storeWrites, seedEntries, emitted } = vi.hoisted(() => ({
  storeWrites: [] as [string, unknown][],
  seedEntries: [] as [string, unknown][],
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async set(key: string, value: unknown) {
      storeWrites.push([key, value]);
    }
    async save() {}
    async entries() {
      return [...seedEntries];
    }
    async onChange() {
      return () => {};
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  }),
  listen: vi.fn(async () => () => {}),
}));

import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  MAX_RECENT_PROJECTS,
  recordProjectOpen,
  setLastProject,
  setRecentProjects,
} from "./store";

beforeEach(() => {
  seedEntries.length = 0;
  storeWrites.length = 0;
  emitted.length = 0;
});

it("defaults recentProjects to an empty list and lastProject to null", async () => {
  expect(MAX_RECENT_PROJECTS).toBe(10);
  expect(DEFAULT_PREFERENCES.recentProjects).toEqual([]);
  expect(DEFAULT_PREFERENCES.lastProject).toBeNull();

  const prefs = await loadPreferences();
  expect(prefs.recentProjects).toEqual([]);
  expect(prefs.lastProject).toBeNull();
});

it("keeps only string paths in stored order and caps the list", async () => {
  seedEntries.push([
    "recentProjects",
    [
      "/first",
      42,
      null,
      "/second",
      ...Array.from({ length: 12 }, (_, i) => `/p${i}`),
    ],
  ]);

  const prefs = await loadPreferences();
  expect(prefs.recentProjects).toEqual([
    "/first",
    "/second",
    ...Array.from({ length: 8 }, (_, i) => `/p${i}`),
  ]);
  expect(prefs.recentProjects).toHaveLength(MAX_RECENT_PROJECTS);
});

it("ignores a non-array recentProjects payload", async () => {
  seedEntries.push(["recentProjects", "nope"]);
  const prefs = await loadPreferences();
  expect(prefs.recentProjects).toEqual([]);
});

it("setRecentProjects persists the value capped at the maximum", async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `/p${i}`);
  await setRecentProjects(twelve);
  expect(storeWrites).toContainEqual([
    "recentProjects",
    twelve.slice(0, MAX_RECENT_PROJECTS),
  ]);
  expect(emitted).toContainEqual({
    event: "terax://prefs-changed",
    payload: {
      key: "recentProjects",
      value: twelve.slice(0, MAX_RECENT_PROJECTS),
    },
  });
});

it("setLastProject persists string and null values", async () => {
  await setLastProject("/a");
  expect(storeWrites).toContainEqual(["lastProject", "/a"]);
  await setLastProject(null);
  expect(storeWrites).toContainEqual(["lastProject", null]);
});

it("recordProjectOpen moves the cwd to the front and records lastProject", async () => {
  seedEntries.push(
    ["recentProjects", ["/a", "/b", "/c"]],
    ["lastProject", "/c"],
  );

  await recordProjectOpen("/c");
  expect(storeWrites).toContainEqual(["recentProjects", ["/c", "/a", "/b"]]);
  expect(storeWrites).toContainEqual(["lastProject", "/c"]);
  expect(emitted).toContainEqual({
    event: "terax://prefs-changed",
    payload: { key: "lastProject", value: "/c" },
  });
});

it("recordProjectOpen caps the list at ten, most recent first", async () => {
  seedEntries.push([
    "recentProjects",
    Array.from({ length: 10 }, (_, i) => `/p${i}`),
  ]);

  await recordProjectOpen("/new");
  expect(storeWrites).toContainEqual([
    "recentProjects",
    ["/new", "/p0", "/p1", "/p2", "/p3", "/p4", "/p5", "/p6", "/p7", "/p8"],
  ]);
});
