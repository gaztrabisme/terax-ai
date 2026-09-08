export const CHAT_VIEWS = ["board", "graph", "sessions", "artifact"] as const;
export type ChatView = (typeof CHAT_VIEWS)[number];
export type ViewMode = "popover" | "panel" | "fullscreen";
export type ViewState = {
  view: ChatView | null;
  mode: ViewMode;
  returnMode: "closed" | "popover" | "panel" | null;
  narrowRestoreView: ChatView | null;
};

export const CLOSED_VIEW: ViewState = {
  view: null,
  mode: "panel",
  returnMode: null,
  narrowRestoreView: null,
};

export type ViewEvent =
  | {
      type: "reset" | "close" | "tab-switch" | "fullscreen" | "dismiss-popover";
    }
  | { type: "toggle" | "open"; view: ChatView; narrow: boolean }
  | { type: "expand" | "back" | "escape" | "resize"; narrow: boolean };

function openView(view: ChatView, narrow: boolean): ViewState {
  return {
    view,
    mode: narrow ? "fullscreen" : view === "sessions" ? "popover" : "panel",
    returnMode: narrow ? "closed" : null,
    narrowRestoreView: null,
  };
}

export function viewReducer(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case "reset":
    case "close":
      return CLOSED_VIEW;
    case "tab-switch":
      return state;
    case "toggle":
      return state.view === event.view
        ? CLOSED_VIEW
        : openView(event.view, event.narrow);
    case "open":
      return openView(event.view, event.narrow);
    case "expand":
      if (state.view !== "sessions" || state.mode !== "popover") return state;
      return {
        ...state,
        mode: event.narrow ? "fullscreen" : "panel",
        returnMode: event.narrow ? "closed" : null,
      };
    case "fullscreen":
      if (!state.view || state.mode === "fullscreen") return state;
      return { ...state, mode: "fullscreen", returnMode: state.mode };
    case "back":
    case "escape": {
      if (!state.view) return state;
      if (state.mode !== "fullscreen") {
        return event.type === "escape" ? CLOSED_VIEW : state;
      }
      if (!state.returnMode || state.returnMode === "closed")
        return CLOSED_VIEW;
      if (state.returnMode === "panel" && event.narrow) {
        return { ...CLOSED_VIEW, narrowRestoreView: state.view };
      }
      return { ...state, mode: state.returnMode, returnMode: null };
    }
    case "dismiss-popover":
      return state.view && state.mode === "popover" ? CLOSED_VIEW : state;
    case "resize":
      if (state.view && state.mode === "panel" && event.narrow) {
        return { ...CLOSED_VIEW, narrowRestoreView: state.view };
      }
      if (!state.view && state.narrowRestoreView && !event.narrow) {
        return { ...CLOSED_VIEW, view: state.narrowRestoreView };
      }
      return state;
  }
}

export const MODE_STRIP_WIDTH = 40;
export const MIN_PANEL_WIDTH = 240;
export const MIN_CHAT_WIDTH = 320;

export function isNarrowContent(contentWidth: number): boolean {
  return contentWidth < MIN_PANEL_WIDTH + MIN_CHAT_WIDTH;
}

export function maxPanelWidth(contentWidth: number): number {
  return Math.max(
    MIN_PANEL_WIDTH,
    Math.min(contentWidth * 0.6, contentWidth - MIN_CHAT_WIDTH),
  );
}

export function panelWidth(
  widthCss: number | null,
  contentWidth: number,
): number {
  return Math.min(
    maxPanelWidth(contentWidth),
    Math.max(MIN_PANEL_WIDTH, widthCss ?? contentWidth * 0.3),
  );
}
