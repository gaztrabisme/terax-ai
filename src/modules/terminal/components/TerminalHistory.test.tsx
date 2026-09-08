// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  RecoveredBlock,
  TerminalHistory,
} from "@/modules/terminal/components/TerminalHistory";
import {
  readBlockOutput,
  terminalList,
  terminalHistory,
  exportBlock,
  readTerminalStream,
  type JournalRecord,
} from "@/modules/terminal/lib/journal";
import {
  respawnSession,
  terminalHistoryCanReplace,
  writeToSession,
} from "@/modules/terminal/lib/useTerminalSession";

vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({
  respawnSession: vi.fn(),
  terminalHistoryCanReplace: vi.fn(),
  writeToSession: vi.fn(),
}));
vi.mock("@/modules/theme", () => ({
  useTheme: () => ({
    themeId: "default",
    resolvedMode: "dark",
    customThemes: null,
  }),
}));
vi.mock("@/styles/terminalTheme", () => ({
  buildTerminalTheme: () => ({ foreground: "#ffffff", background: "#000000" }),
}));
vi.mock("@/modules/terminal/lib/rendererPool", () => ({
  getSlotForLeaf: vi.fn(),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (s: unknown) => unknown) =>
    select({
      terminalFontFamily: "monospace",
      terminalFontSize: 14,
      zoomLevel: 1,
    }),
}));
vi.mock("@/modules/terminal/lib/journal", async (original) => ({
  ...(await original<typeof import("@/modules/terminal/lib/journal")>()),
  readBlockOutput: vi.fn(),
  terminalList: vi.fn(),
  terminalHistory: vi.fn(),
  readTerminalStream: vi.fn(),
  exportBlock: vi.fn(),
}));

