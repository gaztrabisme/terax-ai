// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock, dialogOpenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dialogOpenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// jsdom has no webview: a no-op drag-drop subscription keeps the composer's
// paste wiring inert (same shape as the Composer test).
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }));

// The run graph is the only mount-gated piece under test; the real one pulls
// in React Flow and dagre.
vi.mock("./components/RunGraph", () => ({
  RunGraph: () => <div data-testid="run-graph" />,
}));

import type { Tab } from "@/modules/tabs";
import { initialPiSessionState } from "./lib/parse";
import { usePiStore } from "./lib/piStore";
import { PiStack } from "./PiTab";

// react-resizable-panels reads ResizeObserver off the element's view; jsdom
// has none, so the panels get a no-op one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

function seedTabs(tabIds: number[]) {
  for (const tabId of tabIds) {
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        [tabId]: {
          gen: 1,
          state: initialPiSessionState(),
          session: null,
          exited: false,
          exitCode: null,
          error: null,
          roles: {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            smol: "omlx/q",
          },
        },
      },
    }));
  }
}

function piTabs(ids: number[]): Tab[] {
  return ids.map((id) => ({ id, kind: "pi", title: "pi", cwd: `/proj-${id}` }));
}

describe("PiStack run-graph mount gating", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    dialogOpenMock.mockReset();
    usePiStore.setState({ tabs: {} });
  });

  it("mounts exactly one run graph, inside the active tab's slot", () => {
    seedTabs([1, 2]);
    const { container } = render(
      <PiStack tabs={piTabs([1, 2])} activeId={1} onOpenChild={() => {}} />,
    );
    const graphs = container.querySelectorAll('[data-testid="run-graph"]');
    expect(graphs).toHaveLength(1);
    // It sits in the visible (aria-hidden false) slot, which is tab 1's.
    const wrapper = graphs[0].closest('[aria-hidden="false"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.querySelector('[data-pi-chat="1"]')).toBeTruthy();
    expect(wrapper?.querySelector('[data-pi-chat="2"]')).toBeNull();
    // The hidden tab's slot holds no run graph at all.
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden).toBeTruthy();
    expect(hidden?.querySelector('[data-testid="run-graph"]')).toBeNull();
  });

  it("moves the single run graph when another tab becomes active", () => {
    seedTabs([1, 2]);
    const { container, rerender } = render(
      <PiStack tabs={piTabs([1, 2])} activeId={1} onOpenChild={() => {}} />,
    );
    rerender(
      <PiStack tabs={piTabs([1, 2])} activeId={2} onOpenChild={() => {}} />,
    );
    const graphs = container.querySelectorAll('[data-testid="run-graph"]');
    expect(graphs).toHaveLength(1);
    const wrapper = graphs[0].closest('[aria-hidden="false"]');
    expect(wrapper?.querySelector('[data-pi-chat="2"]')).toBeTruthy();
    expect(wrapper?.querySelector('[data-pi-chat="1"]')).toBeNull();
  });
});
