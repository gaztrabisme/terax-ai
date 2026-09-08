import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Context,
  Controller,
  ElementSnapshot,
  Geometry,
  Identity,
  Rect,
  RefreshRequest,
  Secret,
  Session,
  Snapshot,
  UatError,
} from "@/modules/uat/types";

const PACE_MS = 250;
const CAP = 262144;
const SECRET = '[data-uat-secret], input[type="password"]';
const BODIES = new Set([
  "editor-input",
  "artifact-frame",
  "terminal-emulator",
  "terminal-composer",
  "composer-input",
  "turn-user",
  "answer-body",
  "child-transcript",
]);
const TEXT_IDS = new Set([
  "session-status",
  "turn-tokens",
  "session-cost",
  "usage-footer",
  "terminal-exit-ok",
  "terminal-exit-failed",
  "cache-qualifier",
  "uat-health",
]);
const ENTITIES: Record<string, string> = {
  "board-columns": "column",
  "pi-turn": "turn",
  "terminal-block": "block",
  "child-card": "child",
  "tool-row": "action",
  "board-ticket": "ticket",
  "session-row": "session",
  "ticket-sheet": "ticket",
  "keystone-card": "keystone",
  "graph-child": "agent",
};
const LABELS: Record<string, string> = {
  "settings-button": "Settings",
  "send-button": "Send",
  "stop-button": "Stop",
  "new-session": "New session",
  copy: "Copy",
  "copy-markdown": "Copy Markdown",
  "composer-input": "Chat input",
  "terminal-emulator": "Terminal",
  "editor-input": "Editor",
  "uat-retry": "Retry",
  "uat-health": "UAT snapshot health",
};
const PROPS = new Set(
  "kind status mode returnMode count runningCount doneCount role agentId ticketId actionId sessionId turnId submissionId sourceEventId inputTokens outputTokens cacheReadTokens cost currency durationMs exit path sha256 source stale gateSource gateVerdict".split(
    " ",
  ),
);
const ROLES = new Set(
  "textbox button checkbox radio tab group pane status block link list row frame separator".split(
    " ",
  ),
);

function compact(text: string): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, 200).join("");
}

function viewport(win: Window): Snapshot["viewport"] {
  return {
    w: win.visualViewport?.width ?? win.innerWidth,
    h: win.visualViewport?.height ?? win.innerHeight,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
  };
}

function rectangle(el: Element, win: Window): Rect {
  const rect = el.getBoundingClientRect();
  return {
    x: rect.x - (win.visualViewport?.offsetLeft ?? 0),
    y: rect.y - (win.visualViewport?.offsetTop ?? 0),
    w: Math.max(0, rect.width),
    h: Math.max(0, rect.height),
  };
}

