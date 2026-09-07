import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: (line: unknown) => void = () => {};
  },
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { openPiSession } from "./rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./settingsSchema";

describe("pi_open spawn spec", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("threads cwd and launcherDir, leaving program to the Rust resolver", async () => {
    invoke.mockResolvedValue(7);
    const session = await openPiSession({
      cwd: "/work/proj",
      launcherDir: "$HOME/Documents/Work/Lab/efficient-pi",
      onEvent: () => {},
    });
    expect(invoke).toHaveBeenCalledWith("pi_open", {
      cwd: "/work/proj",
      launcherDir: "$HOME/Documents/Work/Lab/efficient-pi",
      program: null,
      args: null,
      env: null,
      workspace: { kind: "local" },
      onEvent: expect.anything(),
      onExit: expect.anything(),
    });
    await session.kill();
  });

  it("sends null launcherDir when unset", async () => {
    invoke.mockResolvedValue(8);
    const session = await openPiSession({ cwd: "/w", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "pi_open",
      expect.objectContaining({ cwd: "/w", launcherDir: null }),
    );
    await session.kill();
  });

  it("defaults launcherDir to empty so the resolver decides", () => {
    expect(PI_MODULE_PREFS_DEFAULTS.launcherDir).toBe("");
  });
});
