import { useEffect, useRef, useState } from "react";
import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BLOCK_RING_CAPACITY, type Block } from "@/modules/terminal/lib/blocks";
import {
  finishedBlocks,
  readBlockOutput,
  readTerminalStream,
  terminalHistory,
  terminalList,
  storageError,
  type JournalRecord,
  type TerminalInfo,
} from "@/modules/terminal/lib/journal";
import {
  respawnSession,
  terminalHistoryCanReplace,
} from "@/modules/terminal/lib/useTerminalSession";
import {
  recordedOutput,
  type OutputSpan,
} from "@/modules/terminal/lib/recordedOutput";
import { getSlotForLeaf } from "@/modules/terminal/lib/rendererPool";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { useTheme } from "@/modules/theme";
import {
  renderRecoveredChrome,
  type BlockErrorHandler,
} from "@/modules/terminal/components/BlockChrome";

export function RecoveredBlock({
  record,
  project,
  leafId,
  onError,
}: {
  record: JournalRecord;
  project: string;
  leafId: number;
  onError: BlockErrorHandler;
}) {
  const header = useRef<HTMLDivElement>(null);
  const [output, setOutput] = useState<OutputSpan[][] | null>(null);
  const [limit, setLimit] = useState(64 * 1024);
  const { themeId, resolvedMode, customThemes } = useTheme();
  useEffect(() => {
    if (!header.current) return;
    const block: Block = {
      id: record.seq,
      command: record.command || null,
      startedAt:
        record.startedAt === null ? null : Date.parse(record.startedAt),
      endedAt: record.endedAt === null ? null : Date.parse(record.endedAt),
      durationMs: record.durationMs,
      exitCode: typeof record.exit === "number" ? record.exit : null,
      status:
        record.exit === 0
          ? "ok"
          : typeof record.exit === "number"
            ? "error"
            : "unknown",
      marker: null,
      interrupted: record.event === "interrupted",
      commandTruncated: record.commandTruncated,
      file: { project, record },
    };
    renderRecoveredChrome(header.current, leafId, block, onError);
  }, [record, project, leafId, onError]);
  useEffect(() => {
    let cancelled = false;
    setOutput(null);
    const load = async () => {
      const raw = await readBlockOutput({ project, record }, limit);
      if (cancelled) return;
      const rendered = await recordedOutput(
        raw,
        getSlotForLeaf(leafId)?.term.cols ?? 80,
        buildTerminalTheme(),
      );
      if (!cancelled) setOutput(rendered);
    };
    void load().catch((error) => {
      if (!cancelled)
        onError(storageError(error, `${project}/${record.outputPath}`), load);
    });
    return () => {
      cancelled = true;
    };
  }, [
    record,
    project,
    leafId,
    limit,
    themeId,
    resolvedMode,
    customThemes,
    onError,
  ]);
  return (
    <section
      data-uat="terminal-block"
      data-uat-key={record.blockId}
      className="border-b border-border/60 p-2"
    >
      <div ref={header} />
      <pre
        aria-label="Recorded terminal output"
        className="m-0 overflow-x-auto whitespace-pre py-2 font-[inherit]"
      >
        {output === null
          ? "Loading output"
          : output.map((line, y) => (
              <span key={y} className="block min-h-[1em]">
                {line.map((span, x) => (
                  <span key={x} style={span.style}>
                    {span.text}
                  </span>
                ))}
              </span>
            ))}
      </pre>
      {record.outputBytes > limit && (
        <button
          type="button"
          aria-label="Show full recorded output"
          className="p-2 text-xs text-muted-foreground"
          onClick={() => setLimit(record.outputBytes)}
        >
          Show full output ({record.outputBytes} bytes)
        </button>
      )}
    </section>
  );
}

