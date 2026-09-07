// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The section must mount on a fresh install where only pi_paths answers and
// every other command, file read and shell call fails like on a new machine.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "pi_paths") {
      return Promise.resolve({
        pi: {
          path: "/lab/efficient-pi/bin/pi",
          source: "pref",
          candidates: ["/lab/efficient-pi/bin/pi"],
        },
        agent: {
          path: "/harness/target/release/agent",
          source: "pref",
          candidates: ["/harness/target/release/agent"],
        },
        agentDir: {
          path: "/lab/efficient-pi/pi-home/agent",
          source: "pref",
          candidates: ["/lab/efficient-pi/pi-home/agent"],
        },
        runtimeAgentDir: {
          path: "/lab/efficient-pi/pi-home/agent",
          source: "pref",
          seeded: false,
        },
      });
    }
    return Promise.reject(new Error(`${cmd} unavailable in test`));
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async set() {}
    async save() {}
    async entries() {
      return [] as [string, unknown][];
    }
    async onChange() {
      return () => {};
    }
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { PI_PREF_DEFAULTS } from "@/modules/pi/lib/providers";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { PiSection } from "./PiSection";

const FRESH_PI_PREFS = {
  piLauncherDir: PI_PREF_DEFAULTS.launcherDir,
  piBoardBin: PI_PREF_DEFAULTS.boardBin,
  piAgentBin: PI_PREF_DEFAULTS.agentBin,
  piAgentDir: PI_PREF_DEFAULTS.agentDir,
  piProvider: PI_PREF_DEFAULTS.provider,
  piModel: PI_PREF_DEFAULTS.model,
  piThinking: PI_PREF_DEFAULTS.thinking,
  piSmol: PI_PREF_DEFAULTS.smol,
};

beforeEach(() => {
  usePreferencesStore.setState(FRESH_PI_PREFS);
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockClear();
});

it("renders the first-run check and the provider placeholder on a fresh install", async () => {
  render(<PiSection />);

  // The orchestrator select has no provider yet, so the placeholder must
  // render instead of an item; an empty-string item crashes Radix Select.
  expect(screen.getByText("Choose a provider")).toBeTruthy();

  // The check resolves despite every command rejecting and keeps every row.
  await screen.findByText("pi binary");
  // The check row label carries the roles scope suffix ("global"), the Roles
  // setting title does not; substring matching catches both.
  expect(
    (await screen.findAllByText("Orchestrator provider", { exact: false }))
      .length,
  ).toBe(2);
  expect(screen.getByText("3 ok, 0 warn, 2 missing")).toBeTruthy();
  expect(screen.getByText("Choose a provider")).toBeTruthy();
});

it("names the runtime agent dir and disables endpoints before the first seed", async () => {
  // The resolved agent dir is the bundled template and the seeded copy does
  // not exist yet: the section shows when the seed lands and blocks edits.
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "pi_paths") {
      return Promise.resolve({
        pi: { path: "/app/exe/pi", source: "bundled", candidates: ["/app/exe/pi"] },
        agent: {
          path: "/app/exe/agent",
          source: "bundled",
          candidates: ["/app/exe/agent"],
        },
        agentDir: {
          path: "/app/res/pi-home/agent",
          source: "bundled",
          candidates: ["/app/res/pi-home/agent"],
        },
        runtimeAgentDir: {
          path: "/app/data/pi-home/agent",
          source: "bundled",
          seeded: false,
        },
      });
    }
    return Promise.reject(new Error(`${cmd} unavailable in test`));
  });

  render(<PiSection />);

  expect(
    await screen.findByText("seeded on the first session"),
  ).toBeTruthy();
  expect(
    screen.getByText("/app/data/pi-home/agent/models.json.tmpl"),
  ).toBeTruthy();
  expect(screen.getByText("Save endpoints")).toHaveProperty("disabled", true);
  expect(screen.getByText("Add endpoint")).toHaveProperty("disabled", true);
});
