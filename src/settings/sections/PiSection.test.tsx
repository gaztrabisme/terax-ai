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
});

it("renders the first-run check and the provider placeholder on a fresh install", async () => {
  render(<PiSection />);

  // The orchestrator select has no provider yet, so the placeholder must
  // render instead of an item; an empty-string item crashes Radix Select.
  expect(screen.getByText("Choose a provider")).toBeTruthy();

  // The check resolves despite every command rejecting and keeps every row.
  await screen.findByText("pi binary");
  // The row label and the Roles setting title share this text.
  expect((await screen.findAllByText("Orchestrator provider")).length).toBe(2);
  expect(screen.getByText("3 ok, 0 warn, 2 missing")).toBeTruthy();
  expect(screen.getByText("Choose a provider")).toBeTruthy();
});