function intersection(
  a: Rect,
  b: Rect,
  clipX = true,
  clipY = true,
): Rect | null {
  const x = clipX ? Math.max(a.x, b.x) : a.x;
  const y = clipY ? Math.max(a.y, b.y) : a.y;
  const w = (clipX ? Math.min(a.x + a.w, b.x + b.w) : a.x + a.w) - x;
  const h = (clipY ? Math.min(a.y + a.h, b.y + b.h) : a.y + a.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function hitRectangle(el: Element, rect: Rect, win: Window): Rect | null {
  const view = viewport(win);
  let hit = intersection(rect, { x: 0, y: 0, w: view.w, h: view.h });
  for (
    let parent = el.parentElement;
    parent && hit;
    parent = parent.parentElement
  ) {
    const style = win.getComputedStyle(parent);
    const clipX = /hidden|clip|scroll|auto/.test(
      style.overflowX || style.overflow,
    );
    const clipY = /hidden|clip|scroll|auto/.test(
      style.overflowY || style.overflow,
    );
    if (clipX || clipY) {
      const bounds = rectangle(parent, win);
      const scaleX =
        parent instanceof HTMLElement && parent.offsetWidth
          ? bounds.w / parent.offsetWidth
          : 1;
      const scaleY =
        parent instanceof HTMLElement && parent.offsetHeight
          ? bounds.h / parent.offsetHeight
          : 1;
      const clip = {
        x: bounds.x + parent.clientLeft * scaleX,
        y: bounds.y + parent.clientTop * scaleY,
        w: parent.clientWidth * scaleX,
        h: parent.clientHeight * scaleY,
      };
      hit = intersection(hit, clip, clipX, clipY);
    }
  }
  return hit;
}

function roleFor(el: Element, uat: string): ElementSnapshot["role"] {
  const explicit = el.getAttribute("data-uat-role") || el.getAttribute("role");
  if (explicit && ROLES.has(explicit))
    return explicit as ElementSnapshot["role"];
  if (el.matches('input[type="checkbox"]')) return "checkbox";
  if (el.matches('input[type="radio"]')) return "radio";
  if (
    el.matches("input, textarea, [contenteditable=true]") ||
    /-input$/.test(uat)
  )
    return "textbox";
  if (el.matches("button, summary")) return "button";
  if (el.matches("a[href]")) return "link";
  if (el.matches("iframe") || uat === "artifact-frame") return "frame";
  if (uat === "pi-turn" || uat === "terminal-block") return "block";
  if (uat.endsWith("-tab") || uat.endsWith("-pane") || uat === "sidebar")
    return "pane";
  if (uat.endsWith("-row")) return "row";
  if (uat.endsWith("-list")) return "list";
  if (TEXT_IDS.has(uat)) return "status";
  return "group";
}

function propsFor(el: Element): ElementSnapshot["props"] {
  const props: ElementSnapshot["props"] = {};
  const raw = el.getAttribute("data-uat-props");
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("COLLECTOR_FAILED");
    for (const [key, value] of Object.entries(parsed)) {
      if (
        PROPS.has(key) &&
        (value === null ||
          ["string", "number", "boolean"].includes(typeof value))
      ) {
        props[key] = value as string | number | boolean | null;
      }
    }
  }
  for (const key of PROPS) {
    const attr = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const value = el.getAttribute(`data-uat-${attr}`);
    if (value === null) continue;
    if (
      /^(count|runningCount|doneCount|inputTokens|outputTokens|cacheReadTokens|durationMs|cost)$/.test(
        key,
      )
    )
      props[key] = value === "null" ? null : Number(value);
    else if (key === "stale") props[key] = value === "true";
    else if (key === "exit" && /^-?\d+$/.test(value))
      props[key] = Number(value);
    else props[key] = value === "null" ? null : value;
  }
  if (
    typeof props.path === "string" &&
    (!props.path ||
      /^[\/\\]|^[A-Za-z]:/.test(props.path) ||
      props.path.split(/[\/\\]/).some((part) => part === ".." || part === "."))
  ) {
    delete props.path;
  }
  return props;
}

function identityFor(
  el: Element,
  uat: string,
  tab: string,
  parentScope: string,
): Identity {
  const explicitScope = el.getAttribute("data-uat-scope");
  const rawKey = el.getAttribute("data-uat-key");
  const collection =
    uat === "keystone-option" && rawKey?.includes(":")
      ? `${parentScope}/question:${rawKey.split(":")[0]}`
      : parentScope;
  const scope = explicitScope || collection || tab;
  const rawIndex = el.getAttribute("data-uat-index");
  if (rawIndex !== null && !/^\d+$/.test(rawIndex))
    throw new Error("COLLECTOR_FAILED");
  const index = rawIndex === null ? null : Number(rawIndex);
  const key = rawKey
    ? explicitScope || ENTITIES[uat] || uat === "tab" || uat === "tab-active"
      ? rawKey
      : `${rawKey}/${uat}`
    : `${scope}/${uat}`;
  return { uat, scope, index, key };
}

export function qualified(element: Identity): string {
  return `${element.uat}@${element.index} scope=${element.scope} key=${element.key}`;
}

export function duplicateTargets(elements: Identity[]): string[] {
  const tuples = new Map<string, string>();
  const keys = new Map<string, string>();
  const dupes = new Set<string>();
  for (const el of elements) {
    const target = qualified(el);
    for (const [map, key] of [
      [tuples, JSON.stringify([el.uat, el.scope, el.index])],
      [keys, JSON.stringify([el.scope, el.key])],
    ] as const) {
      const previous = map.get(key);
      if (previous) {
        dupes.add(previous);
        dupes.add(target);
      }
      map.set(key, target);
    }
  }
  return [...dupes].sort();
}

function hiddenSummary(
  tab: Context["tabs"][number],
  props: ElementSnapshot["props"] = {},
): ElementSnapshot {
  return {
    uat: `${tab.kind}-tab`,
    scope: tab.key,
    index: null,
    key: `${tab.key}/summary`,
    role: "pane",
    label: "",
    rect: null,
    hitRect: null,
    enabled: false,
    checked: null,
    hidden: true,
    interactable: false,
    unstable: false,
    summary: true,
    props: { kind: tab.kind, ...props },
  };
}

export function collectSnapshot(
  doc: Document,
  win: Window,
  context: Context,
  session: Session,
  geometry: Geometry,
  layoutSeq: number,
  refreshNonce: string | null,
): Snapshot {
  const activeTab = context.tabs.find((tab) => tab.active);
  if (!activeTab || context.tabs.filter((tab) => tab.active).length !== 1)
    throw new Error("COLLECTOR_FAILED");
  const capturedAt = new Date().toISOString();
  const elements: (ElementSnapshot | Secret)[] = [];
  const summaries = new Map(
    context.tabs
      .filter((tab) => !tab.active)
      .map((tab) => [tab.key, hiddenSummary(tab)]),
  );
  const visit = (el: Element, parentScope: string, tabKey: string) => {
    if (el.matches("script, style, template, svg, canvas")) return;
    const uat = el.getAttribute("data-uat");
    const style = win.getComputedStyle(el);
    const hidden =
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.opacity === "0" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse";
    if (hidden) {
      if (el.hasAttribute("data-uat-hidden-report")) {
        const key = el.getAttribute("data-uat-key") || tabKey;
        const tab = context.tabs.find((tab) => tab.key === key && !tab.active);
        if (tab) {
          const props = propsFor(el);
          summaries.set(
            key,
            hiddenSummary(
              tab,
              Object.fromEntries(
                Object.entries(props).filter(([key]) =>
                  ["kind", "count", "runningCount", "doneCount"].includes(key),
                ),
              ),
            ),
          );
        }
      }
      return;
    }
    if (uat && /^(pi|terminal|editor|child)-tab$/.test(uat)) {
      const candidate = el.getAttribute("data-uat-key");
      if (candidate && context.tabs.some((tab) => tab.key === candidate))
        tabKey = candidate;
      parentScope = tabKey;
    }
    const secret = el.matches(SECRET);
    if (uat) {
      const identity = identityFor(el, uat, tabKey, parentScope);
      if (secret) elements.push({ ...identity, secret: true });
      else {
        const rect = rectangle(el, win);
        const hitRect = hitRectangle(el, rect, win);
        const center =
          hitRect &&
          doc.elementFromPoint?.(
            hitRect.x + hitRect.w / 2 + (win.visualViewport?.offsetLeft ?? 0),
            hitRect.y + hitRect.h / 2 + (win.visualViewport?.offsetTop ?? 0),
          );
        const enabled =
          !el.matches(":disabled") &&
          !el.closest('[aria-disabled="true"], [inert]');
        const role = roleFor(el, uat);
        const actionable =
          ["button", "checkbox", "radio", "tab", "textbox", "link"].includes(
            role,
          ) || uat === "terminal-emulator";
        const unobstructed = !!center && (center === el || el.contains(center));
        const checked = el.matches(
          'input[type="checkbox"], input[type="radio"]',
        )
          ? (el as HTMLInputElement).checked
          : el.hasAttribute("aria-checked")
            ? el.getAttribute("aria-checked") === "true"
            : null;
        const label =
          LABELS[uat] ||
          (BODIES.has(uat)
            ? uat
            : el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              uat.replace(/-/g, " "));
        const row: ElementSnapshot = {
          ...identity,
          role,
          label: compact(label),
          rect,
          hitRect,
          enabled,
          checked,
          hidden: false,
          interactable:
            enabled &&
            actionable &&
            !!hitRect &&
            unobstructed &&
            style.pointerEvents !== "none" &&
            style.opacity !== "0",
          unstable: el.hasAttribute("data-uat-unstable"),
          summary: false,
          props: propsFor(el),
        };
        if (
          el.hasAttribute("data-uat-text") &&
          TEXT_IDS.has(uat) &&
          !el.querySelector(SECRET)
        )
          row.text = compact(el.textContent || "");
        elements.push(row);
        if (ENTITIES[uat] && el.getAttribute("data-uat-key")) {
          const key = el.getAttribute("data-uat-key")!;
          const entity = key.startsWith(`${ENTITIES[uat]}:`)
            ? key
            : `${ENTITIES[uat]}:${key}`;
          parentScope =
            uat === "terminal-block" ? `${identity.scope}/${entity}` : entity;
        } else if (uat === "terminal-tab" && el.getAttribute("data-uat-key")) {
          parentScope = `terminal:${el.getAttribute("data-uat-key")}`;
        }
      }
    }
    if (
      secret ||
      (uat && BODIES.has(uat)) ||
      el.matches(
        ".cm-content, .xterm-rows, .tiptap, [contenteditable=true], textarea, iframe",
      )
    )
      return;
    for (const child of el.children) visit(child, parentScope, tabKey);
  };
  if (doc.body) visit(doc.body, activeTab.key, activeTab.key);
  elements.push(...summaries.values());
  const groups = new Map<string, Identity[]>();
  for (const el of elements) {
    const key = JSON.stringify([el.uat, el.scope]);
    const group = groups.get(key) || [];
    group.push(el);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length > 1 && group.every((el) => el.index === null))
      group.forEach((el, i) => {
        el.index = i;
      });
  }
  const dupes = duplicateTargets(elements);
  if (dupes.length)
    for (const el of elements) if (!("secret" in el)) el.interactable = false;
  return {
    v: 1,
    ...session,
    seq: session.seq + 1,
    layoutSeq,
    capturedAt,
    ts: new Date().toISOString(),
    refreshNonce,
    health: dupes.length ? "error" : "ok",
    lastError: dupes.length
      ? {
          code: "DUPLICATE_TARGET",
          message: "Repeated UAT addresses or identities",
          at: capturedAt,
          consecutiveFailures: 1,
          logPath: ".pi/logs/uat.jsonl",
        }
      : null,
    window: geometry.window,
    viewport: viewport(win),
    activeTab,
    tabs: context.tabs,
    elements,
    dupes,
  };
}

