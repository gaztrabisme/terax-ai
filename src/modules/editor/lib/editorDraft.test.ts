import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import {
  createEditorDraftController,
  windowProjectCwd,
  type EditorDraftUiState,
} from "./editorDraft";

const WORKSPACE = { kind: "local" } as const;

function memoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  invoke.mockImplementation(
    async (
      cmd: string,
      args?: { path?: string; content?: string; showHidden?: boolean },
    ) => {
      const path = args?.path ?? "";
      if (cmd === "fs_create_dir") {
        dirs.add(path);
        return undefined;
      }
      if (cmd === "fs_write_file") {
        files.set(path, args?.content ?? "");
        return undefined;
      }
      if (cmd === "fs_read_file") {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return { kind: "text", content: files.get(path) };
      }
      if (cmd === "fs_delete") {
        files.delete(path);
        return undefined;
      }
      if (cmd === "fs_read_dir") {
        const exists =
          dirs.has(path) ||
          [...files.keys()].some((p) => p.startsWith(`${path}/`));
        return exists
          ? [...files.keys()]
              .filter(
                (p) =>
                  p.startsWith(`${path}/`) &&
                  !p.slice(path.length + 1).includes("/"),
              )
              .map((p) => ({
                name: p.slice(path.length + 1),
                kind: "file",
                size: 1,
                mtime: 0,
              }))
          : [];
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  );
  return files;
}

beforeEach(() => {
  invoke.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("windowProjectCwd", () => {
  it("picks the first project-scoped cwd in tab order", () => {
    expect(
      windowProjectCwd([
        { kind: "terminal", cwd: "/somewhere/shell" },
        { kind: "editor", path: "/w/a.ts" },
        { kind: "pi", cwd: "/w" },
      ]),
    ).toBe("/w");
    expect(
      windowProjectCwd([
        { kind: "terminal", cwd: "/x" },
        { kind: "board", cwd: "/b" },
        { kind: "pi", cwd: "/p" },
      ]),
    ).toBe("/b");
    expect(windowProjectCwd([{ kind: "terminal", cwd: "/x" }])).toBeNull();
    expect(windowProjectCwd([])).toBeNull();
  });
});

describe("editor draft controller", () => {
  const DISK = "saved content\n";
  const BUFFER = "saved content\nplus an unsaved line\n";

  function setup(files: Map<string, string>, disk = DISK) {
    files.set("/w/src/a.ts", disk);
    const states: EditorDraftUiState[] = [];
    const controller = createEditorDraftController({
      cwd: "/w",
      path: "/w/src/a.ts",
      sid: "tabown1",
      isDirty: () => dirty,
      onState: (s) => states.push(s),
    });
    let dirty = false;
    const setDirty = (d: boolean) => {
      dirty = d;
    };
    return { controller, states, setDirty, dirtyRef: () => dirty };
  }

  it("recover captures the base hash and returns null without a draft", async () => {
    const files = memoryFs();
    const { controller } = setup(files);
    const rec = await controller.recover(DISK);
    expect(rec).toBeNull();

    // A clean load right after: onClean drops nothing and reports clean.
    await controller.onClean();
    expect(invoke).not.toHaveBeenCalledWith("fs_write_file", {
      path: "/w/.pi/drafts/tabown1.md",
      content: DISK,
      workspace: WORKSPACE,
    });
  });

  it("recover restores the draft buffer with its record and flags recovered", async () => {
    const files = memoryFs();
    files.set(
      "/w/.pi/drafts/oldsid1.json",
      JSON.stringify({
        v: 1,
        kind: "editor",
        path: "/w/src/a.ts",
        baseSha256: await (await import("@/modules/pi/lib/drafts")).sha256Hex(
          DISK,
        ),
      }),
    );
    files.set("/w/.pi/drafts/oldsid1.md", BUFFER);

    const { controller, states } = setup(files);
    const rec = await controller.recover(DISK);
    expect(rec?.content).toBe(BUFFER);
    expect(rec?.draftId).toBe("oldsid1");
    expect(rec?.baseSha256).toBeTruthy();
    expect(states[states.length - 1]).toEqual({
      recovered: true,
      conflict: null,
    });
  });

  it("a draft identical to the file on disk is stale and gets cleared", async () => {
    const { sha256Hex } = await import("@/modules/pi/lib/drafts");
    const files = memoryFs();
    files.set(
      "/w/.pi/drafts/oldsid1.json",
      JSON.stringify({
        v: 1,
        kind: "editor",
        path: "/w/src/a.ts",
        baseSha256: await sha256Hex(DISK),
      }),
    );
    files.set("/w/.pi/drafts/oldsid1.md", DISK);

    const { controller } = setup(files);
    expect(await controller.recover(DISK)).toBeNull();
    expect(files.has("/w/.pi/drafts/oldsid1.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/oldsid1.json")).toBe(false);
  });

  it("beforeWrite refuses with both paths when the file changed on disk", async () => {
    const { sha256Hex, draftPath } = await import(
      "@/modules/pi/lib/drafts"
    );
    const files = memoryFs();
    files.set(
      "/w/.pi/drafts/tabown1.json",
      JSON.stringify({
        v: 1,
        kind: "editor",
        path: "/w/src/a.ts",
        baseSha256: await sha256Hex(DISK),
      }),
    );
    files.set("/w/.pi/drafts/tabown1.md", BUFFER);
    const { controller, states, setDirty } = setup(files);
    await controller.recover(DISK);

    // The file changes externally while the buffer is unsaved.
    files.set("/w/src/a.ts", "externally rewritten\n");
    setDirty(true);
    const allowed = await controller.beforeWrite();
    expect(allowed).toBe(false);
    expect(states[states.length - 1]?.conflict).toEqual({
      path: "/w/src/a.ts",
      draftPath: draftPath("/w", "tabown1"),
    });

    // The refusal wrote nothing through to the file.
    expect(files.get("/w/src/a.ts")).toBe("externally rewritten\n");

    // Once the disk matches the base hash again, the write is allowed.
    files.set("/w/src/a.ts", DISK);
    expect(await controller.beforeWrite()).toBe(true);
  });

  it("onWritten clears the draft and the recovered state", async () => {
    const { sha256Hex } = await import("@/modules/pi/lib/drafts");
    const files = memoryFs();
    files.set(
      "/w/.pi/drafts/tabown1.json",
      JSON.stringify({
        v: 1,
        kind: "editor",
        path: "/w/src/a.ts",
        baseSha256: await sha256Hex(DISK),
      }),
    );
    files.set("/w/.pi/drafts/tabown1.md", BUFFER);
    const { controller, states } = setup(files);
    await controller.recover(DISK);
    expect(files.has("/w/.pi/drafts/tabown1.md")).toBe(true);

    await controller.onWritten();
    expect(files.has("/w/.pi/drafts/tabown1.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/tabown1.json")).toBe(false);
    expect(states[states.length - 1]).toEqual({ recovered: false, conflict: null });
  });

  it("scheduleSave mirrors the buffer debounced while dirty", async () => {
    const { sha256Hex } = await import("@/modules/pi/lib/drafts");
    const files = memoryFs();
    const { controller, setDirty } = setup(files);
    await controller.recover(DISK);
    invoke.mockClear();

    setDirty(true);
    controller.scheduleSave(BUFFER);
    await vi.advanceTimersByTimeAsync(400);
    expect(files.has("/w/.pi/drafts/tabown1.md")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(files.get("/w/.pi/drafts/tabown1.md")).toBe(BUFFER);
    const record = JSON.parse(
      files.get("/w/.pi/drafts/tabown1.json") ?? "null",
    ) as { v: number; kind: string; path: string; baseSha256: string };
    expect(record).toEqual({
      v: 1,
      kind: "editor",
      path: "/w/src/a.ts",
      baseSha256: await sha256Hex(DISK),
    });

    // A clean buffer schedules nothing: the mirror is for unsaved work only.
    invoke.mockClear();
    setDirty(false);
    controller.scheduleSave(DISK);
    await vi.advanceTimersByTimeAsync(750);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "fs_write_file"),
    ).toHaveLength(0);
  });
});
