// @vitest-environment jsdom
// K14 launch-error banner (design.md section 3.5 row "Launch preparation
// fails"): the banner names the failure, and Open log opens the project's
// `.pi/launcher.log` through the same pi:open-file bridge the transcript's
// file links use. R15.1: the failure is loud, never a blank pane.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The composer and transcript bodies are not under test here.
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./Transcript", () => ({
  Transcript: () => null,
  formatCost: (cost: number) => `$${cost.toFixed(2)}`,
}));

import { initialPiSessionState } from "../lib/parse";
import { usePiStore } from "../lib/piStore";
import { ChatPane } from "./ChatPane";

function seedTab(tabId: number, patch: Partial<Record<string, unknown>>) {
  const base = usePiStore.getState().tabs[tabId];
  usePiStore.setState({
    tabs: {
      [tabId]: {
        gen: 1,
        state: initialPiSessionState(),
        session: null,
        exited: false,
        exitCode: null,
        error: null,
        roles: { provider: "", model: "", smol: "" },
        ...(base as object | undefined),
        ...patch,
      },
    },
  });
}

afterEach(() => {
  cleanup();
  usePiStore.setState({ tabs: {} });
});

describe("ChatPane launch-error banner", () => {
  it("names the failed preparation step with Launch failed:", () => {
    seedTab(1, { error: "root failed: /proj has no .git, CLAUDE.md, AGENTS.md" });
    render(<ChatPane tabId={1} cwd="/proj" onOpenChild={() => {}} />);
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-uat")).toBe("launch-error");
    expect(banner.textContent).toContain("Launch failed:");
    expect(banner.textContent).toContain("root failed: /proj has no .git");
    // The banner names the failure; it never reads as a running session.
    expect(screen.queryByText("New session")).toBeTruthy();
  });

  it("Open log dispatches pi:open-file with <cwd>/.pi/launcher.log", () => {
    seedTab(1, { error: "seed failed: cannot write models.json" });
    const opened: Array<CustomEvent> = [];
    const listener = (e: Event) => opened.push(e as CustomEvent);
    window.addEventListener("pi:open-file", listener);
    try {
      render(<ChatPane tabId={1} cwd="/proj" onOpenChild={() => {}} />);
      fireEvent.click(screen.getByText("Open log"));
      expect(opened).toHaveLength(1);
      expect(opened[0].detail).toEqual({ path: "/proj/.pi/launcher.log" });
    } finally {
      window.removeEventListener("pi:open-file", listener);
    }
  });

  it("keeps the plain error card when the error is not a launch failure", () => {
    // An exited session's error arrived mid-run: no launch banner, no log
    // button, the plain card below stands.
    seedTab(2, { error: "rpc stream broke", exited: true, exitCode: 1 });
    render(<ChatPane tabId={2} cwd="/proj" onOpenChild={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Open log")).toBeNull();
    expect(screen.getByText("rpc stream broke")).toBeTruthy();
  });
});
