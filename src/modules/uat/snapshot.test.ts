// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectSnapshot,
  mountCollector,
  type CollectorIO,
} from "@/modules/uat/snapshot";
import { conforms } from "@/modules/uat/schema.test";
import type {
  Context,
  Geometry,
  RefreshRequest,
  Session,
  Snapshot,
  UatError,
} from "@/modules/uat/types";

const context: Context = {
  cwd: "/project",
  tabs: [
    { uat: "tab-active", key: "1", kind: "pi", title: "Chat", active: true },
    { uat: "tab", key: "2", kind: "terminal", title: "Shell", active: false },
  ],
};
const session: Session = {
  cwd: "/project",
  runId: "run",
  windowId: "main",
  seq: 0,
  layoutSeq: 0,
};
const geometry: Geometry = {
  generation: 1,
  window: {
    x: 100,
    y: 200,
    w: 800,
    h: 600,
    scale: 2,
    cssToPoint: 1,
    driverUnits: "macos-points",
    driverOrigin: { x: 50, y: 100 },
    contentOffset: { x: 1, y: 28 },
    displayId: "main",
    displayPhysicalOrigin: { x: 0, y: 0 },
    displayDriverOrigin: { x: 0, y: 0 },
    coordinateStatus: "supported",
  },
};

function collect() {
  return collectSnapshot(document, window, context, session, geometry, 1, null);
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const x = Number(this.getAttribute("data-test-x") || 20);
      const y = Number(this.getAttribute("data-test-y") || 30);
      return {
        x,
        y,
        width: 80,
        height: 40,
        top: y,
        left: x,
        right: x + 80,
        bottom: y + 40,
        toJSON: () => ({}),
      };
    },
  );
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() =>
      document.querySelector("button, input, [contenteditable=true]"),
    ),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DOM snapshot", () => {
  it("scopes K4 repeats to terminal leaves, board columns and keystone questions", () => {
    document.body.innerHTML = `
      <div data-uat="terminal-tab" data-uat-key="leaf-a"><button data-uat="composer-toggle"></button><div data-uat="terminal-block" data-uat-key="1" data-uat-index="0"><button data-uat="copy"></button></div></div>
      <div data-uat="terminal-tab" data-uat-key="leaf-b"><button data-uat="composer-toggle"></button><div data-uat="terminal-block" data-uat-key="1" data-uat-index="0"><button data-uat="copy"></button></div></div>
      <div data-uat="board-columns" data-uat-key="todo" data-uat-index="0"><button data-uat="board-ticket" data-uat-key="ticket-a" data-uat-index="0"></button></div>
      <div data-uat="board-columns" data-uat-key="done" data-uat-index="1"><button data-uat="board-ticket" data-uat-key="ticket-b" data-uat-index="0"></button></div>
      <div data-uat="keystone-card" data-uat-key="request"><button data-uat="keystone-option" data-uat-key="question-a:yes" data-uat-index="0"></button><button data-uat="keystone-option" data-uat-key="question-b:yes" data-uat-index="0"></button></div>`;
    const snapshot = collect();
    expect(snapshot.dupes).toEqual([]);
    expect(
      snapshot.elements.filter((el) => el.uat === "copy").map((el) => el.scope),
    ).toEqual(["terminal:leaf-a/block:1", "terminal:leaf-b/block:1"]);
    expect(
      snapshot.elements
        .filter((el) => el.uat === "board-ticket")
        .map((el) => el.scope),
    ).toEqual(["column:todo", "column:done"]);
    expect(conforms(snapshot)).toBe(true);
  });
  it("conforms to the full file schema and uses viewport CSS coordinates", () => {
    document.body.innerHTML =
      '<button data-uat="settings-button">Settings</button>';
    const snapshot = collect();
    expect(conforms(snapshot)).toBe(true);
    expect(snapshot.elements[0]).toMatchObject({
      uat: "settings-button",
      index: null,
      rect: { x: 20, y: 30, w: 80, h: 40 },
      interactable: true,
    });
    expect(snapshot.window.contentOffset.y).toBe(28);
    expect(snapshot.ts >= snapshot.capturedAt).toBe(true);
  });

  it("keeps copy attached to a durable turn while repeat indices move", () => {
    document.body.innerHTML =
      '<div data-uat="pi-turn" data-uat-key="t7" data-uat-index="0"><button data-uat="copy">Copy</button></div><div data-uat="pi-turn" data-uat-key="t8" data-uat-index="1"><button data-uat="copy">Copy</button></div>';
    const before = collect();
    expect(before.dupes).toEqual([]);
    expect(before.elements.filter((el) => el.uat === "copy")).toMatchObject([
      { scope: "turn:t7", key: "turn:t7/copy", index: null },
      { scope: "turn:t8", key: "turn:t8/copy", index: null },
    ]);
    document
      .querySelector('[data-uat-key="t7"]')!
      .setAttribute("data-uat-index", "1");
    document
      .querySelector('[data-uat-key="t8"]')!
      .setAttribute("data-uat-index", "2");
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<div data-uat="pi-turn" data-uat-key="t6" data-uat-index="0"></div>',
    );
    const after = collect();
    expect(after.elements.find((el) => el.key === "t7")).toMatchObject({
      index: 1,
    });
    expect(after.elements.find((el) => el.key === "turn:t7/copy")).toEqual(
      before.elements.find((el) => el.key === "turn:t7/copy"),
    );
  });

  it("indexes repeated entities without manufacturing durable keys from positions", () => {
    document.body.innerHTML =
      '<button data-uat="item" data-uat-scope="list" data-uat-key="a">A</button><button data-uat="item" data-uat-scope="list" data-uat-key="b">B</button>';
    expect(collect().elements.slice(0, 2)).toMatchObject([
      { index: 0, key: "a" },
      { index: 1, key: "b" },
    ]);
    document.querySelectorAll("button")[1].setAttribute("data-uat-key", "a");
    const bad = collect();
    expect(bad.dupes).toHaveLength(2);
    expect(bad.health).toBe("error");
    expect(bad.elements.every((el) => "secret" in el || !el.interactable)).toBe(
      true,
    );
    expect(conforms(bad)).toBe(true);
  });

  it("serializes only secret presence and never traverses a secret surface", () => {
    document.body.innerHTML =
      '<div data-uat="credential" data-uat-secret data-uat-key="cloud" aria-label="SENSITIVE"><button data-uat="nested-secret">SENSITIVE</button></div><input type="password" data-uat="settings-secret" data-uat-key="provider" value="SENSITIVE"><input type="password" value="SENSITIVE">';
    const snapshot = collect();
    expect(snapshot.elements.filter((el) => "secret" in el)).toHaveLength(2);
    expect(snapshot.elements.some((el) => el.uat === "nested-secret")).toBe(
      false,
    );
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE");
    for (const el of snapshot.elements.filter((el) => "secret" in el))
      expect(Object.keys(el).sort()).toEqual([
        "index",
        "key",
        "scope",
        "secret",
        "uat",
      ]);
    expect(conforms(snapshot)).toBe(true);
  });

  it("emits one hidden tab summary and prunes its entire subtree", () => {
    document.body.innerHTML =
      '<div data-uat="terminal-tab" data-uat-key="2" data-uat-hidden-report data-uat-count="3" aria-hidden="true"><button data-uat="hidden-button" data-uat-text>SENSITIVE</button></div>';
    const hiddenRoot = document.querySelector("div")!;
    const children = vi.spyOn(hiddenRoot, "children", "get");
    const snapshot = collect();
    expect(children).not.toHaveBeenCalled();
    expect(snapshot.elements).toEqual([
      expect.objectContaining({
        uat: "terminal-tab",
        summary: true,
        hidden: true,
        rect: null,
        hitRect: null,
        interactable: false,
        label: "",
        props: { kind: "terminal", count: 3 },
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE");
    expect(conforms(snapshot)).toBe(true);
  });

  it("does not serialize buffers, transcript bodies, argv, env or images despite text opt-in", () => {
    document.body.innerHTML =
      '<div data-uat="answer-body" data-uat-text>SENSITIVE<span data-uat="session-status" data-uat-text>SENSITIVE</span></div><textarea data-uat="composer-input" data-uat-text>SENSITIVE</textarea><div data-uat="terminal-emulator" data-uat-text>SENSITIVE</div><div data-uat="editor-input" data-uat-text>SENSITIVE</div><iframe data-uat="artifact-frame" src="data:image/png;base64,SENSITIVE"></iframe><span data-uat="session-status" data-uat-text data-uat-props=\'{"argv":"SENSITIVE","env":"SENSITIVE","status":"ready"}\'> Ready   now </span>';
    const snapshot = collect();
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE");
    expect(
      snapshot.elements.find((el) => el.uat === "session-status"),
    ).toMatchObject({ text: "Ready now", props: { status: "ready" } });
    expect(conforms(snapshot)).toBe(true);
  });

  it("refuses disabled, occluded, empty and offscreen controls", () => {
    document.body.innerHTML =
      '<button data-uat="settings-button" disabled>Settings</button><button data-uat="offscreen" data-test-x="-100">Offscreen</button>';
    expect(
      collect()
        .elements.filter((el) => !("secret" in el))
        .every((el) => "secret" in el || !el.interactable),
    ).toBe(true);
    document.querySelector("button")!.removeAttribute("disabled");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.body,
    });
    expect(collect().elements[0]).toMatchObject({ interactable: false });
    document.querySelector("button")!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 0, 0);
    expect(collect().elements[0]).toMatchObject({
      hitRect: null,
      interactable: false,
    });
  });

  it("clips scroll-container bounds and observes checked and unstable state", () => {
    document.body.innerHTML =
      '<div style="overflow:hidden"><input type="checkbox" checked data-uat="terminal-composer-default" data-uat-unstable></div>';
    const parent = document.querySelector("div")!;
    Object.defineProperties(parent, {
      clientWidth: { value: 50 },
      clientHeight: { value: 25 },
    });
    expect(collect().elements[0]).toMatchObject({
      hitRect: { x: 20, y: 30, w: 50, h: 25 },
      checked: true,
      unstable: true,
    });
  });
});

