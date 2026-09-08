export type Point = { x: number; y: number };
export type Rect = Point & { w: number; h: number };
export type NativeWindow = Rect & {
  scale: number;
  cssToPoint: number;
  driverUnits: "macos-points" | "logical-pixels";
  driverOrigin: Point;
  contentOffset: Point;
  displayId: string;
  displayPhysicalOrigin: Point;
  displayDriverOrigin: Point;
  coordinateStatus: "supported" | "unsupported-mixed-dpi" | "unavailable";
};
export type TabSummary = {
  uat: string;
  key: string;
  kind:
    | "pi"
    | "terminal"
    | "child"
    | "editor"
    | "markdown"
    | "git"
    | "settings"
    | "board"
    | "graph";
  title: string;
  active: boolean;
};
export type UatError = {
  code: string;
  message: string;
  at: string;
  consecutiveFailures: number;
  logPath: string | null;
};
export type Identity = {
  uat: string;
  scope: string;
  index: number | null;
  key: string;
};
export type Secret = Identity & { secret: true };
export type ElementSnapshot = Identity & {
  role:
    | "textbox"
    | "button"
    | "checkbox"
    | "radio"
    | "tab"
    | "group"
    | "pane"
    | "status"
    | "block"
    | "link"
    | "list"
    | "row"
    | "frame"
    | "separator";
  label: string;
  rect: Rect | null;
  hitRect: Rect | null;
  enabled: boolean;
  checked: boolean | null;
  hidden: boolean;
  interactable: boolean;
  unstable: boolean;
  summary: boolean;
  text?: string;
  props: Record<string, string | number | boolean | null>;
};
export type Snapshot = {
  v: 1;
  runId: string;
  windowId: string;
  seq: number;
  layoutSeq: number;
  capturedAt: string;
  ts: string;
  cwd: string;
  refreshNonce: string | null;
  health: "ok" | "error";
  lastError: UatError | null;
  window: NativeWindow;
  viewport: { w: number; h: number; scrollX: number; scrollY: number };
  activeTab: TabSummary;
  tabs: TabSummary[];
  elements: (ElementSnapshot | Secret)[];
  dupes: string[];
};
export type RefreshRequest = {
  v: 1;
  runId: string;
  windowId: string;
  nonce: string;
  afterSeq: number;
  requestedAt: string;
};
export type Context = { cwd: string; tabs: TabSummary[] };
export type Session = {
  runId: string;
  windowId: string;
  cwd: string;
  seq: number;
  layoutSeq: number;
};
export type Geometry = { window: NativeWindow; generation: number };
export type Controller = {
  update: (context: Context) => void;
  stop: () => Promise<void>;
};
