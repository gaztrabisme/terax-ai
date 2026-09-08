import { describe, expect, it } from "vitest";
import {
  CHAT_VIEWS,
  CLOSED_VIEW,
  isNarrowContent,
  maxPanelWidth,
  panelWidth,
  viewReducer,
  type ChatView,
  type ViewEvent,
  type ViewState,
} from "./viewMachine";

const panel = (view: ChatView): ViewState => ({ ...CLOSED_VIEW, view });
const popover: ViewState = { ...panel("sessions"), mode: "popover" };
const full = (
  view: ChatView,
  returnMode: ViewState["returnMode"],
): ViewState => ({
  ...panel(view),
  mode: "fullscreen",
  returnMode,
});
const openStates = [
  popover,
  ...CHAT_VIEWS.map(panel),
  ...CHAT_VIEWS.map((view) => full(view, "panel")),
  full("sessions", "popover"),
];

describe("section 3.1 transition table, in contract order", () => {
  it("walks every row, including each applicable view and return mode", () => {
    const rows: {
      row: string;
      from: ViewState[];
      event: (state: ViewState) => ViewEvent;
      next: (state: ViewState) => ViewState;
    }[] = [
      {
        row: "1. New process, pi launch, first project open",
        from: [CLOSED_VIEW, ...openStates],
        event: () => ({ type: "reset" }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "2. Closed: Sessions button or shortcut",
        from: [CLOSED_VIEW],
        event: () => ({ type: "toggle", view: "sessions", narrow: false }),
        next: () => popover,
      },
      ...(["board", "graph", "artifact"] as const).map((view) => ({
        row: `3. Closed: ${view}`,
        from: [CLOSED_VIEW],
        event: (): ViewEvent => ({ type: "toggle", view, narrow: false }),
        next: () => panel(view),
      })),
      {
        row: "4. Open view: own button",
        from: openStates,
        event: (s) => ({ type: "toggle", view: s.view!, narrow: false }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "4. Open view: Close",
        from: openStates,
        event: () => ({ type: "close" }),
        next: () => CLOSED_VIEW,
      },
      ...CHAT_VIEWS.map((view) => ({
        row: `5. Another strip button: ${view}`,
        from: openStates.filter((s) => s.view !== view),
        event: (): ViewEvent => ({ type: "toggle", view, narrow: false }),
        next: () => (view === "sessions" ? popover : panel(view)),
      })),
      {
        row: "6. Sessions popover: Expand",
        from: [popover],
        event: () => ({ type: "expand", narrow: false }),
        next: () => panel("sessions"),
      },
      {
        row: "7. Panel: Full screen",
        from: CHAT_VIEWS.map(panel),
        event: () => ({ type: "fullscreen" }),
        next: (s) => full(s.view!, "panel"),
      },
      {
        row: "8. Sessions popover: Full screen",
        from: [popover],
        event: () => ({ type: "fullscreen" }),
        next: () => full("sessions", "popover"),
      },
      ...(["back", "escape"] as const).map((type) => ({
        row: `9. Fullscreen: ${type}`,
        from: openStates.filter((s) => s.mode === "fullscreen"),
        event: (): ViewEvent => ({ type, narrow: false }),
        next: (s: ViewState) =>
          s.returnMode === "popover" ? popover : panel(s.view!),
      })),
      {
        row: "10. Panel: Escape closes, never demotes",
        from: CHAT_VIEWS.map(panel),
        event: () => ({ type: "escape", narrow: false }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "11. Sessions popover: Escape",
        from: [popover],
        event: () => ({ type: "escape", narrow: false }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "11. Sessions popover: outside click or successful hit",
        from: [popover],
        event: () => ({ type: "dismiss-popover" }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "12. Switch to another still-open tab and back",
        from: [CLOSED_VIEW, ...openStates],
        event: () => ({ type: "tab-switch" }),
        next: (s) => s,
      },
      {
        row: "13. Close tab and reopen",
        from: [CLOSED_VIEW, ...openStates],
        event: () => ({ type: "reset" }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "14. Quit or process loss and restart",
        from: [CLOSED_VIEW, ...openStates],
        event: () => ({ type: "reset" }),
        next: () => CLOSED_VIEW,
      },
      {
        row: "15. Panel below minimum width",
        from: CHAT_VIEWS.map(panel),
        event: () => ({ type: "resize", narrow: true }),
        next: (s) => ({ ...CLOSED_VIEW, narrowRestoreView: s.view }),
      },
      {
        row: "16. Widen after automatic collapse",
        from: CHAT_VIEWS.map((view) => ({
          ...CLOSED_VIEW,
          narrowRestoreView: view,
        })),
        event: () => ({ type: "resize", narrow: false }),
        next: (s) => panel(s.narrowRestoreView!),
      },
      {
        row: "17. Other resize: preserve mode",
        from: [CLOSED_VIEW, ...openStates],
        event: () => ({ type: "resize", narrow: false }),
        next: (s) => s,
      },
    ];
    for (const row of rows) {
      for (const state of row.from) {
        const snapshot = structuredClone(state);
        expect(viewReducer(state, row.event(state)), row.row).toEqual(
          row.next(state),
        );
        expect(state, `${row.row} must not mutate its input`).toEqual(snapshot);
      }
    }
  });

  it.each(
    CHAT_VIEWS,
  )("opens %s fullscreen when narrow with an explicit closed return", (view) => {
    const state = viewReducer(CLOSED_VIEW, {
      type: "toggle",
      view,
      narrow: true,
    });
    expect(state).toEqual(full(view, "closed"));
    for (const type of ["back", "escape"] as const) {
      expect(viewReducer(state, { type, narrow: true })).toEqual(CLOSED_VIEW);
    }
  });

  it("keeps narrow markers only for automatic collapse", () => {
    const collapsed = viewReducer(panel("board"), {
      type: "resize",
      narrow: true,
    });
    expect(viewReducer(collapsed, { type: "resize", narrow: true })).toBe(
      collapsed,
    );
    for (const type of ["close", "reset"] as const) {
      expect(
        viewReducer(viewReducer(collapsed, { type }), {
          type: "resize",
          narrow: false,
        }),
      ).toEqual(CLOSED_VIEW);
    }
    expect(
      viewReducer(collapsed, { type: "open", view: "sessions", narrow: true }),
    ).toEqual(full("sessions", "closed"));
    expect(
      viewReducer(full("graph", "panel"), { type: "back", narrow: true }),
    ).toEqual({ ...CLOSED_VIEW, narrowRestoreView: "graph" });
  });

  it("does not invent fullscreen or popover transitions", () => {
    expect(viewReducer(CLOSED_VIEW, { type: "fullscreen" })).toBe(CLOSED_VIEW);
    for (const state of openStates) {
      if (state !== popover)
        expect(viewReducer(state, { type: "expand", narrow: false })).toBe(
          state,
        );
      if (state.mode === "fullscreen")
        expect(viewReducer(state, { type: "fullscreen" })).toBe(state);
    }
    expect(viewReducer(popover, { type: "expand", narrow: true })).toEqual(
      full("sessions", "closed"),
    );
  });
});

describe("CSS panel geometry", () => {
  it("uses 30 percent by default and honors the panel/chat minimums and 60 percent cap", () => {
    expect(panelWidth(null, 1000)).toBe(300);
    expect(panelWidth(10, 1000)).toBe(240);
    expect(panelWidth(900, 1000)).toBe(600);
    expect(panelWidth(900, 600)).toBe(280);
    expect(maxPanelWidth(560)).toBe(240);
    expect(isNarrowContent(559)).toBe(true);
    expect(isNarrowContent(560)).toBe(false);
  });
});
