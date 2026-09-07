// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildComposerExtensions,
  composerKeyDecision,
  composerSubmitPayload,
  observeTerminalModes,
  type ComposerKeyEvent,
} from "./TerminalComposer";

beforeAll(() => {
  // jsdom lacks Range.getClientRects, which CodeMirror's rAF measure pass
  // calls right after the first view render; stub it so the callback is a
  // no-op instead of an uncaught error.
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function () {
      return [] as unknown as DOMRectList;
    };
  }
  if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = function () {
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect;
    };
  }
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("composerSubmitPayload", () => {
  it("wraps the line in bracketed paste and appends a carriage return", () => {
    expect(composerSubmitPayload("ls -la", true)).toBe(
      `${BRACKETED_PASTE_START}ls -la${BRACKETED_PASTE_END}\r`,
    );
  });

  it("sends plain text when the shell did not enable mode 2004", () => {
    expect(composerSubmitPayload("ls", false)).toBe("ls\r");
  });

  it("collapses newlines to spaces, preserving length", () => {
    const payload = composerSubmitPayload("echo a\nb\rc", true);
    // Only the inner line must be newline-free; the payload legitimately
    // ends with the carriage return that runs the command.
    const inner = payload.slice(
      BRACKETED_PASTE_START.length,
      payload.length - BRACKETED_PASTE_END.length - 1,
    );
    expect(inner).toBe("echo a b c");
    expect(composerSubmitPayload("a\r\nb", false)).toBe("a  b\r");
  });
});

describe("composerKeyDecision", () => {
  const key = (over: Partial<ComposerKeyEvent>) => ({
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  const state = (isEmpty: boolean, hasSelection = false) => ({
    isEmpty,
    hasSelection,
  });

  it("submits on Enter, empty or not", () => {
    expect(composerKeyDecision(key({ key: "Enter" }), state(true))).toEqual({
      action: "submit",
    });
    expect(composerKeyDecision(key({ key: "Enter" }), state(false))).toEqual({
      action: "submit",
    });
  });

  it("Shift+Enter is a no-op in the single-line composer", () => {
    expect(
      composerKeyDecision(key({ key: "Enter", shiftKey: true }), state(false)),
    ).toEqual({ action: "noop" });
  });

  it("forwards Ctrl+C, Ctrl+D and Ctrl+L as raw bytes", () => {
    expect(
      composerKeyDecision(key({ key: "c", ctrlKey: true }), state(false)),
    ).toEqual({ action: "pty", data: "\x03" });
    expect(
      composerKeyDecision(key({ key: "d", ctrlKey: true }), state(true)),
    ).toEqual({ action: "pty", data: "\x04" });
    expect(
      composerKeyDecision(key({ key: "l", ctrlKey: true }), state(true)),
    ).toEqual({ action: "pty", data: "\x0c" });
  });

  it("lets the browser copy when Ctrl+C has a selection", () => {
    expect(
      composerKeyDecision(
        key({ key: "c", ctrlKey: true }),
        state(false, true),
      ),
    ).toEqual({ action: "default" });
  });

  it("forwards Tab so shell completion still works", () => {
    expect(composerKeyDecision(key({ key: "Tab" }), state(true))).toEqual({
      action: "pty",
      data: "\t",
    });
    expect(composerKeyDecision(key({ key: "Tab" }), state(false))).toEqual({
      action: "pty",
      data: "\t",
    });
  });

  it("forwards Up and Down only while empty; otherwise the cursor moves", () => {
    expect(
      composerKeyDecision(key({ key: "ArrowUp" }), state(true)),
    ).toEqual({ action: "pty", data: "\x1b[A" });
    expect(
      composerKeyDecision(key({ key: "ArrowDown" }), state(true)),
    ).toEqual({ action: "pty", data: "\x1b[B" });
    expect(
      composerKeyDecision(key({ key: "ArrowUp" }), state(false)),
    ).toEqual({ action: "default" });
    expect(
      composerKeyDecision(key({ key: "ArrowDown" }), state(false)),
    ).toEqual({ action: "default" });
  });

  it("leaves typing and chords to the editor", () => {
    expect(composerKeyDecision(key({ key: "a" }), state(false))).toEqual({
      action: "default",
    });
    expect(
      composerKeyDecision(key({ key: "a", metaKey: true }), state(false)),
    ).toEqual({ action: "default" });
    expect(
      composerKeyDecision(key({ key: "c", ctrlKey: true, altKey: true }), state(true)),
    ).toEqual({ action: "default" });
  });
});

type CsiHandler = (params: (number | number[])[]) => boolean;

function makeFakeTerm() {
  const handlers: { id: { prefix?: string; final: string }; run: CsiHandler }[] =
    [];
  const term = {
    parser: {
      registerCsiHandler(
        id: { prefix?: string; final: string },
        run: CsiHandler,
      ) {
        handlers.push({ id, run });
        return { dispose: () => handlers.splice(0) };
      },
    },
  } as unknown as Terminal;
  return { term, handlers };
}

function fire(handlers: { id: { prefix?: string; final: string }; run: CsiHandler }[], prefix: string, final: string, params: number[]) {
  for (const h of handlers) {
    if (h.id.prefix === prefix && h.id.final === final) h.run(params);
  }
}

describe("observeTerminalModes", () => {
  it("tracks the alternate screen and bracketed paste from DECSET/DECRST", () => {
    const { term, handlers } = makeFakeTerm();
    const seen: { altScreen: boolean; bracketedPaste: boolean }[] = [];
    const dispose = observeTerminalModes(term, (m) => seen.push(m));

    fire(handlers, "?", "h", [1049]); // vim enters the alt screen
    expect(seen[seen.length - 1]).toEqual({ altScreen: true, bracketedPaste: false });
    fire(handlers, "?", "h", [2004]); // shell enables bracketed paste
    expect(seen[seen.length - 1]).toEqual({ altScreen: true, bracketedPaste: true });
    fire(handlers, "?", "l", [1049]); // vim exits
    expect(seen[seen.length - 1]).toEqual({ altScreen: false, bracketedPaste: true });
    fire(handlers, "?", "l", [2004]);
    expect(seen[seen.length - 1]).toEqual({ altScreen: false, bracketedPaste: false });
    expect(seen).toHaveLength(4);

    dispose();
  });
});

/**
 * Mounts a real CodeMirror 6 editor wired exactly like the component does,
 * then drives DOM key events through it.
 */
function mountComposer() {
  const submit = vi.fn();
  const write = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view: EditorView = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: buildComposerExtensions({
        isEmpty: () => view.state.doc.length === 0,
        hasSelection: () => !view.state.selection.main.empty,
        // Same contract as the component: submit clears the line.
        submit: () => {
          submit();
          view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
        },
        write: (data) => write(data),
      }),
    }),
    parent: host,
  });
  return { view, submit, write };
}

