// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "@/modules/terminal/TerminalPane";
import type { StorageError } from "@/modules/terminal/lib/journal";

const test = vi.hoisted(() => ({
  callbacks: {} as { onJournalError: (error: StorageError | null) => void },
  retry: vi.fn(),
  session: {
    write: vi.fn(),
    focus: vi.fn(),
    getBuffer: vi.fn(),
    getSelection: vi.fn(),
    applyTheme: vi.fn(),
  },
}));
vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({
  useTerminalSession: (options: typeof test.callbacks) => {
    test.callbacks = options;
    return test.session;
  },
  retryTerminalStorage: test.retry,
  writeToSession: vi.fn(),
}));
vi.mock("@/modules/terminal/components/BlockChrome", () => ({
  BlockChrome: () => null,
}));
vi.mock("@/modules/terminal/components/TerminalHistory", () => ({
  TerminalHistory: ({ project }: { project: string }) => <span>{project}</span>,
}));
vi.mock("@/modules/terminal/components/TerminalComposer", () => ({
  TerminalComposer: () => null,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: () => false,
}));
vi.mock("@/modules/settings/store", () => ({ setTerminalComposer: vi.fn() }));
vi.mock("@/modules/theme", () => ({
  useTheme: () => ({
    resolvedMode: "dark",
    themeId: "default",
    customThemes: null,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  test.retry.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("terminal storage error banner", () => {
  it("shows the failed path, message and unsaved state until a committed save event arrives", async () => {
    const { container } = render(
      <TerminalPane leafId={4} visible initialCwd="/project" />,
    );
    act(() =>
      test.callbacks.onJournalError({
        path: "/project/.pi/terminal/t/stream.ansi",
        message: "Disk full",
      }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Disk full. Unsaved.",
    );
    expect(
      container.querySelector('[data-uat="storage-error"]')?.textContent,
    ).toContain("/project/.pi/terminal/t/stream.ansi");
    const retry = screen.getByRole("button", { name: "Retry save" });
    expect(retry.getAttribute("data-uat")).toBe("storage-retry");
    fireEvent.click(retry);
    await waitFor(() => expect(test.retry).toHaveBeenCalledWith(4));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => test.callbacks.onJournalError(null));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves a failed retry visibly unsaved", async () => {
    test.retry.mockRejectedValue(new Error("Still unavailable"));
    render(<TerminalPane leafId={4} visible initialCwd="/project" />);
    act(() =>
      test.callbacks.onJournalError({
        path: "/project/.pi/terminal/t/blocks.jsonl",
        message: "Denied",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Still unavailable. Unsaved.",
      ),
    );
  });

  it("keeps the project history root when the shell changes cwd", () => {
    const view = render(
      <TerminalPane leafId={4} visible initialCwd="/project" />,
    );
    view.rerender(
      <TerminalPane leafId={4} visible initialCwd="/project/other" />,
    );
    expect(screen.getByText("/project")).toBeTruthy();
    expect(screen.queryByText("/project/other")).toBeNull();
  });
});
