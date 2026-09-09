import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { currentWorkspaceEnv } from "@/modules/workspace";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.string().datetime({ offset: true }).refine((s) => s.endsWith("Z") || s.endsWith("+00:00"));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const recordSchema = z
  .object({
    v: z.literal(1),
    seq: integer.positive(),
    terminalId: id,
    blockId: id,
    event: z.enum(["start", "output", "finish", "interrupted"]),
    command: z
      .string()
      .refine((s) => [...s].length <= 256 && !/[\p{Cc}]/u.test(s)),
    commandTruncated: z.boolean(),
    cwd: z.string(),
    startedAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
    durationMs: integer.nullable(),
    exit: z.union([
      z.number().int().min(-2147483648).max(2147483647),
      z.enum(["running", "unknown"]),
    ]),
    outputPath: z.string(),
    outputBytes: integer,
  })
  .strict()
  .superRefine((r, ctx) => {
    const closed = r.event === "finish" || r.event === "interrupted";
    if (
      r.outputPath !==
        `.pi/terminal/${r.terminalId}/output/${r.blockId}.ansi` ||
      (closed ? r.exit === "running" : r.exit !== "running") ||
      (!closed && (r.endedAt !== null || r.durationMs !== null)) ||
      (r.event === "interrupted" &&
        (r.exit !== "unknown" || r.durationMs !== null))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid terminal record state or output path",
      });
    }
  });

export type JournalRecord = z.infer<typeof recordSchema>;
export type TerminalInfo = {
  terminalId: string;
  cwd: string;
  time: string;
  streamBytes: number;
};
export type TerminalHistoryEntry = TerminalInfo & { lastCommand: string };
export type StorageError = { path: string; message: string };
export type JournalEvent =
  | { kind: "record"; record: JournalRecord }
  | ({ kind: "storage-error" } & StorageError)
  | { kind: "saved" };
export type BlockFile = { project: string; record: JournalRecord };

