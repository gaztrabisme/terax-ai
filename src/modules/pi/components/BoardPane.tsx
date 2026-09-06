import { invoke } from "@tauri-apps/api/core";
import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { quoteShellArg } from "@/lib/shellQuote";
import { useEffect, useState } from "react";

type CommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type Props = {
  cwd?: string;
  /** Bumped by the parent after any board_ tool execution. */
  refreshKey?: number;
  /** Overrides the configured board CLI path. */
  boardBin?: string;
};

// The binary is an absolute setting, not a cwd-relative lookup; --root points
// it at the project whose .pi/board.db it should read while the shell keeps
// the tab cwd as working directory.
export function boardListCommand(boardBin: string, root: string): string {
  return `${quoteShellArg(boardBin)} --root ${quoteShellArg(root)} board`;
}

export function boardShowCommand(
  boardBin: string,
  root: string,
  ticketId: string,
): string {
  return `${quoteShellArg(boardBin)} --root ${quoteShellArg(root)} show ${quoteShellArg(ticketId)}`;
}

// The board is read through <cwd>/bin/board via the existing one-shot shell
// command; text output only, no SQLite dependency.
export function BoardPane({
  cwd,
  refreshKey = 0,
  boardBin = PI_MODULE_PREFS_DEFAULTS.boardBin,
}: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    invoke<CommandOutput>("shell_run_command", {
      command: boardListCommand(boardBin, cwd),
      cwd,
      timeoutSecs: 15,
      workspace: currentWorkspaceEnv(),
    })
      .then((out) => {
        if (!alive) return;
        if (out.exitCode !== 0 && out.stdout.trim() === "") {
          setError(out.stderr.trim() || `board exited ${out.exitCode}`);
          setLines([]);
          return;
        }
        setError(null);
        setLines(out.stdout.split("\n").filter((l) => l.trim().length > 0));
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, refreshKey]);

  const openTicket = (id: string) => {
    if (!cwd) return;
    setSelected(id);
    setDetail(null);
    void invoke<CommandOutput>("shell_run_command", {
      command: boardShowCommand(boardBin, cwd, id),
      cwd,
      timeoutSecs: 15,
      workspace: currentWorkspaceEnv(),
    })
      .then((out) => setDetail(out.stdout.trim() || out.stderr.trim()))
      .catch((e: unknown) =>
        setDetail(e instanceof Error ? e.message : String(e)),
      );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border/60">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-[10px] font-medium uppercase text-muted-foreground">
        <span>board</span>
        <span className="flex-1" />
        {error ? (
          <span className="normal-case text-destructive">offline</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[11px]">
        {error ? <div className="text-muted-foreground">{error}</div> : null}
        {!error && lines.length === 0 ? (
          <div className="text-muted-foreground">No board output.</div>
        ) : null}
        {lines.map((line, i) => {
          const id = line.match(/[a-zA-Z0-9]+-[0-9]+/)?.[0];
          return (
            <button
              key={i}
              type="button"
              onClick={() => id && openTicket(id)}
              className={`block w-full truncate rounded px-1 py-0.5 text-left font-mono hover:bg-accent hover:text-foreground ${
                selected && id === selected ? "bg-accent text-foreground" : ""
              }`}
              title={line}
            >
              {line}
            </button>
          );
        })}
        {detail ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-accent/40 p-1.5 font-mono text-[10px]">
            {detail}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