function harness() {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(
    (callback) => setTimeout(() => callback(0), 16) as unknown as number,
  );
  let refresh!: (request: RefreshRequest) => void;
  let health!: (error: UatError) => void;
  let nativeChange!: () => void;
  const writes: Snapshot[] = [];
  let count = 0;
  const io: CollectorIO = {
    start: vi.fn(async () => ({ ...session })),
    stop: vi.fn(async () => {}),
    geometry: vi.fn(async () => structuredClone(geometry)),
    write: vi.fn(async (snapshot) => {
      writes.push(structuredClone(snapshot));
      return { seq: snapshot.seq, ts: snapshot.ts };
    }),
    failure: vi.fn(async (code) => ({
      code,
      message: "Cannot write",
      at: new Date().toISOString(),
      consecutiveFailures: ++count,
      logPath: ".pi/logs/uat.jsonl",
    })),
    subscribe: vi.fn(async (r, h, g) => {
      refresh = r;
      health = h;
      nativeChange = g;
      return vi.fn();
    }),
  };
  return {
    io,
    writes,
    refresh: (nonce: string) =>
      refresh({
        v: 1,
        runId: "run",
        windowId: "main",
        nonce,
        afterSeq: writes.slice(-1)[0]?.seq ?? 0,
        requestedAt: new Date().toISOString(),
      }),
    health: (error: UatError) => health(error),
    nativeChange: () => nativeChange(),
  };
}

