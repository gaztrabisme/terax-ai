import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PI_LAYOUT,
  loadLayouts,
  PI_LAYOUT_STORAGE_KEY,
  parseLayouts,
  setLayoutStorageForTests,
  usePiLayoutStore,
} from "./layoutStore";

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    raw: () => map.get(PI_LAYOUT_STORAGE_KEY) ?? null,
  };
}

let backing: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  backing = fakeStorage();
  setLayoutStorageForTests(backing);
});

describe("layoutStore", () => {
  it("defaults: unknown cwds fall back to the default layout", () => {
    expect(loadLayouts()).toEqual({});
    expect(
      usePiLayoutStore.getState().layouts["/no/such/project"],
    ).toBeUndefined();
    const parsed = parseLayouts(null);
    expect(parsed).toEqual({});
    expect(DEFAULT_PI_LAYOUT).toEqual({
      rail: 30,
      railCollapsed: false,
      graph: 40,
      boardCollapsed: false,
      graphCollapsed: false,
      artifact: 25,
      artifactCollapsed: false,
    });
  });

  it("persists updates and round-trips them through storage", () => {
    usePiLayoutStore.getState().update("/a/project", { rail: 42 });
    expect(backing.raw()).not.toBeNull();

    const roundTripped = loadLayouts();
    expect(roundTripped["/a/project"]).toEqual({
      rail: 42,
      railCollapsed: false,
      graph: 40,
      boardCollapsed: false,
      graphCollapsed: false,
      artifact: 25,
      artifactCollapsed: false,
    });
    expect(usePiLayoutStore.getState().layouts["/a/project"]).toEqual(
      roundTripped["/a/project"],
    );
  });

  it("keeps entries independent per cwd", () => {
    usePiLayoutStore.getState().update("/a", { rail: 20 });
    usePiLayoutStore
      .getState()
      .update("/b", { rail: 60, graphCollapsed: true });
    expect(loadLayouts()["/a"].rail).toBe(20);
    expect(loadLayouts()["/b"].rail).toBe(60);
    expect(loadLayouts()["/b"].graphCollapsed).toBe(true);
    expect(loadLayouts()["/a"].graphCollapsed).toBe(false);
  });

  it("ignores corrupt JSON in storage", () => {
    setLayoutStorageForTests(
      fakeStorage({ [PI_LAYOUT_STORAGE_KEY]: "{not json" }),
    );
    expect(loadLayouts()).toEqual({});
  });

  it("ignores non-object payloads and sanitizes wrong-typed fields", () => {
    expect(parseLayouts("[1,2,3]")).toEqual({});
    expect(parseLayouts("42")).toEqual({});

    const layouts = parseLayouts(
      JSON.stringify({
        "/ok": { rail: "wide", graph: null, railCollapsed: 1 },
        "/bad": "nope",
      }),
    );
    expect(layouts["/ok"]).toEqual(DEFAULT_PI_LAYOUT);
    expect(layouts["/bad"]).toBeUndefined();
  });

  it("fills the artifact pane fields for layouts stored before it existed", () => {
    const layouts = parseLayouts(
      JSON.stringify({ "/legacy": { rail: 44, graph: 60 } }),
    );
    expect(layouts["/legacy"]).toEqual({
      rail: 44,
      railCollapsed: false,
      graph: 60,
      boardCollapsed: false,
      graphCollapsed: false,
      artifact: 25,
      artifactCollapsed: false,
    });
  });
});
