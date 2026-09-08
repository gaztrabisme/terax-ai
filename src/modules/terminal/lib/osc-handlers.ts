import type { IMarker, Terminal } from "@xterm/xterm";

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside a running
 * command (between OSC 133 B and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by *command output* (e.g. a remote SSH
 * server, a `cat` of an attacker-controlled file). Only OSC 7 issued by the
 * local shell — which fires between commands — should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook.
    if (state?.inCommand) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

/**
 * Block-oriented events distilled from OSC 133, consumed by the per-session
 * BlockStore (see blocks.ts). C carries the command text the shell embeds in
 * the payload (first 256 chars for zsh); D carries the exit code, or null
 * when the payload has no parseable one.
 */
export type PromptEvent =
  | { type: "A" }
  | { type: "C"; command: string | null }
  | { type: "D"; exitCode: number | null };

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
  onEvent?: (event: PromptEvent) => void,
): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      marker?.dispose();
      marker = term.registerMarker(0);
      onEvent?.({ type: "A" });
    } else if (data.startsWith("B")) {
      // OSC 133 B — command begins. From here on, treat all output as
      // untrusted until we see D (command exit) or the next A (new prompt).
      if (state) state.inCommand = true;
    } else if (data.startsWith("C")) {
      // OSC 133 C — command pre-execution marker; still inside command.
      if (state) state.inCommand = true;
      onEvent?.({ type: "C", command: parseOsc133CommandText(data) });
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
      onEvent?.({ type: "D", exitCode: parseOsc133ExitCode(data) });
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

/**
 * Command text from an OSC 133 C payload: "C" or "C;<text>". The payload is
 * the first 256 chars of the command line (zshrc.zsh), so it may itself
 * contain semicolons; everything after the first one is command text. A bare
 * C (bash PS0, fish preexec without text) or an empty payload means no text.
 */
export function parseOsc133CommandText(data: string): string | null {
  const rest = data.slice(1);
  if (!rest.startsWith(";")) return null;
  const text = rest.slice(1);
  return text.length > 0 ? text : null;
}

/**
 * Exit code from an OSC 133 D payload: "D" or "D;<code>". Missing or
 * unparseable means null: the block closes as "unknown" instead of being
 * reported as success without evidence.
 */
export function parseOsc133ExitCode(data: string): number | null {
  const m = data.match(/^D;(-?\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}
