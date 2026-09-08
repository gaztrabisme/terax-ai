import { invoke, Channel } from "@tauri-apps/api/core";
import type { JournalEvent } from "@/modules/terminal/lib/journal";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
  onJournal?: (event: JournalEvent) => void;
};

export type PtySession = {
  id: number;
  terminalId: string;
  project: string;
  retry: () => Promise<void>;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  project?: string,
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();
  const onJournal = new Channel<JournalEvent>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
    onJournal.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
  };

  onJournal.onmessage = (event) => handlers.onJournal?.(event);
  const { id, terminalId, project: savedProject } = await invoke<{ id: number; terminalId: string; project: string }>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    onData,
    onExit,
    onJournal,
    project: project ?? cwd ?? null,
  });

  let closed = false;

  return {
    id,
    terminalId,
    project: savedProject,
    retry: () => invoke("pty_terminal_retry", { id }),
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      releaseHandlers();
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
