import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type PiOpenOptions = {
  cwd?: string;
  /** Empty/undefined resolves bin/efficient-pi then bin/pi under cwd (Rust side). */
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  onEvent: (line: string) => void;
  onExit?: (code: number) => void;
};

export type PiSessionHandle = {
  id: number;
  /** Sends one JSON command line to pi's stdin. */
  send: (line: string) => Promise<void>;
  kill: () => Promise<void>;
};

export type PiTranscriptLine = { file: string; line: string };

export type TranscriptWatch = { id: number; close: () => Promise<void> };

export async function watchTranscripts(
  agentDir: string,
  onLine: (line: PiTranscriptLine) => void,
): Promise<TranscriptWatch> {
  const channel = new Channel<PiTranscriptLine>();
  let released = false;
  channel.onmessage = (line) => {
    if (!released) onLine(line);
  };
  const id = await invoke<number>("pi_watch_transcripts", {
    agentDir,
    workspace: currentWorkspaceEnv(),
    onLine: channel,
  });
  return {
    id,
    close: async () => {
      if (released) return;
      released = true;
      channel.onmessage = () => {};
      await invoke("pi_unwatch", { id });
    },
  };
}

export async function openPiSession(
  opts: PiOpenOptions,
): Promise<PiSessionHandle> {
  const onEvent = new Channel<string>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onEvent.onmessage = noop;
    onExit.onmessage = noop;
  };

  onEvent.onmessage = (line) => opts.onEvent(line);
  onExit.onmessage = (code) => {
    opts.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pi_open", {
    cwd: opts.cwd ?? null,
    program: opts.program ?? null,
    args: opts.args ?? null,
    env: opts.env ?? null,
    workspace: currentWorkspaceEnv(),
    onEvent,
    onExit,
  });

  let closed = false;
  return {
    id,
    send: (line) => invoke("pi_send", { id, line }),
    kill: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pi_kill", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
