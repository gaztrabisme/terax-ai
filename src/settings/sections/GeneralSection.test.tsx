// @vitest-environment jsdom
// UX-15/K7-D01 and G4: every Switch in the General section carries a unique
// accessible name; the Terminal composer switch, unnamed in the K7 AX
// capture, carries the exact name the K2/K4 scripts resolve ("Terminal
// composer") with its scope in the description, the others their visible
// labels.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom has no ResizeObserver; the zoom Slider's radix size hook needs one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("unavailable in test"))),
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
  },
}));

vi.mock("@/modules/theme", () => ({
  useTheme: () => ({ mode: "system", setMode: () => {} }),
}));

import { GeneralSection } from "./GeneralSection";

afterEach(() => cleanup());

describe("GeneralSection switch names", () => {
  it("names the Terminal composer switch exactly as the scripts target (K7-D01, G4)", () => {
    render(<GeneralSection />);
    const composer = screen.getByRole("switch", {
      name: "Terminal composer",
    });
    expect(composer.getAttribute("data-uat")).toBe(
      "terminal-composer-default",
    );
    // The scope ("by default") survives as the description, not the name.
    expect(composer.getAttribute("aria-description")).toBe(
      "on by default in new terminals",
    );
  });

  it("names every other switch after its visible label", () => {
    render(<GeneralSection />);
    for (const label of [
      "Vim mode",
      "Auto save",
      "Show hidden files",
      "Use WebGL renderer",
      "Restore window position & size",
    ]) {
      expect(screen.getByRole("switch", { name: label })).toBeTruthy();
    }
    // No unnamed switch remains anywhere in the section.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(6);
    for (const element of switches) {
      expect(element.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("keys every repeated switch with its preference key under one id (K7C-D06)", () => {
    render(<GeneralSection />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(6);
    const keys: string[] = [];
    const keyToId = new Map<string, string | null>();
    for (const element of switches) {
      const key = element.getAttribute("data-uat-key");
      keyToId.set(key ?? "", element.getAttribute("data-uat"));
      if (key) keys.push(key);
    }
    // The repeated switches share the settings-switch id, each keyed by its
    // preference key, so the snapshot identities never repeat unkeyed.
    for (const pref of [
      "vimMode",
      "editorAutoSave",
      "showHidden",
      "terminalWebglEnabled",
      "restoreWindowState",
    ]) {
      expect(keyToId.get(pref)).toBe("settings-switch");
    }
    // The keys are unique: no two switches share an identity.
    expect(new Set(keys).size).toBe(keys.length);
    // The scripted Terminal composer switch keeps its canonical id; it is
    // not repeated, so it carries no key.
    const composer = screen.getByRole("switch", { name: "Terminal composer" });
    expect(composer.getAttribute("data-uat")).toBe(
      "terminal-composer-default",
    );
    expect(composer.getAttribute("data-uat-key")).toBeNull();
  });
});
