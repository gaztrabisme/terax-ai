// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOD_PROP } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SHORTCUTS, SHORTCUT_GROUPS, type ShortcutId } from "./shortcuts";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";

const defaultShortcuts = usePreferencesStore.getState().shortcuts;
afterEach(cleanup);

describe("Pi shortcut table", () => {
  it.each([
    ["pi.toggleBoard", "Board", "b", true],
    ["pi.toggleGraph", "Graph", "g", true],
    ["pi.sessions", "Sessions", "j", false],
    ["pi.toggleArtifact", "Artifact", "a", true],
  ] as const)("registers %s without a default collision", (id, label, key, shift) => {
    const shortcut = SHORTCUTS.find((s) => s.id === id)!;
    expect(shortcut.group).toBe("Pi");
    expect(shortcut.label).toBe(label);
    expect(shortcut.defaultBindings).toEqual([
      { [MOD_PROP]: true, key, ...(shift ? { shift: true } : {}) },
    ]);
    expect(SHORTCUT_GROUPS).toContain("Pi");
    const signature = (binding: (typeof shortcut.defaultBindings)[number]) =>
      [
        binding.key.toLowerCase(),
        !!binding.ctrl,
        !!binding.meta,
        !!binding.shift,
        !!binding.alt,
      ].join(":");
    expect(
      SHORTCUTS.filter((s) =>
        s.defaultBindings.some(
          (binding) =>
            signature(binding) === signature(shortcut.defaultBindings[0]),
        ),
      ).map((s) => s.id),
    ).toEqual([id]);
  });

  it("honors rebinding, disabled scopes, and a focused editor's own binding", () => {
    usePreferencesStore.setState({
      shortcuts: {
        ...defaultShortcuts,
        "pi.toggleBoard": [{ alt: true, key: "b" }],
      },
    });
    const handler = vi.fn();
    function Harness({ enabled = true }: { enabled?: boolean }) {
      useGlobalShortcuts({ "pi.toggleBoard": handler }, { enabled });
      return (
        <div
          contentEditable
          suppressContentEditableWarning
          onKeyDown={(e) => e.preventDefault()}
          data-testid="editor"
        />
      );
    }
    const { getByTestId, rerender } = render(<Harness />);
    fireEvent.keyDown(window, { key: "b", altKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByTestId("editor"), { key: "b", altKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled={false} />);
    fireEvent.keyDown(window, { key: "b", altKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    usePreferencesStore.setState({ shortcuts: defaultShortcuts });
  });

  it("lets composer bold consume Mod+B before sidebar navigation", () => {
    usePreferencesStore.setState({ shortcuts: defaultShortcuts });
    const sidebar = vi.fn();
    const editor = vi.fn();
    function Harness() {
      useGlobalShortcuts({ ["sidebar.toggle" as ShortcutId]: sidebar });
      return (
        <div
          contentEditable
          suppressContentEditableWarning
          data-testid="editor"
          onKeyDown={(e) => {
            editor();
            e.preventDefault();
          }}
        />
      );
    }
    const { getByTestId } = render(<Harness />);
    fireEvent.keyDown(getByTestId("editor"), {
      key: "b",
      [MOD_PROP === "meta" ? "metaKey" : "ctrlKey"]: true,
    });
    expect(editor).toHaveBeenCalledTimes(1);
    expect(sidebar).not.toHaveBeenCalled();
  });
});