export type CollectorIO = {
  start: (cwd: string) => Promise<Session>;
  stop: () => Promise<void>;
  geometry: (view: Snapshot["viewport"]) => Promise<Geometry>;
  write: (snapshot: Snapshot) => Promise<{ seq: number; ts: string }>;
  failure: (code: string) => Promise<UatError>;
  subscribe: (
    refresh: (request: RefreshRequest) => void,
    health: (error: UatError) => void,
    geometry: () => void,
  ) => Promise<() => void>;
};

const nativeIO: CollectorIO = {
  start: (cwd) => invoke("uat_start", { cwd }),
  stop: () => invoke("uat_stop"),
  geometry: (view) =>
    invoke("uat_geometry", { viewportWidth: view.w, viewportHeight: view.h }),
  write: (snapshot) =>
    invoke("uat_write_snapshot", { json: JSON.stringify(snapshot) }),
  failure: (code) => invoke("uat_report_failure", { code }),
  subscribe: async (refresh, health, geometry) => {
    const unlisten: (() => void)[] = [];
    try {
      unlisten.push(
        await listen<RefreshRequest>("uat:refresh", (event) =>
          refresh(event.payload),
        ),
      );
      unlisten.push(
        await listen<UatError>("uat:health", (event) => health(event.payload)),
      );
      unlisten.push(await listen("uat:geometry", geometry));
      return () => {
        for (const stop of unlisten) stop();
      };
    } catch (error) {
      for (const stop of unlisten) stop();
      throw error;
    }
  },
};

