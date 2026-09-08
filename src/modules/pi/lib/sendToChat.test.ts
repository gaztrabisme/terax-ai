import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import { chooseChatTab } from "./sendToChat";

function piTab(id: number, cwd?: string): Tab {
  return { id, kind: "pi", title: "pi", cwd };
}

function termTab(id: number, cwd?: string): Tab {
  return {
    id,
    kind: "terminal",
    title: "zsh",
    cwd,
    paneTree: { kind: "leaf", id: 100 + id, cwd },
    activeLeafId: 100 + id,
  };
}

describe("chooseChatTab", () => {
  it("returns the active tab when it is a pi tab, whatever the cwd", () => {
    const tabs = [termTab(1, "/w"), piTab(2, "/other"), piTab(3, "/w")];
    expect(chooseChatTab(tabs, 3, "/w")).toBe(3);
    expect(chooseChatTab(tabs, 2, "/w")).toBe(2);
  });

  it("prefers a pi tab whose cwd matches the terminal's", () => {
    const tabs = [termTab(1, "/w"), piTab(2, "/other"), piTab(3, "/w")];
    expect(chooseChatTab(tabs, 1, "/w")).toBe(3);
  });

  it("takes the first same-cwd match when several exist", () => {
    const tabs = [termTab(1, "/w"), piTab(2, "/w"), piTab(3, "/w")];
    expect(chooseChatTab(tabs, 1, "/w")).toBe(2);
  });

  it("falls back to the first pi tab when no cwd matches", () => {
    const tabs = [termTab(1, "/w"), piTab(2, "/other"), piTab(3, "/elsewhere")];
    expect(chooseChatTab(tabs, 1, "/w")).toBe(2);
  });

  it("falls back to the first pi tab when the cwd is unknown", () => {
    const tabs = [piTab(4), piTab(5, "/w")];
    expect(chooseChatTab(tabs, 9, null)).toBe(4);
    expect(chooseChatTab(tabs, 9, undefined)).toBe(4);
  });

  it("skips non-pi tabs in every fallback", () => {
    const tabs = [termTab(1, "/w"), termTab(2, "/other")];
    expect(chooseChatTab(tabs, 1, "/w")).toBeNull();
  });

  it("returns null when there are no tabs at all", () => {
    expect(chooseChatTab([], 1, "/w")).toBeNull();
  });
});
