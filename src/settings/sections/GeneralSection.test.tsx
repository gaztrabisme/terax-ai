// @vitest-environment jsdom
// UX-15/K7-D01: every Switch in the General section carries a unique
// contextual accessible name; the Terminal composer switch, unnamed in the
// K7 AX capture, is named by its scope ("by default"), the others by their
// visible labels.

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
  it("names the Terminal composer switch by its scope (K7-D01)", () => {
    render(<GeneralSection />);
    const composer = screen.getByRole("switch", {
      name: "Terminal composer by default",
    });
    expect(composer.getAttribute("data-uat")).toBe(
      "terminal-composer-default",
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
});
