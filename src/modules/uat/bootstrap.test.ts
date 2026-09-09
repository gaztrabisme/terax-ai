import { beforeEach, expect, it, vi } from "vitest";
const { invoke, imported, listen, emit } = vi.hoisted(() => ({
  invoke: vi.fn(),
  imported: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen, emit }));
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

it("settings observer is also gated by the startup flag", async () => {
  invoke.mockResolvedValue(false);
  const { mountSettingsCollector } = await import("@/modules/uat/bootstrap");
  expect(await mountSettingsCollector()).toBeNull();
  expect(imported).not.toHaveBeenCalled();
});

it("settings observer mounts one settings tab and binds the broadcast project cwd", async () => {
  const update = vi.fn();
  const stop = vi.fn();
  const { mountCollector } = await import("@/modules/uat/snapshot");
  vi.mocked(mountCollector).mockResolvedValue({ update, stop } as never);
  let deliver: ((event: { payload: { cwds?: string[] } }) => void) | null =
    null;
  listen.mockImplementation(async (_event, handler) => {
    deliver = handler;
    return () => {};
  });
  invoke.mockResolvedValue(true);
  emit.mockResolvedValue(undefined);
  const { mountSettingsCollector, settingsContext } = await import(
    "@/modules/uat/bootstrap"
  );
  expect(settingsContext("/proj-x")).toEqual({
    cwd: "/proj-x",
    tabs: [
      {
        uat: "tab-active",
        key: "settings",
        kind: "settings",
        title: "Settings",
        active: true,
      },
    ],
  });
  const collector = await mountSettingsCollector();
  expect(collector).toBeTruthy();
  expect(vi.mocked(mountCollector)).toHaveBeenCalledOnce();
  // Mounts idle with no project, pulls the open-cwds list once, then binds
  // the most recently active project cwd from the broadcast.
  expect(mountCollector).toHaveBeenCalledWith(settingsContext(""), undefined);
  expect(emit).toHaveBeenCalled();
  deliver!({ payload: { cwds: ["/proj-x", "/proj-y"] } });
  expect(update).toHaveBeenCalledWith(settingsContext("/proj-x"));
  // No open cwd, no binding: the collector stays idle rather than guessing.
  deliver!({ payload: { cwds: [] } });
  expect(update).toHaveBeenLastCalledWith(settingsContext(""));
  await collector!.stop();
  expect(stop).toHaveBeenCalledOnce();
});