describe("paced collector", () => {
  it("keeps invalid refresh health visible until a valid refresh recovers", async () => {
    const h = harness();
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(40);
    h.health({
      code: "NONCE_REUSED",
      message: "Nonce was already used",
      at: new Date().toISOString(),
      consecutiveFailures: 1,
      logPath: ".pi/logs/uat.jsonl",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.writes.slice(-1)[0].health).toBe("error");
    expect(document.querySelector('[data-uat="uat-health"]')).not.toBeNull();
    h.refresh("valid-recovery");
    await vi.advanceTimersByTimeAsync(600);
    expect(h.writes.slice(-1)[0]).toMatchObject({
      health: "ok",
      refreshNonce: "valid-recovery",
    });
    expect(document.querySelector('[data-uat="uat-health"]')).toBeNull();
    await collector.stop();
  });
  it("does not rebind a project when Rust canonicalizes its path", async () => {
    const h = harness();
    vi.mocked(h.io.start).mockResolvedValue({
      ...session,
      cwd: "/canonical/project",
    });
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(40);
    h.refresh("canonical");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.io.start).toHaveBeenCalledOnce();
    expect(h.writes.slice(-1)[0]).toMatchObject({
      cwd: "/canonical/project",
      refreshNonce: "canonical",
    });
    await collector.stop();
  });

  it("counts each failed write once when Rust also emits a health event", async () => {
    const h = harness();
    let failures = 0;
    vi.mocked(h.io.write).mockImplementation(async () => {
      h.health({
        code: "WRITE_FAILED",
        message: "Project is unwritable",
        at: new Date().toISOString(),
        consecutiveFailures: ++failures,
        logPath: ".pi/logs/uat.jsonl",
      });
      throw "WRITE_FAILED: Project is unwritable";
    });
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.io.write).toHaveBeenCalledTimes(3);
    expect(h.io.failure).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-uat="uat-health"]')!.textContent,
    ).toContain("Project is unwritable");
    await collector.stop();
  });
  it("writes after first paint, coalesces mutations, stays idle and cannot starve during continuous mutation", async () => {
    const h = harness();
    document.body.innerHTML =
      '<button data-uat="settings-button">Settings</button>';
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(40);
    expect(h.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11000);
    expect(h.writes).toHaveLength(1);
    for (let i = 0; i < 50; i++) {
      document.querySelector("button")!.setAttribute("data-tick", String(i));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(h.writes.length).toBeGreaterThanOrEqual(4);
    expect(h.writes.length).toBeLessThanOrEqual(6);
    expect(h.writes.map((snapshot) => snapshot.seq)).toEqual(
      h.writes.map((_, i) => i + 1),
    );
    expect(h.writes.every((snapshot) => conforms(snapshot))).toBe(true);
    await collector.stop();
  });

  it("acknowledges refresh nonces after idle and invalidates for scroll, resize, tab and native scale changes", async () => {
    const h = harness();
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(40);
    h.refresh("first");
    await vi.advanceTimersByTimeAsync(270);
    expect(h.writes.slice(-1)[0]).toMatchObject({
      refreshNonce: "first",
      seq: 2,
    });
    const before = h.writes.slice(-1)[0]!.layoutSeq;
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    h.nativeChange();
    collector.update({
      ...context,
      tabs: context.tabs.map((tab) => ({ ...tab, active: tab.key === "2" })),
    });
    h.refresh("second");
    await vi.advanceTimersByTimeAsync(270);
    expect(h.writes.slice(-1)[0]!.layoutSeq).toBeGreaterThanOrEqual(before + 5);
    expect(h.writes.slice(-1)[0]).toMatchObject({
      refreshNonce: "second",
      activeTab: { key: "2" },
      seq: 3,
    });
    await collector.stop();
  });

  it("discards changing native geometry and retries without consuming the sequence or nonce", async () => {
    const h = harness();
    vi.mocked(h.io.geometry).mockResolvedValueOnce({
      ...geometry,
      generation: 0,
    });
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(40);
    expect(h.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(270);
    expect(h.writes[0].seq).toBe(1);
    await collector.stop();
  });

  it("stops automatic writes after three failures and refresh performs one recovery attempt", async () => {
    const h = harness();
    vi.mocked(h.io.write).mockRejectedValue(new Error("denied"));
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.io.write).toHaveBeenCalledTimes(3);
    expect(
      document.querySelector('[data-uat="uat-health"]')!.textContent,
    ).toContain("UAT snapshot unavailable");
    document.body.setAttribute("data-mutation", "yes");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.io.write).toHaveBeenCalledTimes(3);
    h.refresh("failed-recovery");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.io.write).toHaveBeenCalledTimes(4);
    vi.mocked(h.io.write).mockImplementation(async (snapshot) => {
      h.writes.push(snapshot);
      return { seq: snapshot.seq, ts: snapshot.ts };
    });
    document
      .querySelector<HTMLButtonElement>('[data-uat="uat-retry"]')!
      .click();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.writes[0]).toMatchObject({
      refreshNonce: "failed-recovery",
      health: "ok",
    });
    expect(document.querySelector('[data-uat="uat-health"]')).toBeNull();
    await collector.stop();
  });

  it("shows invalid refresh errors from the watcher and removes all observers on stop", async () => {
    const h = harness();
    const collector = await mountCollector(context, h.io);
    await vi.advanceTimersByTimeAsync(40);
    h.health({
      code: "NONCE_REUSED",
      message: "Refresh nonce reused",
      at: new Date().toISOString(),
      consecutiveFailures: 3,
      logPath: ".pi/logs/uat.jsonl",
    });
    expect(
      document.querySelector('[data-uat="uat-health"]')!.textContent,
    ).toContain("Refresh nonce reused");
    await collector.stop();
    document.body.setAttribute("data-after-stop", "yes");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.writes).toHaveLength(1);
    expect(h.io.stop).toHaveBeenCalledOnce();
  });
});
