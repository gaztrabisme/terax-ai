import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { clearDraft, draftPath, loadDraft, saveDraft } from "./drafts";

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
