import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import {
  clearDraft,
  draftMetaPath,
  draftPath,
  loadDraft,
  loadDraftMeta,
  saveDraft,
  saveDraftMeta,
  type DraftMeta,
} from "./drafts";

describe("drafts", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("derives the draft path under <cwd>/.pi/drafts", () => {
    expect(draftPath("/home/me/proj", 7)).toBe("/home/me/proj/.pi/drafts/7.md");
    expect(draftPath("C:\\Users\\me\\proj", 3)).toBe(
      "C:\\Users\\me\\proj/.pi/drafts/3.md",
    );
  });

  it("round-trips save then load through the fs commands", async () => {
    invoke.mockImplementation(async (_cmd: string) => {
      if (_cmd === "fs_create_dir") return undefined;
      if (_cmd === "fs_write_file") return undefined;
      if (_cmd === "fs_read_file") {
        return { kind: "text", content: "# draft\nhello **pi**" };
      }
      throw new Error(`unexpected ${_cmd}`);
    });

    await saveDraft("/w", 7, "# draft");
    expect(invoke).toHaveBeenCalledWith("fs_write_file", {
      path: "/w/.pi/drafts/7.md",
      content: "# draft",
      workspace: { kind: "local" },
    });

    const md = await loadDraft("/w", 7);
    expect(md).toBe("# draft\nhello **pi**");
    expect(invoke).toHaveBeenCalledWith("fs_read_file", {
      path: "/w/.pi/drafts/7.md",
      workspace: { kind: "local" },
    });
  });

  it("creates the draft dir before the first write", async () => {
    invoke.mockResolvedValue(undefined);
    await saveDraft("/w", 1, "x");
    expect(invoke).toHaveBeenNthCalledWith(1, "fs_create_dir", {
      path: "/w/.pi/drafts",
      workspace: { kind: "local" },
    });
  });

  it("load returns null when the draft does not exist", async () => {
    invoke.mockRejectedValue(new Error("no such file"));
    expect(await loadDraft("/w", 9)).toBeNull();
  });

  it("load returns null for binary kinds", async () => {
    invoke.mockResolvedValue({ kind: "binary", size: 10 });
    expect(await loadDraft("/w", 9)).toBeNull();
  });

  it("clear swallows a missing file", async () => {
    invoke.mockRejectedValue(new Error("no such file"));
    await expect(clearDraft("/w", 5)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("fs_delete", {
      path: "/w/.pi/drafts/5.md",
      workspace: { kind: "local" },
    });
  });
});

describe("draft sidecar", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("derives the sidecar path next to the draft", () => {
    expect(draftMetaPath("/home/me/proj", 7)).toBe(
      "/home/me/proj/.pi/drafts/7.md.json",
    );
  });

  it("round-trips save then load and creates the dir first", async () => {
    const meta: DraftMeta = {
      v: 1,
      sources: [
        {
          blockId: 12,
          terminalId: 3,
          sha256: "abc123",
          insertedAt: "2026-09-08T10:00:00.000Z",
        },
      ],
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_create_dir") return undefined;
      if (cmd === "fs_write_file") return undefined;
      if (cmd === "fs_read_file") {
        return { kind: "text", content: JSON.stringify(meta) };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await saveDraftMeta("/w", 7, meta);
    expect(invoke).toHaveBeenNthCalledWith(1, "fs_create_dir", {
      path: "/w/.pi/drafts",
      workspace: { kind: "local" },
    });
    expect(invoke).toHaveBeenCalledWith("fs_write_file", {
      path: "/w/.pi/drafts/7.md.json",
      content: JSON.stringify(meta),
      workspace: { kind: "local" },
    });

    expect(await loadDraftMeta("/w", 7)).toEqual(meta);
    expect(invoke).toHaveBeenCalledWith("fs_read_file", {
      path: "/w/.pi/drafts/7.md.json",
      workspace: { kind: "local" },
    });
  });

  it("load returns null for missing, binary, malformed or foreign payloads", async () => {
    invoke.mockRejectedValue(new Error("no such file"));
    expect(await loadDraftMeta("/w", 1)).toBeNull();

    invoke.mockResolvedValue({ kind: "binary", size: 4 });
    expect(await loadDraftMeta("/w", 1)).toBeNull();

    invoke.mockResolvedValue({ kind: "text", content: "{not json" });
    expect(await loadDraftMeta("/w", 1)).toBeNull();

    invoke.mockResolvedValue({
      kind: "text",
      content: JSON.stringify({ v: 2, sources: [] }),
    });
    expect(await loadDraftMeta("/w", 1)).toBeNull();

    invoke.mockResolvedValue({
      kind: "text",
      content: JSON.stringify({
        v: 1,
        sources: [{ blockId: 1, terminalId: "x", sha256: "h" }],
      }),
    });
    expect(await loadDraftMeta("/w", 1)).toEqual({ v: 1, sources: [] });
  });

  it("clear removes the draft and the sidecar, swallowing missing files", async () => {
    invoke.mockRejectedValue(new Error("no such file"));
    await expect(clearDraft("/w", 5)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("fs_delete", {
      path: "/w/.pi/drafts/5.md",
      workspace: { kind: "local" },
    });
    expect(invoke).toHaveBeenCalledWith("fs_delete", {
      path: "/w/.pi/drafts/5.md.json",
      workspace: { kind: "local" },
    });
  });
});
