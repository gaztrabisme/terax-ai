import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { abortLine } from "./parse";

export type PiOpenOptions = {
  cwd?: string;
  /** Dir whose bin/efficient-pi (then bin/pi) launches the session; empty falls back to cwd-local bin/. A leading $HOME/ expands Rust-side. */
  launcherDir?: string;
  /** Empty/undefined lets the Rust side resolve the binary from launcherDir. */
  program?: string;
  /** The resolved global Settings piAgentBin: the agent binary the board
   *  tools use. A project .pi/terax.json override wins Rust-side; an empty
   *  or undefined value leaves the agent binary to the Rust resolver. */
  agentBin?: string;
  args?: string[];
  env?: Record<string, string>;
  onEvent: (line: string) => void;
  onExit?: (code: number) => void;
};

export type PiSessionHandle = {
  id: number;
  /** Sends one JSON command line to pi's stdin. */
  send: (line: string) => Promise<void>;
  /** Sends pi's rpc abort command (rpc.rs "abort"): stops the run in flight
   *  without killing the process. Stop and composer Escape both land here.
   *  Optional so callers fall back to send(abortLine()); openPiSession
   *  always provides it. */
  abort?: () => Promise<void>;
  kill: () => Promise<void>;
};

export type PiTranscriptLine = { file: string; line: string };

export type TranscriptWatch = { id: number; close: () => Promise<void> };

export async function watchTranscripts(
  agentDir: string,
  onLine: (line: PiTranscriptLine) => void,
  onError?: (error: string) => void,
): Promise<TranscriptWatch> {
  const channel = new Channel<PiTranscriptLine>();
  let released = false;
  channel.onmessage = (line) => {
    if (released) return;
    if (!line || typeof line.file !== "string" || typeof line.line !== "string") {
      onError?.("invalid transcript watcher frame");
      return;
    }
    onLine(line);
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
    launcherDir: opts.launcherDir ?? null,
    program: opts.program ?? null,
    agentBin: opts.agentBin ?? null,
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
    abort: () => invoke("pi_send", { id, line: abortLine() }),
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
