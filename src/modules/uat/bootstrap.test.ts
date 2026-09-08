import { beforeEach, expect, it, vi } from "vitest";
const { invoke, imported } = vi.hoisted(() => ({
  invoke: vi.fn(),
  imported: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/uat/snapshot", () => {
  imported();
  return { mountCollector: vi.fn() };
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it("never imports the collector module without the startup flag", async () => {
  invoke.mockResolvedValue(false);
  const { loadCollector } = await import("@/modules/uat/bootstrap");
  expect(await loadCollector()).toBeNull();
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("get_launch_uat");
  expect(imported).not.toHaveBeenCalled();
});

it("loads the collector only after the backend confirms --uat", async () => {
  invoke.mockResolvedValue(true);
  const { loadCollector } = await import("@/modules/uat/bootstrap");
  expect(await loadCollector()).toHaveProperty("mountCollector");
  expect(imported).toHaveBeenCalledOnce();
});
