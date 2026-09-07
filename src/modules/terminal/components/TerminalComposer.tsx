import { detectMonoFontFamily } from "@/lib/fonts";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { getSlotForLeaf } from "../lib/rendererPool";

/**
 * Composer v0 (philosophy 9): a single-line editor pinned under the emulator
 * that submits through the user's shell by writing to the PTY. Enter wraps the
 * text in bracketed paste and appends a carriage return; Ctrl+C / Ctrl+D /
 * Ctrl+L, Tab, and (when empty) Up / Down go to the PTY as raw bytes so shell
 * control and completion still work in the emulator. The composer hides while
 * the session is in the alternate screen (vim, htop, less) and comes back on
 * return. Multi-line editing and history-as-document are later slices.
 */

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * The bytes Enter sends: the line wrapped in bracketed paste when the shell
 * enabled mode 2004, followed by the carriage return that runs it. Newlines
 * collapse to spaces first; slice 1 is a single-line editor.
 */
export function composerSubmitPayload(
  text: string,
  bracketedPaste: boolean,
): string {
  const line = text.replace(/\r\n?|\n/g, (m) => " ".repeat(m.length));
  return bracketedPaste
    ? `${BRACKETED_PASTE_START}${line}${BRACKETED_PASTE_END}\r`
    : `${line}\r`;
}

export type ComposerKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type ComposerKeyState = {
  isEmpty: boolean;
  hasSelection: boolean;
};

export type ComposerKeyDecision =
  | { action: "submit" }
  | { action: "pty"; data: string }
  | { action: "noop" }
  | { action: "default" };

/**
 * Key arbitration between the editor and the shell.
 *
 * - Enter submits; Shift+Enter is a no-op (single line in slice 1).
 * - Ctrl+C forwards ^C, except with a selection where the browser copy wins
 *   (the terminal-standard arbitration). Ctrl+D and Ctrl+L always forward.
 * - Tab forwards a raw tab so shell completion still works in the emulator.
 * - Up / Down forward arrow sequences while empty (shell history) and move
 *   the text cursor otherwise.
 */
export function composerKeyDecision(
  key: ComposerKeyEvent,
  state: ComposerKeyState,
): ComposerKeyDecision {
  const noChords = !key.metaKey && !key.altKey;
  if (key.ctrlKey && noChords && !key.shiftKey) {
    if (key.key === "c") {
      return state.hasSelection
        ? { action: "default" }
        : { action: "pty", data: "\x03" };
    }
    if (key.key === "d") return { action: "pty", data: "\x04" };
    if (key.key === "l") return { action: "pty", data: "\x0c" };
  }
  if (
    key.key === "Enter" &&
    !key.ctrlKey &&
    !key.metaKey &&
    !key.altKey &&
    !key.shiftKey
  ) {
    return { action: "submit" };
  }
  if (
    key.key === "Enter" &&
    !key.ctrlKey &&
    !key.metaKey &&
    !key.altKey &&
    key.shiftKey
  ) {
    return { action: "noop" };
  }
  if (key.key === "Tab" && noChords && !key.shiftKey) {
    return { action: "pty", data: "\t" };
  }
  if (
    (key.key === "ArrowUp" || key.key === "ArrowDown") &&
    noChords &&
    !key.shiftKey &&
    state.isEmpty
  ) {
    return { action: "pty", data: key.key === "ArrowUp" ? "\x1b[A" : "\x1b[B" };
  }
  return { action: "default" };
}

/** Replaces newlines with same-length whitespace so positions stay valid. */
function inlineNewlines(s: string): string {
  return s.replace(/\r\n?|\n/g, (m) => " ".repeat(m.length));
}

/** Keeps the editor single-line: inserted newlines become spaces in place. */
const singleLineOnly = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let touched = false;
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    const clean = /[\r\n]/.test(text) ? inlineNewlines(text) : text;
    touched = touched || clean !== text;
    changes.push({ from: fromA, to: toA, insert: clean });
  });
  if (!touched) return tr;
  return {
    changes,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  };
});

/**
 * Extensions for the composer editor. The first keymap inspects every keydown
 * through composerKeyDecision and forwards shell-bound keys to the PTY; the
 * stock keymaps only see what it declines. Wrapping matters: defaultKeymap and
 * historyKeymap are plain binding arrays (keymap.of wraps them) and history is
 * a factory; a bare value in the extensions list fails EditorState.create with
 * a misleading dual-instance message.
 */