function healthBanner(doc: Document, retry: () => void) {
  const banner = doc.createElement("div");
  banner.setAttribute("data-uat", "uat-health");
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:12px;background:#3d1717;color:#fff;border:1px solid #d77;border-radius:6px;font:13px sans-serif;";
  const message = doc.createElement("span");
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Retry";
  button.setAttribute("data-uat", "uat-retry");
  button.style.cssText =
    "margin-left:12px;padding:4px 12px;border:1px solid currentColor;border-radius:4px;";
  button.addEventListener("click", retry);
  banner.append(message, button);
  return {
    show(error: UatError) {
      message.textContent = `UAT snapshot unavailable: ${error.message} Evidence: .pi/uat-status.json; .pi/logs/uat.jsonl`;
      if (!banner.isConnected) doc.body.append(banner);
    },
    clear() {
      banner.remove();
    },
  };
}

export async function mountCollector(
  initial: Context,
  io: CollectorIO = nativeIO,
  doc = document,
  win = window,
): Promise<Controller> {
  let context = initial;
  let session: Session | null = null;
  let boundCwd: string | null = null;
  let disposed = false;
  let dirty = true;
  let layoutSeq = 0;
  let failures = 0;
  let recovery = false;
  let busy: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextOpportunity = 0;
  let frame: { id: number; resolve: () => void } | null = null;
  let lastHealth: UatError | null = null;
  let protocolError: UatError | null = null;
  let acknowledgedNonce: string | null = null;
  const requests: RefreshRequest[] = [];
  const banner = healthBanner(doc, () => {
    recovery = true;
    dirty = true;
    schedule();
  });
  const receiveHealth = (error: UatError) => {
    failures = Math.max(failures, error.consecutiveFailures);
    lastHealth = error;
    if (
      [
        "REFRESH_INVALID",
        "RUN_MISMATCH",
        "WINDOW_UNKNOWN",
        "NONCE_REUSED",
        "FUTURE_SEQUENCE",
        "READ_FAILED",
      ].includes(error.code)
    )
      protocolError = error;
    banner.show(error);
  };
  const invalidate = () => {
    layoutSeq++;
    dirty = true;
    schedule();
  };
  const afterFrame = () =>
    new Promise<void>((resolve) => {
      const id = win.requestAnimationFrame(() => {
        frame = null;
        resolve();
      });
      frame = { id, resolve };
    });
  async function capture() {
    const recovering = recovery;
    const priorFailures = failures;
    recovery = false;
    dirty = false;
    try {
      if (!context.cwd || !context.tabs.some((tab) => tab.active)) return;
      if (!session || boundCwd !== context.cwd) {
        const requestedCwd = context.cwd;
        if (boundCwd !== null) {
          requests.length = 0;
          acknowledgedNonce = null;
          protocolError = null;
        }
        session = await io.start(requestedCwd);
        boundCwd = requestedCwd;
        layoutSeq = Math.max(layoutSeq, session.layoutSeq + 1);
        if (context.cwd !== requestedCwd) {
          dirty = true;
          recovery = recovering;
          return;
        }
      }
      if (disposed) return;
      await afterFrame();
      if (disposed) return;
      const captureContext = context;
      const before = await io.geometry(viewport(win));
      const captureLayout = layoutSeq;
      const request = requests[0];
      const snapshot = collectSnapshot(
        doc,
        win,
        captureContext,
        session,
        before,
        captureLayout,
        request?.nonce ?? acknowledgedNonce,
      );
      if (protocolError && !recovering && !snapshot.dupes.length) {
        snapshot.health = "error";
        snapshot.lastError = protocolError;
        for (const el of snapshot.elements)
          if (!("secret" in el)) el.interactable = false;
      }
      const after = await io.geometry(snapshot.viewport);
      if (
        before.generation !== after.generation ||
        JSON.stringify(before.window) !== JSON.stringify(after.window) ||
        captureContext !== context
      ) {
        dirty = true;
        recovery = recovering;
        return;
      }
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length > CAP)
        throw new Error("SNAPSHOT_TOO_LARGE");
      if (snapshot.dupes.length) {
        const error = await io.failure("DUPLICATE_TARGET");
        snapshot.lastError = error;
        receiveHealth(error);
      }
      if (disposed) return;
      const committed = await io.write(snapshot);
      session.seq = committed.seq;
      session.layoutSeq = captureLayout;
      if (request) {
        requests.shift();
        acknowledgedNonce = request.nonce;
      }
      if (snapshot.health === "ok") {
        failures = 0;
        lastHealth = null;
        protocolError = null;
        banner.clear();
      } else if (snapshot.dupes.length) dirty = true;
      if (captureLayout !== layoutSeq || requests.length) dirty = true;
    } catch (error) {
      const code = String(error)
        .replace(/^Error: /, "")
        .split(":")[0];
      if (code === "GEOMETRY_CHANGED") {
        dirty = true;
        recovery = recovering;
        return;
      }
      failures = Math.max(priorFailures + 1, failures);
      dirty = true;
      const known = code === "SNAPSHOT_TOO_LARGE" ? code : "COLLECTOR_FAILED";
      const fallback: UatError = {
        code: known,
        message:
          known === "SNAPSHOT_TOO_LARGE"
            ? "Snapshot exceeds 262144 bytes"
            : "Snapshot capture or write failed",
        at: new Date().toISOString(),
        consecutiveFailures: failures,
        logPath: ".pi/logs/uat.jsonl",
      };
      // Rust already records write errors without reflecting payload text.
      const backendError = /^[A-Z_]+:/.test(String(error));
      if (!backendError) {
        try {
          receiveHealth(await io.failure(known));
        } catch {
          receiveHealth(fallback);
        }
      } else
        receiveHealth(
          lastHealth?.consecutiveFailures === failures
            ? lastHealth
            : { ...fallback, message: compact(String(error)) },
        );
    }
  }
  function schedule() {
    if (disposed || timer || busy || !dirty || (failures >= 3 && !recovery))
      return;
    timer = setTimeout(
      () => {
        timer = null;
        if (disposed || (failures >= 3 && !recovery)) return;
        nextOpportunity = Date.now() + PACE_MS;
        busy = capture().finally(() => {
          busy = null;
          schedule();
        });
      },
      Math.max(0, nextOpportunity - Date.now()),
    );
  }
  const unsubscribe = await io.subscribe(
    (request) => {
      if (
        !session ||
        (request.runId === session.runId &&
          request.windowId === session.windowId)
      ) {
        requests.push(request);
        recovery = true;
        invalidate();
      }
    },
    receiveHealth,
    invalidate,
  );
  const mutation = new MutationObserver(invalidate);
  mutation.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const resized = new Set<Element>();
  const resize =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(invalidate);
  const observeSizes = () => {
    const live = new Set<Element>([
      doc.documentElement,
      ...doc.querySelectorAll("[data-uat]"),
    ]);
    for (const el of resized)
      if (!live.has(el)) {
        resize?.unobserve(el);
        resized.delete(el);
      }
    for (const el of live)
      if (!resized.has(el)) {
        resize?.observe(el);
        resized.add(el);
      }
  };
  const additions = new MutationObserver(observeSizes);
  additions.observe(doc.documentElement, { subtree: true, childList: true });
  observeSizes();
  doc.addEventListener("scroll", invalidate, true);
  doc.addEventListener("visibilitychange", invalidate);
  win.addEventListener("resize", invalidate);
  win.addEventListener("focus", invalidate);
  win.visualViewport?.addEventListener("resize", invalidate);
  win.visualViewport?.addEventListener("scroll", invalidate);
  let scaleQuery: MediaQueryList | null = null;
  const scaleChange = () => {
    scaleQuery?.removeEventListener("change", scaleChange);
    scaleQuery =
      win.matchMedia?.(`(resolution: ${win.devicePixelRatio}dppx)`) ?? null;
    scaleQuery?.addEventListener("change", scaleChange);
    invalidate();
  };
  scaleChange();
  schedule();
  return {
    update(next) {
      context = next;
      invalidate();
    },
    async stop() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      if (frame) {
        win.cancelAnimationFrame(frame.id);
        frame.resolve();
        frame = null;
      }
      unsubscribe();
      mutation.disconnect();
      additions.disconnect();
      resize?.disconnect();
      doc.removeEventListener("scroll", invalidate, true);
      doc.removeEventListener("visibilitychange", invalidate);
      win.removeEventListener("resize", invalidate);
      win.removeEventListener("focus", invalidate);
      win.visualViewport?.removeEventListener("resize", invalidate);
      win.visualViewport?.removeEventListener("scroll", invalidate);
      scaleQuery?.removeEventListener("change", scaleChange);
      banner.clear();
      await busy;
      if (session) await io.stop();
    },
  };
}
