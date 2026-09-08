import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { Tab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
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