function pressKey(view: EditorView, init: KeyboardEventInit) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

describe("composer editor integration", () => {
  it("Enter submits and clears the line; nothing reaches the PTY directly", () => {
    const { view, submit, write } = mountComposer();
    view.dispatch({ changes: { from: 0, insert: "ls -la" } });

    pressKey(view, { key: "Enter" });

    // The extension layer signals submit; the component turns that into the
    // bracketed-paste payload (covered by the composerSubmitPayload tests).
    expect(submit).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
  });

  it("Ctrl+C, Tab and empty-state Up go to the PTY as raw bytes", () => {
    const { view, submit, write } = mountComposer();

    pressKey(view, { key: "c", ctrlKey: true });
    pressKey(view, { key: "d", ctrlKey: true });
    pressKey(view, { key: "l", ctrlKey: true });
    pressKey(view, { key: "Tab" });
    pressKey(view, { key: "ArrowUp" });

    expect(write).toHaveBeenCalledWith("\x03");
    expect(write).toHaveBeenCalledWith("\x04");
    expect(write).toHaveBeenCalledWith("\x0c");
    expect(write).toHaveBeenCalledWith("\t");
    expect(write).toHaveBeenCalledWith("\x1b[A");
    expect(submit).not.toHaveBeenCalled();
  });

  it("Up with content stays in the editor; Tab always reaches the PTY", () => {
    const { view, write } = mountComposer();
    view.dispatch({
      changes: { from: 0, insert: "git st" },
      selection: { anchor: "git st".length },
    });
    const before = view.state.selection.main.from;
    expect(before).toBe("git st".length);

    pressKey(view, { key: "ArrowUp" });
    pressKey(view, { key: "Tab" });

    // The only PTY bytes are the forwarded tab (completion stays in the
    // shell); Up moved the cursor inside the editor instead of reaching it.
    expect(write).toHaveBeenCalledWith("\t");
    expect(view.state.selection.main.from).toBeLessThan(before);
    expect(view.state.doc.toString()).toBe("git st");
  });

  it("keeps the editor single-line: pasted newlines become spaces", () => {
    const { view } = mountComposer();
    view.dispatch({ changes: { from: 0, insert: "echo one\ntwo" } });
    expect(view.state.doc.toString()).toBe("echo one two");
  });
});
