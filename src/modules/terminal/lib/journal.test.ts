import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  finishedBlocks,
  parseTerminalHistory,
  plainOutput,
  readBlockOutput,
  terminalHistory,
  terminalList,
  type JournalRecord,
} from "@/modules/terminal/lib/journal";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

const start: JournalRecord = {
  v: 1,
  seq: 1,
  terminalId: "terminal-one",
  blockId: "block-one",
  event: "start",
  command: "echo hello",
  commandTruncated: false,
  cwd: "/project",
  startedAt: "2026-09-08T10:00:00.000Z",
  endedAt: null,
  durationMs: null,
  exit: "running",
  outputPath: ".pi/terminal/terminal-one/output/block-one.ansi",
  outputBytes: 0,
};
const finish: JournalRecord = {
  ...start,
  seq: 2,
  event: "finish",
  endedAt: "2026-09-08T10:00:00.100Z",
  durationMs: 100,
  exit: 0,
  outputBytes: 5,
};
beforeEach(() => vi.clearAllMocks());

describe("terminal journal parsing", () => {
  it("parses JSONL and keeps only authoritative final records for rendering", () => {
    const records = parseTerminalHistory(
      [start, finish].map((r) => JSON.stringify(r)).join("\n") + "\n",
      start.terminalId,
    );
    expect(records).toEqual([start, finish]);
    expect(finishedBlocks(records)).toEqual([finish]);
  });

  it("keeps interrupted exit unknown and unavailable duration null", () => {
    const interrupted = {
      ...finish,
      event: "interrupted",
      exit: "unknown",
      durationMs: null,
    };
    expect(
      finishedBlocks(
        parseTerminalHistory([start, interrupted], start.terminalId),
      )[0],
    ).toMatchObject(interrupted);
    expect(() =>
      parseTerminalHistory(
        [start, { ...interrupted, exit: 0 }],
        start.terminalId,
      ),
    ).toThrow();
    expect(() =>
      parseTerminalHistory(
        [start, { ...interrupted, durationMs: 0 }],
        start.terminalId,
      ),
    ).toThrow();
  });

  it.each([
    { v: 2 },
    { seq: 3 },
    { terminalId: "other" },
    { blockId: "../escape" },
    { outputPath: "../../.env" },
    { outputBytes: -1 },
    { exit: "success" },
    { startedAt: "2026-09-08T10:00:00" },
    { command: "a\nb" },
    { command: "x".repeat(257) },
  ])("rejects invalid metadata %j", (patch) => {
    expect(() =>
      parseTerminalHistory([{ ...start, ...patch }], start.terminalId),
    ).toThrow();
  });

  it("counts Unicode characters and preserves the truncation flag", () => {
    const command = "界".repeat(256);
    expect(
      parseTerminalHistory(
        [{ ...start, command, commandTruncated: true }],
        start.terminalId,
      )[0].command,
    ).toBe(command);
  });

  it("rejects a finish without a start and output after a finish", () => {
    expect(() =>
      parseTerminalHistory([{ ...finish, seq: 1 }], start.terminalId),
    ).toThrow();
    expect(() =>
      parseTerminalHistory(
        [start, finish, { ...start, event: "output", seq: 3 }],
        start.terminalId,
      ),
    ).toThrow();
  });

  it("never applies the 200 block render limit to persisted history", () => {
    const all = Array.from({ length: 201 }, (_, i) => [
      {
        ...start,
        seq: i * 2 + 1,
        blockId: `b-${i}`,
        outputPath: `.pi/terminal/terminal-one/output/b-${i}.ansi`,
      },
      {
        ...finish,
        seq: i * 2 + 2,
        blockId: `b-${i}`,
        outputPath: `.pi/terminal/terminal-one/output/b-${i}.ansi`,
      },
    ]).flat();
    expect(
      finishedBlocks(parseTerminalHistory(all, start.terminalId)),
    ).toHaveLength(201);
  });
});

describe("file backed terminal commands", () => {
  it("reads both history commands with explicit project and opaque terminal identity", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([start, finish])
      .mockResolvedValueOnce([
        {
          terminalId: start.terminalId,
          cwd: "/project/last",
          time: start.startedAt,
          streamBytes: 5,
        },
      ]);
    expect(await terminalHistory("/project", start.terminalId)).toEqual([
      start,
      finish,
    ]);
    expect(await terminalList("/project")).toHaveLength(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "pty_terminal_history", {
      project: "/project",
      terminalId: start.terminalId,
      workspace: { kind: "local" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "pty_terminal_list", {
      project: "/project",
      workspace: { kind: "local" },
    });
  });

  it("reads exact file byte ranges and decodes split UTF-8 across chunks", async () => {
    const text = "x".repeat(1024 * 1024 - 1) + "界";
    const bytes = new TextEncoder().encode(text);
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { offset, length } = args as { offset: number; length: number };
      return bytes.slice(offset, offset + length).buffer;
    });
    expect(
      await readBlockOutput({
        project: "/project",
        record: { ...finish, outputBytes: bytes.length },
      }),
    ).toBe(text);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(
      "pty_terminal_output",
      expect.objectContaining({
        blockId: "block-one",
        offset: 1024 * 1024,
        length: 2,
      }),
    );
  });

  it("reports a path bearing error for missing or short block output", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(1));
    await expect(
      readBlockOutput({ project: "/project", record: finish }),
    ).rejects.toMatchObject({
      path: `/project/${finish.outputPath}`,
      message: "Incomplete block file range",
    });
    vi.mocked(invoke).mockRejectedValue({
      path: "/project/.pi/terminal",
      message: "Permission denied",
    });
    await expect(terminalList("/project")).rejects.toEqual({
      path: "/project/.pi/terminal",
      message: "Permission denied",
    });
  });

  it("reports corrupt history rather than displaying stale successes", async () => {
    vi.mocked(invoke).mockResolvedValue([{ ...finish, seq: 1 }]);
    await expect(
      terminalHistory("/project", start.terminalId),
    ).rejects.toMatchObject({
      path: "/project/.pi/terminal/terminal-one/blocks.jsonl",
    });
  });

  it("strips ANSI only for plain text actions", () => {
    expect(plainOutput("\x1b[31mhello\x1b[0m\r\n\x1b]0;title\x07")).toBe(
      "hello\n",
    );
  });
});
