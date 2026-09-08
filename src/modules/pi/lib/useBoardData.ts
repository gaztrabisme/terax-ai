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
  refresh: () => void;
};

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
  const loadSeq = useRef(0);
  const refresh = useCallback(() => {
    if (!cwd || !enabled) return;
    const seq = ++loadSeq.current;
    ensureAgentBin(agentBin)
      .then((bin) =>
        invoke<{ stdout: string; stderr: string; exit_code: number | null }>(
          "shell_run_command",
          {
            command: boardListCommand(boardBin, cwd, bin),
            cwd,
            timeoutSecs: 15,
            workspace: currentWorkspaceEnv(),
          },
        ),
      )
      .then((out) => {
        if (seq !== loadSeq.current) return;
        if (out.exit_code !== 0 && out.stdout.trim() === "") {
          setError(out.stderr.trim() || `board exited ${out.exit_code}`);
          return;
        }
        try {
          setSnapshot(parseBoard(out.stdout));
          setError(null);
        } catch {
          setError(out.stderr.trim() || "board printed unparseable output");
        }
      })
      .catch((e: unknown) => {
        if (seq === loadSeq.current)
          setError(e instanceof Error ? e.message : String(e));
      });
  }, [cwd, boardBin, agentBin, enabled]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
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

  return { snapshot, error, refresh };
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
