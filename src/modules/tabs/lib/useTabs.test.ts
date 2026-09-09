// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import {
  resetStableIdsForTests,
  stableIdOf,
} from "@/modules/tabs/lib/sid";
import { resetUiStateForTests, uiStatePath } from "@/modules/state/uiState";
import { useTabs } from "./useTabs";

/** In-memory project files for the ui-state write assertions. */
function memoryFs() {
  const files = new Map<string, string>();
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const { path = "", content } = (args ?? {}) as {
      path?: string;
      content?: string;
    };
    if (cmd === "fs_create_dir") return undefined;
    if (cmd === "fs_read_file") {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return { kind: "text", content: files.get(path) };
    }
    if (cmd === "fs_write_file") {
      files.set(path, content ?? "");
      return undefined;
    }
    return { kind: "ok" };
  });
  return files;
}

function writes() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "fs_write_file") as [
    string,
    { path: string; content: string },
  ][];
}

beforeEach(() => {
  invoke.mockReset();
  resetStableIdsForTests();
  resetUiStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pi tab titles (UX2-08, G4)", () => {
  it("titles pi tabs by their project folder and keeps the bare name without one", () => {
    memoryFs();
    const { result } = renderHook(() => useTabs());
    act(() => result.current.newPiTab("/tmp/standalone-proj"));
    act(() => result.current.newPiTab());
    expect(result.current.tabs[1]).toMatchObject({
      kind: "pi",
      title: "pi: standalone-proj",
      cwd: "/tmp/standalone-proj",
    });
    expect(result.current.tabs[2]).toMatchObject({
      kind: "pi",
      title: "pi",
    });
  });
});

describe("useTabs stable ids (K11c)", () => {
  it("keeps batched chat and editor creation and selects the exact file", () => {
    memoryFs();
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.newPiTab("/proj");
      result.current.openFileTab("/proj/answer.md");
    });
    expect(result.current.tabs.map((tab) => tab.kind)).toEqual(["terminal", "pi", "editor"]);
    const editor = result.current.tabs[2];
    expect(editor).toMatchObject({ path: "/proj/answer.md", cwd: "/proj" });
    expect(result.current.activeId).toBe(editor.id);
    expect(stableIdOf(editor.id)).toBe(editor.sid);
  });

  it("mints a stable opaque id beside every numeric id at creation", () => {
    const { result } = renderHook(() => useTabs());
    const first = result.current.tabs[0];
    expect(first.sid).toMatch(/^[a-z0-9]{10}$/);
    expect(stableIdOf(first.id)).toBe(first.sid);

    act(() => result.current.newPiTab("/proj"));
    const pi = result.current.tabs[1];
    expect(pi.kind).toBe("pi");
    expect(pi.sid).toMatch(/^[a-z0-9]{10}$/);
    expect(pi.sid).not.toBe(first.sid);
    expect(stableIdOf(pi.id)).toBe(pi.sid);

    act(() => result.current.newTab());
    act(() => result.current.openFileTab("/proj/a.ts"));
    act(() => result.current.openBoardTab("/proj"));
    const kinds = result.current.tabs.map((t) => t.kind);
    expect(kinds).toEqual(["terminal", "pi", "terminal", "editor", "board"]);
    const sids = result.current.tabs.map((t) => t.sid);
    expect(new Set(sids).size).toBe(sids.length);
  });

  it("keeps the stable id across updates and close/reopen cycles", () => {
    const { result } = renderHook(() => useTabs());
    const initialSid = result.current.tabs[0].sid;
    act(() => result.current.updateTab(1, { title: "renamed" }));
    expect(result.current.tabs[0].sid).toBe(initialSid);

    act(() => result.current.newPiTab("/proj"));
    const piTab = result.current.tabs[1];
    act(() => result.current.closeTab(piTab.id));
    expect(result.current.tabs).toHaveLength(1);

    // A new tab for the same project mints a fresh id, never reuses one.
    act(() => result.current.newPiTab("/proj"));
    const reopened = result.current.tabs[1];
    expect(reopened.sid).toMatch(/^[a-z0-9]{10}$/);
    expect(reopened.sid).not.toBe(piTab.sid);
  });
});