export function buildComposerExtensions(opts: {
  isEmpty: () => boolean;
  hasSelection: () => boolean;
  submit: () => void;
  write: (data: string) => void;
}): Extension[] {
  return [
    singleLineOnly,
    keymap.of([
      {
        any: (_view, event) => {
          if (event.type !== "keydown") return false;
          const decision = composerKeyDecision(event, {
            isEmpty: opts.isEmpty(),
            hasSelection: opts.hasSelection(),
          });
          if (decision.action === "default") return false;
          if (decision.action === "submit") {
            opts.submit();
            return true;
          }
          if (decision.action === "pty") opts.write(decision.data);
          return true;
        },
      },
    ]),
    keymap.of(defaultKeymap),
    history(),
    keymap.of(historyKeymap),
    placeholder("Run a command"),
    EditorView.contentAttributes.of({
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      "aria-label": "terminal composer",
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        fontSize: "13px",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content": {
        padding: "6px 10px",
        fontFamily: detectMonoFontFamily(),
        caretColor: "var(--foreground)",
        color: "var(--foreground)",
      },
      ".cm-line": { padding: "0" },
      ".cm-placeholder": { color: "var(--muted-foreground)" },
      ".cm-selectionBackground": {
        backgroundColor: "var(--accent) !important",
      },
    }),
  ];
}

export type TerminalModeState = {
  altScreen: boolean;
  bracketedPaste: boolean;
};

/** DECSET params that switch to (and back from) the alternate screen. */
const ALT_SCREEN_PARAMS = new Set([47, 1047, 1049]);
const BRACKETED_PASTE_PARAM = 2004;

/**
 * Tracks the terminal modes the composer cares about by watching DECSET /
 * DECRST (CSI ? Ps h / l). Handlers return false so xterm still applies the
 * mode change itself.
 */
export function observeTerminalModes(
  term: Terminal,
  onChange: (modes: TerminalModeState) => void,
): () => void {
  const alt = new Set<number>();
  let bracketed = false;
  const emit = () => onChange({ altScreen: alt.size > 0, bracketedPaste: bracketed });
  const apply = (params: (number | number[])[], set: boolean) => {
    for (const p of params) {
      if (typeof p !== "number") continue;
      if (ALT_SCREEN_PARAMS.has(p)) {
        if (set) alt.add(p);
        else alt.delete(p);
      }
      if (p === BRACKETED_PASTE_PARAM) bracketed = set;
    }
    emit();
    return false;
  };
  const disposables = [
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) =>
      apply(params, true),
    ),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) =>
      apply(params, false),
    ),
  ];
  return () => {
    for (const d of disposables) d.dispose();
  };
}

type Props = {
  leafId: number;
  /** True while a pooled emulator slot is bound to this leaf. */
  bound: boolean;
  /** Writes bytes to the session's PTY; false means the write was dropped. */
  onWrite: (data: string) => boolean;
  /** Puts keyboard focus back on the emulator. */
  onFocusEmulator: () => void;
};

export function TerminalComposer({
  leafId,
  bound,
  onWrite,
  onFocusEmulator,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [modes, setModes] = useState<TerminalModeState>({
    altScreen: false,
    bracketedPaste: false,
  });
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const onWriteRef = useRef(onWrite);
  onWriteRef.current = onWrite;

  const submit = () => {
    const view = viewRef.current;
    if (!view) return;
    const payload = composerSubmitPayload(
      view.state.doc.toString(),
      modesRef.current.bracketedPaste,
    );
    // Keep the text when the session cannot accept writes (shell exited).
    if (onWriteRef.current(payload)) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // One EditorView for the pane lifetime; hidden, not unmounted, while the
  // alternate screen owns the emulator so the draft survives vim or htop.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: buildComposerExtensions({
          isEmpty: () => viewRef.current?.state.doc.length === 0,
          hasSelection: () =>
            viewRef.current
              ? !viewRef.current.state.selection.main.empty
              : false,
          submit: () => submitRef.current(),
          write: (data) => onWriteRef.current(data),
        }),
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Mode observers must ride the pooled slot's terminal: they are attached
  // while a slot is bound to this leaf and disposed on unbind.
  useEffect(() => {
    if (!bound) return;
    const slot = getSlotForLeaf(leafId);
    if (!slot) return;
    // Resync from the live buffer in case a mode was set before this attach.
    try {
      if (slot.term.buffer.active.type === "alternate") {
        setModes({ altScreen: true, bracketedPaste: false });
      }
    } catch {
      /* no buffer yet */
    }
    return observeTerminalModes(slot.term, (next) => {
      setModes(next);
      if (next.altScreen && hostRef.current?.contains(document.activeElement)) {
        // The alt screen took over while focus was in the composer; hand
        // focus to the emulator so vim and friends keep receiving keys.
        onFocusEmulator();
      }
    });
  }, [bound, leafId, onFocusEmulator]);

  const hidden = modes.altScreen;
  return (
    <div
      ref={hostRef}
      data-terax-composer=""
      aria-hidden={hidden}
      aria-label="terminal composer"
      className={`shrink-0 border-t border-border/60 bg-background/95 ${
        hidden ? "hidden" : ""
      }`}
    />
  );
}
