import { beforeEach, expect, it, vi } from "vitest";
const { invoke, imported, listen, emit, windowLabel } = vi.hoisted(() => ({
  invoke: vi.fn(),
  imported: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
  windowLabel: { value: "settings" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen, emit }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel.value }),
}));
vi.mock("@/modules/uat/snapshot", () => {
  imported();
  return { mountCollector: vi.fn() };
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  windowLabel.value = "settings";
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
  expect(settingsContext("/proj-x", "settings")).toEqual({
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
  expect(mountCollector).toHaveBeenCalledWith(
    settingsContext("", "settings"),
    undefined,
  );
  expect(emit).toHaveBeenCalled();
  deliver!({ payload: { cwds: ["/proj-x", "/proj-y"] } });
  expect(update).toHaveBeenCalledWith(settingsContext("/proj-x", "settings"));
  // No open cwd, no binding: the collector stays idle rather than guessing.
  deliver!({ payload: { cwds: [] } });
  expect(update).toHaveBeenLastCalledWith(settingsContext("", "settings"));
  await collector!.stop();
  expect(stop).toHaveBeenCalledOnce();
});

it("prefixes every settings address with the backend windowId (K7C-D06)", async () => {
  const update = vi.fn();
  const stop = vi.fn();
  const { mountCollector } = await import("@/modules/uat/snapshot");
  vi.mocked(mountCollector).mockResolvedValue({ update, stop } as never);
  listen.mockResolvedValue(() => {});
  invoke.mockResolvedValue(true);
  emit.mockResolvedValue(undefined);
  windowLabel.value = "settings-2";
  const { mountSettingsCollector, settingsContext } = await import(
    "@/modules/uat/bootstrap"
  );
  // The one context tab's key is the window's own backend label (the same
  // string the snapshots report as windowId), so every element scope this
  // observer records carries the windowId and can never equal the main
  // window's tab-keyed scopes, whatever the label is.
  expect(settingsContext("/p", "settings-2").tabs[0].key).toBe("settings-2");
  await mountSettingsCollector();
  expect(vi.mocked(mountCollector)).toHaveBeenCalledWith(
    settingsContext("", "settings-2"),
    undefined,
  );
});