export function storageError(error: unknown, path: string): StorageError {
  if (
    typeof error === "object" &&
    error !== null &&
    "path" in error &&
    "message" in error
  ) {
    return { path: String(error.path), message: String(error.message) };
  }
  return {
    path,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function parseJournalRecord(value: unknown): JournalRecord {
  return recordSchema.parse(value);
}

export function parseTerminalHistory(
  value: unknown,
  terminalId: string,
): JournalRecord[] {
  const raw: unknown =
    typeof value === "string"
      ? value
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : value;
  const records = z.array(recordSchema).parse(raw);
  const open = new Set<string>();
  const closed = new Set<string>();
  for (const [i, record] of records.entries()) {
    if (
      record.terminalId !== terminalId ||
      record.seq !== i + 1 ||
      closed.has(record.blockId)
    ) {
      throw new Error("Invalid terminal journal sequence or identity");
    }
    if (record.event === "start") {
      if (open.size || open.has(record.blockId))
        throw new Error("Overlapping terminal blocks");
      open.add(record.blockId);
    } else if (!open.has(record.blockId)) {
      throw new Error("Terminal block has no start record");
    }
    if (record.event === "finish" || record.event === "interrupted") {
      open.delete(record.blockId);
      closed.add(record.blockId);
    }
  }
  return records;
}

export function finishedBlocks(
  records: readonly JournalRecord[],
): JournalRecord[] {
  return records.filter(
    (r) => r.event === "finish" || r.event === "interrupted",
  );
}

export async function terminalHistory(
  project: string,
  terminalId: string,
): Promise<JournalRecord[]> {
  const path = `${project}/.pi/terminal/${terminalId}/blocks.jsonl`;
  try {
    return parseTerminalHistory(
      await invoke("pty_terminal_history", {
        project,
        terminalId,
        workspace: currentWorkspaceEnv(),
      }),
      terminalId,
    );
  } catch (error) {
    throw storageError(error, path);
  }
}

export async function terminalList(project: string): Promise<TerminalInfo[]> {
  try {
    return z
      .array(
        z
          .object({
            terminalId: id,
            cwd: z.string(),
            time: timestamp,
            streamBytes: integer,
          })
          .strict(),
      )
      .parse(
        await invoke("pty_terminal_list", {
          project,
          workspace: currentWorkspaceEnv(),
        }),
      );
  } catch (error) {
    throw storageError(error, `${project}/.pi/terminal`);
  }
}

export async function terminalHistoryEntries(
  project: string,
  activeTerminalId?: string,
): Promise<TerminalHistoryEntry[]> {
  const terminals = await terminalList(project);
  const entries = await Promise.all(terminals.map(async (info) => {
    const records = await terminalHistory(project, info.terminalId);
    return { ...info, lastCommand: records[records.length - 1]?.command ?? "" };
  }));
  // The native list excludes live PTYs, but their committed journal is readable.
  if (activeTerminalId && !terminals.some((info) => info.terminalId === activeTerminalId)) {
    id.parse(activeTerminalId);
    const records = await terminalHistory(project, activeTerminalId);
    const last = records[records.length - 1];
    if (last) {
      const path = `${project}/.pi/terminal/${activeTerminalId}/stream.ansi`;
      try {
        const stat = z.object({ size: integer, mtime: integer }).parse(
          await invoke("fs_stat", { path, workspace: currentWorkspaceEnv() }),
        );
        entries.push({
          terminalId: activeTerminalId,
          cwd: last.cwd,
          time: new Date(stat.mtime).toISOString(),
          streamBytes: stat.size,
          lastCommand: last.command,
        });
      } catch (error) {
        throw storageError(error, path);
      }
    }
  }
  return entries.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export async function readBlockOutput(
  { project, record }: BlockFile,
  maxBytes = record.outputBytes,
): Promise<string> {
  return readOutputRange(
    project,
    record.terminalId,
    record.blockId,
    record.outputPath,
    record.outputBytes,
    maxBytes,
  );
}

export async function readTerminalStream(
  project: string,
  terminal: TerminalInfo,
  maxBytes = terminal.streamBytes,
): Promise<string> {
  return readOutputRange(
    project,
    terminal.terminalId,
    null,
    `.pi/terminal/${terminal.terminalId}/stream.ansi`,
    terminal.streamBytes,
    maxBytes,
  );
}

async function readOutputRange(
  project: string,
  terminalId: string,
  blockId: string | null,
  path: string,
  bytes: number,
  maxBytes: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const end = Math.min(maxBytes, bytes);
  try {
    for (let offset = 0; offset < end; ) {
      const length = Math.min(1024 * 1024, end - offset);
      const result = await invoke<ArrayBuffer>("pty_terminal_output", {
        project,
        terminalId,
        blockId,
        offset,
        length,
        workspace: currentWorkspaceEnv(),
      });
      const data = new Uint8Array(result);
      if (data.byteLength !== length)
        throw new Error("Incomplete block file range");
      chunks.push(decoder.decode(data, { stream: true }));
      offset += length;
    }
    if (end === bytes) chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    throw storageError(error, `${project}/${path}`);
  }
}

export function plainOutput(ansi: string): string {
  return ansi
    .replace(
      /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][AB012]|\x1b[78=>c]/g,
      "",
    )
    .replace(/\r\n/g, "\n");
}

export async function exportBlock(file: BlockFile): Promise<void> {
  const path = `${file.project}/.pi/terminal/${file.record.terminalId}/output/${file.record.blockId}.txt`;
  try {
    const relative = await invoke<string>("pty_terminal_export", {
      project: file.project,
      terminalId: file.record.terminalId,
      blockId: file.record.blockId,
      workspace: currentWorkspaceEnv(),
    });
    if (`${file.project}/${relative}` !== path)
      throw new Error("Unexpected block export path");
    window.dispatchEvent(new CustomEvent("pi:open-file", { detail: { path } }));
  } catch (error) {
    throw storageError(error, path);
  }
}
