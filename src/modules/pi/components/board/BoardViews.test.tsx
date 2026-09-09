// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Kanban } from "@/modules/pi/components/board/Kanban";
import { LaneList } from "@/modules/pi/components/board/LaneList";
import { parseBoard } from "@/modules/pi/lib/board";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const order = ["todo", "align", "in_progress", "verify", "review", "land", "rework", "done"];
const snapshot = parseBoard(JSON.stringify({ states: [...order].reverse(), tickets: [] }));
let resize: () => void;
let width = 1500;
beforeEach(() => {
  width = 1500;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1992);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([Kanban, LaneList])("renders all eight documented states regardless of snapshot order", (View) => {
  const { container } = render(<View snapshot={snapshot} onOpen={() => {}} />);
  expect([...container.querySelectorAll('[data-uat="board-columns"]')].map((node) => node.getAttribute("data-uat-key"))).toEqual(order);
});

it("shows a keyboard reachable scroll area and overflow hint only while columns overflow", () => {
  render(<Kanban snapshot={snapshot} onOpen={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("6 of 8 states visible. Scroll horizontally");
  expect(screen.getByRole("region").tabIndex).toBe(0);
  act(() => { width = 2100; resize(); });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("region").hasAttribute("tabindex")).toBe(false);
});

it("keeps panel lanes vertical without a horizontal scroll hint", () => {
  const { container } = render(<LaneList snapshot={snapshot} onOpen={() => {}} />);
  expect(container.firstElementChild?.className).toContain("overflow-y-auto");
  expect(container.firstElementChild?.className).not.toContain("overflow-x-auto");
  expect(screen.queryByRole("status")).toBeNull();
});