export function TerminalHistory({
  project,
  terminalId,
  leafId,
  onError,
}: {
  project: string;
  terminalId?: string;
  leafId: number;
  onError: BlockErrorHandler;
}) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<TerminalInfo | null>(null);
  const fontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const fontSize = usePreferencesStore((s) => s.terminalFontSize);
  const zoom = usePreferencesStore((s) => s.zoomLevel);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setRecords([]);
    setSelected(null);
    setOpen(false);
    setTerminals([]);
  }, [project]);
  const refresh = async () => {
    setLoading(true);
    try {
      setTerminals(await terminalList(project));
    } finally {
      setLoading(false);
    }
  };
  const reopen = async (info: TerminalInfo) => {
    setBusy(true);
    try {
      if (!(await terminalHistoryCanReplace(leafId))) return;
      const restored = finishedBlocks(
        await terminalHistory(project, info.terminalId),
      );
      await respawnSession(leafId, info.cwd);
      setRecords(restored);
      setSelected(info);
      setPage(
        Math.max(0, Math.ceil(restored.length / BLOCK_RING_CAPACITY) - 1),
      );
      setOpen(false);
      trigger.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="relative flex shrink-0 items-center gap-2 border-b border-border/60 p-2 text-xs text-muted-foreground">
        <button
          ref={trigger}
          type="button"
          aria-label="List terminal history"
          aria-expanded={open}
          className="rounded px-2 hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          onClick={() => {
            setOpen(!open);
            if (!open)
              void refresh().catch((e) =>
                onError(storageError(e, `${project}/.pi/terminal`), refresh),
              );
          }}
        >
          Terminal history
        </button>
        {selected && <span>Recorded history / fresh shell</span>}
        {open && (
          <div
            role="region"
            aria-label="Past terminals"
            className="absolute left-2 top-full z-30 flex max-h-64 max-w-full flex-col gap-2 overflow-auto rounded border border-border bg-background p-2 shadow-sm"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            {loading ? (
              <span role="status">Loading terminal history</span>
            ) : terminals.length === 0 ? (
              <span>No terminal history yet.</span>
            ) : (
              terminals
                .filter((t) => t.terminalId !== terminalId)
                .map((info) => (
                  <button
                    key={info.terminalId}
                    type="button"
                    data-uat="terminal-history-reopen"
                    data-uat-key={info.terminalId}
                    aria-label="Reopen terminal history"
                    disabled={busy}
                    title={info.terminalId}
                    className="rounded p-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
                    onClick={() => {
                      void reopen(info).catch((e) =>
                        onError(
                          storageError(
                            e,
                            `${project}/.pi/terminal/${info.terminalId}/blocks.jsonl`,
                          ),
                          () => reopen(info),
                        ),
                      );
                    }}
                  >
                    <span className="block">{info.cwd}</span>
                    <time dateTime={info.time}>{info.time}</time>
                  </button>
                ))
            )}
          </div>
        )}
      </div>
      {selected && (
        <div
          role="region"
          aria-label="Recovered terminal history"
          className="max-h-[50%] shrink-0 overflow-auto"
          style={{
            fontFamily: fontFamily || detectMonoFontFamily(),
            fontSize: Math.max(4, Math.round(fontSize * zoom)),
          }}
        >
          {records.length > BLOCK_RING_CAPACITY && (
            <nav
              aria-label="Terminal history pages"
              className="flex items-center gap-2 p-2 text-xs"
            >
              <button
                type="button"
                aria-label="Older terminal blocks"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Older blocks
              </button>
              <span>
                {page * BLOCK_RING_CAPACITY + 1} to{" "}
                {Math.min(records.length, (page + 1) * BLOCK_RING_CAPACITY)} of{" "}
                {records.length}
              </span>
              <button
                type="button"
                aria-label="Newer terminal blocks"
                disabled={(page + 1) * BLOCK_RING_CAPACITY >= records.length}
                onClick={() => setPage(page + 1)}
              >
                Newer blocks
              </button>
            </nav>
          )}
          <RawTerminalStream
            key={selected.terminalId}
            project={project}
            terminal={selected}
            leafId={leafId}
            defaultOpen={records.length === 0}
            onError={onError}
          />
          {records
            .slice(page * BLOCK_RING_CAPACITY, (page + 1) * BLOCK_RING_CAPACITY)
            .map((record) => (
              <RecoveredBlock
                key={record.blockId}
                record={record}
                project={project}
                leafId={leafId}
                onError={onError}
              />
            ))}
        </div>
      )}
    </>
  );
}

function RawTerminalStream({
  project,
  terminal,
  leafId,
  defaultOpen,
  onError,
}: {
  project: string;
  terminal: TerminalInfo;
  leafId: number;
  defaultOpen: boolean;
  onError: BlockErrorHandler;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [limit, setLimit] = useState(64 * 1024);
  const [output, setOutput] = useState<OutputSpan[][] | null>(null);
  const { themeId, resolvedMode, customThemes } = useTheme();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      const raw = await readTerminalStream(project, terminal, limit);
      if (cancelled) return;
      const rendered = await recordedOutput(
        raw,
        getSlotForLeaf(leafId)?.term.cols ?? 80,
        buildTerminalTheme(),
      );
      if (!cancelled) setOutput(rendered);
    };
    void load().catch((error) => {
      if (!cancelled)
        onError(
          storageError(
            error,
            `${project}/.pi/terminal/${terminal.terminalId}/stream.ansi`,
          ),
          load,
        );
    });
    return () => {
      cancelled = true;
    };
  }, [
    project,
    terminal,
    leafId,
    open,
    limit,
    themeId,
    resolvedMode,
    customThemes,
    onError,
  ]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="p-2"
    >
      <summary
        aria-label="Recorded terminal stream"
        className="cursor-pointer text-xs text-muted-foreground"
      >
        Recorded terminal stream
      </summary>
      {open && (
        <pre
          aria-label="Recorded raw terminal output"
          className="m-0 overflow-x-auto whitespace-pre py-2 font-[inherit]"
        >
          {output === null
            ? "Loading output"
            : output.map((line, y) => (
                <span key={y} className="block min-h-[1em]">
                  {line.map((span, x) => (
                    <span key={x} style={span.style}>
                      {span.text}
                    </span>
                  ))}
                </span>
              ))}
        </pre>
      )}
      {open && terminal.streamBytes > limit && (
        <button
          type="button"
          aria-label="Show full recorded stream"
          className="p-2 text-xs text-muted-foreground"
          onClick={() => setLimit(terminal.streamBytes)}
        >
          Show full stream ({terminal.streamBytes} bytes)
        </button>
      )}
    </details>
  );
}
