import { describe, expect, it } from "vitest";

import {
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalWordNavigationSequence,
  type TerminalKeyEvent,
} from "./keymap";

const evt = (partial: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  key: "",
  code: "",
  ...partial,
});

describe("composer off key path", () => {
  it("tab reaches the pty when the composer is off", () => {
    // Route A: the shell's own line editor owns Tab (zsh expand-or-complete).
    // The custom key handler claims a Tab keydown for none of its sequences
    // on any platform, so the handler returns true and xterm's onData path
    // forwards the raw byte to writeToPty exactly once.
    const tab = evt({ key: "Tab", code: "Tab" });
    for (const isMac of [true, false]) {
      expect(terminalLineNavigationSequence(tab, { isMac })).toBeNull();
      expect(terminalDeleteSequence(tab, { isMac })).toBeNull();
    }
    expect(terminalWordNavigationSequence(tab)).toBeNull();

    // The byte that reaches the PTY is the literal Tab, 0x09, unchanged.
    expect("\t".charCodeAt(0)).toBe(0x09);
  });
});
