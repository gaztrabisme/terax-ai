import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { consumeLaunchPi, getLaunchDir, initLaunchDir } from "./launchDir";

describe("consumeLaunchPi", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("invokes get_launch_pi and forwards a true flag", async () => {
    invoke.mockResolvedValue(true);
    await expect(consumeLaunchPi()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("get_launch_pi");
  });

  it("returns false when the backend has no flag", async () => {
    invoke.mockResolvedValue(false);
    await expect(consumeLaunchPi()).resolves.toBe(false);
  });

  it("treats an unavailable backend as no flag", async () => {
    invoke.mockRejectedValue(new Error("window closed"));
    await expect(consumeLaunchPi()).resolves.toBe(false);
  });
});

describe("initLaunchDir", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("normalizes backslashes from the workspace fallback", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_launch_dir") return Promise.resolve(null);
      return Promise.resolve("C:\\Users\\me\\repo");
    });
    await initLaunchDir();
    expect(invoke).toHaveBeenCalledWith("get_launch_dir");
    expect(invoke).toHaveBeenCalledWith("workspace_current_dir");
    expect(getLaunchDir()).toBe("C:/Users/me/repo");
  });
});
