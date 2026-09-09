import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { PI_OPEN_CWDS_EVENT, PI_OPEN_CWDS_QUERY_EVENT } from "@/modules/pi/lib/providers";
import type { Tab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import type { CollectorIO } from "@/modules/uat/snapshot";
import type { Context, Controller, TabSummary } from "@/modules/uat/types";

export async function loadCollector() {
  if (!(await invoke<boolean>("get_launch_uat"))) return null;
  return import("@/modules/uat/snapshot");
}

function contextFor(
  tabs: Tab[],
  activeId: number,
  fallback: string | null,
): Context {
  const active = tabs.find((tab) => tab.id === activeId);
  const cwd =
    active && "cwd" in active
      ? active.cwd
      : active && "repoRoot" in active
        ? active.repoRoot
        : undefined;
  return {
    cwd: cwd || fallback || "",
    tabs: tabs.map(
      (tab): TabSummary => ({
        uat: tab.id === activeId ? "tab-active" : "tab",
        key: String(tab.id),
        kind:
          tab.kind === "agent-transcript"
            ? "child"
            : tab.kind === "run-graph"
              ? "graph"
              : tab.kind.startsWith("git-")
                ? "git"
                : (tab.kind as TabSummary["kind"]),
        title: [...labelFor(tab).replace(/\s+/g, " ").trim()]
          .slice(0, 200)
          .join(""),
        active: tab.id === activeId,
      }),
    ),
  };
}

export function useUat(tabs: Tab[], activeId: number, fallback: string | null) {
  const input = useRef({ tabs, activeId, fallback });
  input.current = { tabs, activeId, fallback };
  const controller = useRef<Controller | null>(null);
  useEffect(() => {
    let disposed = false;
    const started = loadCollector().then(async (module) => {
      if (!module || disposed) return null;
      const current = input.current;
      const next = await module.mountCollector(
        contextFor(current.tabs, current.activeId, current.fallback),
      );
      if (disposed) await next.stop();
      else {
        controller.current = next;
        const latest = input.current;
        next.update(contextFor(latest.tabs, latest.activeId, latest.fallback));
      }
      return next;
    });
    void started.catch((error) => console.error("UAT startup failed", error));
    return () => {
      disposed = true;
      controller.current = null;
      void started.then((next) => next?.stop()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (controller.current)
      controller.current.update(contextFor(tabs, activeId, fallback));
  }, [tabs, activeId, fallback]);
}

/**
 * The native Settings window (Tauri label "settings", the label the backend
 * reports as windowId) is its own UAT surface: section 5 says the --uat
 * collector covers it too while it is open. The backend routes this second
 * observer's commits to .pi/uat-snapshot-settings.json so the Settings
 * switches and rows are targetable by data-uat there without displacing the
 * main window's .pi/uat-snapshot.json.
 *
 * The settings webview has no tab strip; its one context tab carries kind
 * "settings" and the window's single data-uat scope key. That key is the
 * window's own backend label (the windowId the snapshots report), so every
 * element address this observer records is prefixed by the windowId and can
 * never collide with the main window's tab-keyed scopes (K7C-D06). The
 * observed project is the most recently active open pi session's cwd,
 * mirrored by the main window over the pi:open-cwds broadcast (the same
 * source the Pi check rows read); with no open project the collector idles
 * and writes nothing.
 */
export function settingsContext(cwd: string, windowId: string): Context {
  return {
    cwd,
    tabs: [
      {
        uat: "tab-active",
        key: windowId,
        kind: "settings",
        title: "Settings",
        active: true,
      },
    ],
  };
}

export type SettingsCollector = {
  controller: Controller;
  stop: () => Promise<void>;
};

export async function mountSettingsCollector(
  io?: CollectorIO,
): Promise<SettingsCollector | null> {
  const module = await loadCollector();
  if (!module) return null;
  // The address prefix is the backend's own window label, the same string it
  // reports as the snapshots' windowId and routes the commits by.
  const windowId = getCurrentWindow().label;
  const controller = await module.mountCollector(
    settingsContext("", windowId),
    io,
  );
  const apply = (cwds: unknown) => {
    const cwd = Array.isArray(cwds)
      ? (cwds.find((c): c is string => typeof c === "string" && c.length > 0) ??
        "")
      : "";
    controller.update(settingsContext(cwd, windowId));
  };
  const unlisten = await listen<{ cwds?: string[] }>(
    PI_OPEN_CWDS_EVENT,
    (event) => apply(event.payload?.cwds),
  );
  // A fresh settings window missed earlier broadcasts; pull the list once.
  void emit(PI_OPEN_CWDS_QUERY_EVENT, {}).catch(() => {});
  return {
    controller,
    stop: async () => {
      unlisten();
      await controller.stop();
    },
  };
}