describe("useTabs uiState window record (K11c)", () => {
  it("records the open tabs and active tab into the project's ui-state.json", async () => {
    vi.useFakeTimers();
    const files = memoryFs();
    const { result } = renderHook(() => useTabs());

    act(() => result.current.newPiTab("/proj"));
    const pi = result.current.tabs[1];
    act(() => result.current.openFileTab("/proj/a.ts"));
    const editor = result.current.tabs[2];
    expect(result.current.activeId).toBe(editor.id);

    await vi.advanceTimersByTimeAsync(750);
    const write = writes().find(([, a]) => a.path === uiStatePath("/proj"));
    expect(write).toBeTruthy();
    const doc = JSON.parse(write![1].content) as {
      windows: Record<
        string,
        { tabs: { id: string; kind: string; cwd?: string; path?: string }[]; activeTabId: string }
      >;
    };
    const win = doc.windows.main;
    expect(win.tabs).toEqual([
      { id: result.current.tabs[0].sid, kind: "terminal", cwd: undefined },
      { id: pi.sid, kind: "pi", cwd: "/proj" },
      { id: editor.sid, kind: "editor", path: "/proj/a.ts", cwd: "/proj" },
    ]);
    expect(win.activeTabId).toBe(editor.sid);
    expect(files.get(uiStatePath("/proj"))).toBeTruthy();
  });

  it("never records without a project tab and dedupes identical snapshots", async () => {
    vi.useFakeTimers();
    memoryFs();
    const { result } = renderHook(() => useTabs());

    // Terminal only: no project cwd, no record.
    await vi.advanceTimersByTimeAsync(750);
    expect(writes()).toHaveLength(0);

    act(() => result.current.newPiTab("/proj"));
    await vi.advanceTimersByTimeAsync(750);
    const afterFirst = writes().filter(
      ([, a]) => a.path === uiStatePath("/proj"),
    );
    expect(afterFirst).toHaveLength(1);

    // A tab title change does not alter the record: no second write.
    act(() => result.current.updateTab(result.current.tabs[1].id, { title: "x" }));
    await vi.advanceTimersByTimeAsync(750);
    expect(
      writes().filter(([, a]) => a.path === uiStatePath("/proj")),
    ).toHaveLength(1);
  });
});

describe("useTabs uiState recovery of written docs", () => {
  it("written windows parse back into a fresh store", async () => {
    vi.useFakeTimers();
    const files = memoryFs();
    const { result } = renderHook(() => useTabs());
    act(() => result.current.newPiTab("/proj"));
    act(() => result.current.openFileTab("/proj/a.ts"));
    const editorSid = result.current.tabs[2].sid;
    act(() => result.current.setActiveId(result.current.tabs[2].id));
    await vi.advanceTimersByTimeAsync(750);

    // Restart: a fresh store reading the same file sees the recorded window.
    resetStableIdsForTests();
    resetUiStateForTests();
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const { path = "" } = (args ?? {}) as { path?: string };
      if (cmd === "fs_create_dir") return undefined;
      if (cmd === "fs_read_file") {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return { kind: "text", content: files.get(path) };
      }
      return { kind: "ok" };
    });
    const { loadUiState, useUiStateStore } = await import(
      "@/modules/state/uiState"
    );
    await loadUiState("/proj");
    const doc = useUiStateStore.getState().docs["/proj"];
    expect(doc.windows.main.tabs.map((t) => [t.kind, t.path ?? t.cwd])).toEqual(
      [
        ["terminal", undefined],
        ["pi", "/proj"],
        ["editor", "/proj/a.ts"],
      ],
    );
    expect(doc.windows.main.activeTabId).toBe(editorSid as string);
  });
});
