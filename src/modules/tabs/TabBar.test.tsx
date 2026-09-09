// @vitest-environment jsdom
// G4: tab close controls carry their own scripted target and name while the
// tab keeps the "<title> Close tab" radio name; the New-tab menu item
// "New pi session" creates one pi tab per activation (UX2-08).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";
import type { Tab } from "./lib/useTabs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

beforeEach(() => {
  // jsdom lacks both; the bar keeps its active tab scrolled into view and
  // Radix menus dispatch pointer events.
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function piTab(id: number, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    kind: "pi",
    title: "pi: standalone-proj",
    cwd: "/tmp/standalone-proj",
    ...overrides,
  } as Tab;
}

function shellTab(id: number, title = "shell"): Tab {
  return {
    id,
    kind: "terminal",
    title,
    paneTree: { kind: "leaf", id: id + 100, cwd: "/tmp" },
    activeLeafId: id + 100,
  };
}

function mount(tabs: Tab[], handlers: { onNewPi?: () => void; onClose?: (id: number) => void } = {}) {
  return render(
    <TabBar
      tabs={tabs}
      activeId={tabs[0].id}
      onSelect={() => {}}
      onNew={() => {}}
      onNewPrivate={() => {}}
      onNewEditor={() => {}}
      onNewPi={handlers.onNewPi ?? (() => {})}
      onNewPiSession={() => {}}
      onNewGitGraph={() => {}}
      onClose={handlers.onClose ?? (() => {})}
      onPin={() => {}}
      onRename={() => {}}
    />,
  );
}

describe("tab close controls (UX2-04, G4)", () => {
  it("names each close control after its tab and keys it by tab id", () => {
    mount([
      piTab(7),
      shellTab(8),
    ]);
    const active = document.querySelector('[data-uat="tab-active"]')!;
    // The tab keeps the scripted radio name "<title> Close tab".
    expect(active.getAttribute("aria-label")).toBe(
      "pi: standalone-proj Close tab",
    );
    const close = active.querySelector('[data-uat="tab-close"]')!;
    expect(close.getAttribute("data-uat-key")).toBe("7");
    expect(close.getAttribute("aria-label")).toBe(
      "Close tab pi: standalone-proj",
    );
    // Every rendered tab owns exactly one close target.
    expect(
      screen.getAllByRole("button", { name: /Close tab / }).map((el) =>
        el.getAttribute("data-uat-key"),
      ),
    ).toEqual(["7", "8"]);
  });

  it("closes the requested tab through its own control", () => {
    const onClose = vi.fn();
    mount([piTab(7), shellTab(8)], {
      onClose,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Close tab shell" }),
    );
    expect(onClose).toHaveBeenCalledWith(8);
  });

  it("keeps the single-tab radio name free of a close suffix", () => {
    mount([piTab(7)]);
    expect(
      document.querySelector('[data-uat="tab-active"]')!.getAttribute("aria-label"),
    ).toBeNull();
    expect(document.querySelector('[data-uat="tab-close"]')).toBeNull();
  });
});

describe("pi tab identity (UX2-08, G4)", () => {
  it("puts the short session id in the tab's title attribute once a session exists", () => {
    mount([
      piTab(7, { sessionId: "9d1c44aa7b21longer-id" }),
      shellTab(8),
    ]);
    const active = document.querySelector('[data-uat="tab-active"]')!;
    expect(active.getAttribute("title")).toBe(
      "pi: standalone-proj (session 9d1c44aa)",
    );
    expect(active.getAttribute("aria-label")).toBe(
      "pi: standalone-proj Close tab",
    );
  });
});

describe("one activation, one tab (UX2-08, G4)", () => {
  it("targets the visible New pi session menu item and one click creates one tab", () => {
    const onNewPi = vi.fn();
    mount([piTab(7), shellTab(8)], {
      onNewPi,
    });
    // The scripted target lives on the New-tab menu item, not the picker.
    expect(
      document.querySelector('[data-uat="new-pi-session"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-uat="new-pi-session-picker"]'),
    ).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "New tab" });
    // Radix dropdown triggers open on pointerdown; the item mounts in the
    // portal synchronously.
    fireEvent.pointerDown(trigger);
    const item = document.querySelector<HTMLElement>(
      '[data-uat="new-pi-session"]',
    );
    expect(item?.textContent).toContain("New pi session");
    fireEvent.click(item!);
    expect(onNewPi).toHaveBeenCalledTimes(1);
  });

  it("collapses the click-plus-select replay into one activation", async () => {
    const run = vi.fn();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { activationGuard } = await import("./TabBar");
    const guard = activationGuard(300);
    // The replay pair: two activations of the same action in one burst.
    guard("new-pi-session", run);
    now += 5;
    guard("new-pi-session", run);
    expect(run).toHaveBeenCalledTimes(1);
    // Another action inside the burst still runs (and is remembered alone).
    const other = vi.fn();
    now += 5;
    guard("new-tab", other);
    expect(other).toHaveBeenCalledTimes(1);
    // A deliberate second activation after the burst window runs again.
    now += 400;
    guard("new-pi-session", run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
