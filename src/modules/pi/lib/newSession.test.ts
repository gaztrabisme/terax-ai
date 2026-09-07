import { beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { pickPiFolder, pickPiSessionFolder } from "./newSession";

describe("pickPiFolder", () => {
  beforeEach(() => {
    open.mockReset();
  });

  it("opens a single-choice directory dialog seeded with the default path", async () => {
    open.mockResolvedValue("/tmp/repo");
    await expect(pickPiFolder("/tmp")).resolves.toBe("/tmp/repo");
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: "/tmp",
    });
  });

  it("returns null on cancel", async () => {
    open.mockResolvedValue(null);
    await expect(pickPiFolder()).resolves.toBeNull();
  });

  it("normalizes Windows backslashes", async () => {
    open.mockResolvedValue("C:\\Users\\me\\repo");
    await expect(pickPiFolder()).resolves.toBe("C:/Users/me/repo");
  });

  it("treats a non-string pick (none from directory=false) as cancel", async () => {
    open.mockResolvedValue(undefined);
    await expect(pickPiFolder()).resolves.toBeNull();
  });
});

describe("pickPiSessionFolder", () => {
  beforeEach(() => {
    open.mockReset();
    invoke.mockReset();
  });

  it("authorizes the picked path and stores the canonical dir", async () => {
    open.mockResolvedValue("/tmp/standalone-proj");
    invoke.mockResolvedValue("/private/tmp/standalone-proj");
    await expect(pickPiSessionFolder("/tmp")).resolves.toEqual({
      status: "picked",
      dir: "/private/tmp/standalone-proj",
    });
    expect(invoke).toHaveBeenCalledWith("workspace_authorize", {
      path: "/tmp/standalone-proj",
      workspace: { kind: "local" },
    });
  });

  it("calls nothing on cancel", async () => {
    open.mockResolvedValue(null);
    await expect(pickPiSessionFolder()).resolves.toEqual({
      status: "cancelled",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a failed authorization instead of a dir", async () => {
    open.mockResolvedValue("/tmp/standalone-proj");
    invoke.mockRejectedValue("cwd not accessible: no such file");
    await expect(pickPiSessionFolder()).resolves.toEqual({
      status: "unauthorized",
      error: "cwd not accessible: no such file",
    });
  });
});
