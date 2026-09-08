import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  boardListCommand,
  ensureAgentBin,
  parseBoard,
  type BoardSnapshot,
} from "./board";
import { PI_MODULE_PREFS_DEFAULTS } from "./settingsSchema";

export const POLL_MS = 10000;
export type BoardData = {
  snapshot: BoardSnapshot | null;
  error: string | null;
  /** The full command whose poll or refresh failed; the board-error header
   * names it and the log path. Null while the last load succeeded. */
  failedCommand: string | null;
  refresh: () => void;
};

/** The project-relative board failure log (design.md section 3.4). */
export function boardLogPath(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/.pi/logs/board.jsonl`;
}

/**
 * Appends one failure record to <project>/.pi/logs/board.jsonl. There is no
 * append invoke, so the existing log is read back, the line is added, and the
 * file is rewritten through the same fs_write_file the drafts use (temp file
 * plus rename). Logging is best effort: it must never mask the refresh error
 * the pane already shows.
 */
export async function appendBoardLog(
  cwd: string,
  command: string,
  message: string,
): Promise<void> {
  const path = boardLogPath(cwd);
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  try {
    let existing = "";
    try {
      const res = await invoke<{ kind: string; content?: string }>(
        "fs_read_file",
        { path, workspace: currentWorkspaceEnv() },
      );
      if (res.kind === "text" && typeof res.content === "string") {
        existing = res.content;
      }
    } catch {
      // First failure: the log does not exist yet.
    }
    try {
      await invoke("fs_create_dir", {
        path: dir,
        workspace: currentWorkspaceEnv(),
      });
    } catch {
      // The logs directory existing is the normal steady state.
    }
    const record = JSON.stringify({
      time: new Date().toISOString(),
      command,
      error: message,
    });
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await invoke("fs_write_file", {
      path,
      content: `${existing}${prefix}${record}\n`,
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    // The failure stays loud through the board-error header; no log, no crash.
  }
}

export function useBoardData({
  cwd,
  refreshKey = 0,
  boardBin = PI_MODULE_PREFS_DEFAULTS.boardBin,
  agentBin,
  enabled = true,
}: {
  cwd?: string;
  refreshKey?: number;
  boardBin?: string;
  agentBin?: string;
  enabled?: boolean;
}): BoardData {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedCommand, setFailedCommand] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const refresh = useCallback(() => {
    if (!cwd || !enabled) return;
    const seq = ++loadSeq.current;
    let command = "board --json";
    // One failure path: keep the previous snapshot (stale), name the command,
    // and append the failure to the project board log.
    const fail = (message: string) => {
      if (seq !== loadSeq.current) return;
      setError(message);
      setFailedCommand(command);
      void appendBoardLog(cwd, command, message);
    };
    ensureAgentBin(agentBin)
      .then((bin) => {
        command = boardListCommand(boardBin, cwd, bin);
        return invoke<{ stdout: string; stderr: string; exit_code: number | null }>(
          "shell_run_command",
          {
            command,
            cwd,
            timeoutSecs: 15,
            workspace: currentWorkspaceEnv(),
          },
        );
      })
      .then((out) => {
        if (seq !== loadSeq.current) return;
        if (out.exit_code !== 0 && out.stdout.trim() === "") {
          fail(out.stderr.trim() || `board exited ${out.exit_code}`);
          return;
        }
        try {
          setSnapshot(parseBoard(out.stdout));
          setError(null);
          setFailedCommand(null);
        } catch {
          fail(out.stderr.trim() || "board printed unparseable output");
        }
      })
      .catch((e: unknown) => {
        if (seq === loadSeq.current)
          fail(e instanceof Error ? e.message : String(e));
      });
  }, [cwd, boardBin, agentBin, enabled]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setFailedCommand(null);
  }, [cwd]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => {
      ++loadSeq.current;
      window.clearInterval(timer);
    };
  }, [enabled, refresh, refreshKey]);

  return { snapshot, error, failedCommand, refresh };
}

export function awaitingDecisionCount(snapshot: BoardSnapshot | null): number {
  return new Set(
    snapshot?.tickets
      .filter((ticket) =>
        ["align", "verify", "review", "land"].includes(ticket.status),
      )
      .map((ticket) => ticket.id),
  ).size;
}
