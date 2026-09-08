import { beforeEach, expect, it, vi } from "vitest";

// Same Tauri seams as PiSection.test.tsx: the settings module talks to the
// plugin store on disk and mirrors writes through a Tauri event so other
// windows see them.
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
  setTerminalComposer,
} from "./store";

beforeEach(() => {
  seedEntries.length = 0;
  storeWrites.length = 0;
  emitted.length = 0;
});

it("defaults terminalComposer to false when the key is absent from stored preferences", async () => {
  expect(DEFAULT_PREFERENCES.terminalComposer).toBe(false);

  const prefs = await loadPreferences();
  expect(prefs.terminalComposer).toBe(false);
});

it("honours an explicitly stored terminalComposer of true", async () => {
  seedEntries.push(["terminalComposer", true]);

  const prefs = await loadPreferences();
  expect(prefs.terminalComposer).toBe(true);
});

it("setTerminalComposer persists the value and mirrors it to other windows", async () => {
  await setTerminalComposer(true);
  expect(storeWrites).toContainEqual(["terminalComposer", true]);
  expect(emitted).toContainEqual({
    event: "terax://prefs-changed",
    payload: { key: "terminalComposer", value: true },
  });

  await setTerminalComposer(false);
  expect(storeWrites).toContainEqual(["terminalComposer", false]);
  expect(emitted).toContainEqual({
    event: "terax://prefs-changed",
    payload: { key: "terminalComposer", value: false },
  });
});
