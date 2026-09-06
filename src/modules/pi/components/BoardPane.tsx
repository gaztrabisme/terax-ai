import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
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
};

// The board is read through <cwd>/bin/board via the existing one-shot shell
// command; text output only, no SQLite dependency.
export function BoardPane({ cwd, refreshKey = 0 }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    invoke<CommandOutput>("shell_run_command", {
      command: "bin/board board",
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
      command: `bin/board show ${id}`,
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