const record: JournalRecord = {
  v: 1,
  seq: 3,
  terminalId: "old-terminal",
  blockId: "saved-block",
  event: "finish",
  command: "echo recovered",
  commandTruncated: true,
  cwd: "/project",
  startedAt: "2026-09-08T10:00:00.000Z",
  endedAt: "2026-09-08T10:00:01.250Z",
  durationMs: 1250,
  exit: 0,
  outputPath: ".pi/terminal/old-terminal/output/saved-block.ansi",
  outputBytes: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readBlockOutput).mockResolvedValue("recovered\r\n");
  vi.mocked(terminalList).mockResolvedValue([
    {
      terminalId: record.terminalId,
      cwd: "/project/last",
      time: record.endedAt!,
      streamBytes: 12,
    },
  ]);
  vi.mocked(terminalHistory).mockResolvedValue([record]);
  vi.mocked(terminalHistoryCanReplace).mockResolvedValue(true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(cleanup);

describe("recovered block chrome", () => {
  it("uses live block styles, labels, recorded command, output, exit and duration", async () => {
    const { container } = render(
      <RecoveredBlock
        record={record}
        project="/project"
        leafId={4}
        onError={vi.fn()}
      />,
    );
    expect(await screen.findByText("recovered")).toBeTruthy();
    expect(screen.getByText("echo recovered")).toBeTruthy();
    expect(container.querySelector(".terax-block-duration")?.textContent).toBe(
      "Truncated command / 1.3s",
    );
    expect(
      container
        .querySelector('[data-uat="exit-dot-ok"]')
        ?.getAttribute("aria-label"),
    ).toBe("exit 0");
    expect(
      screen.getByRole("button", { name: "Rerun", hidden: true }).className,
    ).toBe("terax-block-btn");
    expect(
      container
        .querySelector('[data-uat="terminal-block"]')
        ?.getAttribute("data-uat-key"),
    ).toBe("saved-block");
    expect(
      container
        .querySelector(".terax-block-recovered")
        ?.getAttribute("tabindex"),
    ).toBe("0");
  });

  it("makes interrupted status visible and refuses rerun without inventing exit zero", async () => {
    const interrupted: JournalRecord = {
      ...record,
      event: "interrupted",
      exit: "unknown",
      durationMs: null,
    };
    const { container } = render(
      <RecoveredBlock
        record={interrupted}
        project="/project"
        leafId={4}
        onError={vi.fn()}
      />,
    );
    await screen.findByText("recovered");
    const button = screen.getByRole("button", {
      name: "Rerun",
      hidden: true,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(writeToSession).not.toHaveBeenCalled();
    expect(
      container.querySelector(".terax-block-duration")?.textContent,
    ).toContain("interrupted / exit unknown");
    expect(
      container.querySelector('[data-uat="exit-dot-unknown"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-uat="exit-dot-ok"]')).toBeNull();
  });

  it("reruns captured text into the fresh shell only after activation", async () => {
    render(
      <RecoveredBlock
        record={record}
        project="/project"
        leafId={4}
        onError={vi.fn()}
      />,
    );
    await screen.findByText("recovered");
    expect(writeToSession).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Rerun", hidden: true }),
    );
    expect(writeToSession).toHaveBeenCalledWith(4, "echo recovered\r");
  });

  it("Copy rereads the block file and editor export receives the same range", async () => {
    render(
      <RecoveredBlock
        record={record}
        project="/project"
        leafId={4}
        onError={vi.fn()}
      />,
    );
    await screen.findByText("recovered");
    vi.mocked(readBlockOutput).mockResolvedValue("disk content\r\n");
    fireEvent.click(screen.getByRole("button", { name: "Copy", hidden: true }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "disk content\n",
      ),
    );
    expect(readBlockOutput).toHaveBeenLastCalledWith({
      project: "/project",
      record,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open in editor", hidden: true }),
    );
    await waitFor(() =>
      expect(exportBlock).toHaveBeenCalledWith({ project: "/project", record }),
    );
  });

  it("missing output reports its path with an actionable Retry", async () => {
    vi.mocked(readBlockOutput).mockRejectedValueOnce({
      path: `/project/${record.outputPath}`,
      message: "missing file",
    });
    const onError = vi.fn();
    render(
      <RecoveredBlock
        record={record}
        project="/project"
        leafId={4}
        onError={onError}
      />,
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0].path).toBe(`/project/${record.outputPath}`);
    await onError.mock.calls[0][1]();
    await screen.findByText("recovered");
  });
});

describe("terminal history tab control", () => {
  it("lists opaque terminal ids and opens finished blocks above a fresh shell", async () => {
    render(
      <TerminalHistory
        project="/project"
        terminalId="new-terminal"
        leafId={4}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "List terminal history" }),
    );
    const reopen = await screen.findByRole("button", {
      name: "Reopen terminal history",
    });
    expect(reopen.getAttribute("data-uat")).toBe("terminal-history-reopen");
    expect(reopen.getAttribute("data-uat-key")).toBe("old-terminal");
    fireEvent.click(reopen);
    expect(
      await screen.findByRole("region", { name: "Recovered terminal history" }),
    ).toBeTruthy();
    expect(respawnSession).toHaveBeenCalledWith(4, "/project/last");
    expect(terminalHistory).toHaveBeenCalledWith("/project", "old-terminal");
    expect(writeToSession).not.toHaveBeenCalled();
  });

  it("replays the raw stream when shell integration did not create any blocks", async () => {
    vi.mocked(terminalHistory).mockResolvedValue([]);
    vi.mocked(readTerminalStream).mockResolvedValue(
      "old prompt and raw output",
    );
    render(<TerminalHistory project="/project" leafId={4} onError={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "List terminal history" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reopen terminal history" }),
    );
    expect(await screen.findByText("old prompt and raw output")).toBeTruthy();
    expect(respawnSession).toHaveBeenCalledWith(4, "/project/last");
  });

  it("does not replace a live process when the close confirmation is declined", async () => {
    vi.mocked(terminalHistoryCanReplace).mockResolvedValue(false);
    render(<TerminalHistory project="/project" leafId={4} onError={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "List terminal history" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reopen terminal history" }),
    );
    await waitFor(() => expect(terminalHistoryCanReplace).toHaveBeenCalled());
    expect(respawnSession).not.toHaveBeenCalled();
    expect(terminalHistory).not.toHaveBeenCalled();
  });

  it("keeps all blocks accessible while mounting only one 200 block page", async () => {
    vi.mocked(terminalHistory).mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({
        ...record,
        seq: i + 1,
        blockId: `saved-${i}`,
      })),
    );
    render(<TerminalHistory project="/project" leafId={4} onError={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "List terminal history" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reopen terminal history" }),
    );
    const region = await screen.findByRole("region", {
      name: "Recovered terminal history",
    });
    expect(
      within(region).getAllByRole("button", { name: "Rerun", hidden: true }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Older terminal blocks" }),
    );
    await waitFor(() =>
      expect(
        within(region).getAllByRole("button", { name: "Rerun", hidden: true }),
      ).toHaveLength(200),
    );
  });
});
