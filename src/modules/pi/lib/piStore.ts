import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { create } from "zustand";
import {
  answerAsk as answerAskIn,
  applyEvent,
  askResponseLine,
  dismissAsk as dismissAskIn,
  initialPiSessionState,
  messageBlocks,
  promptLine,
  recordSavedAttachments,
  resetAsk as resetAskIn,
  type PiAskAnswer,
  type PiFeedItem,
  type PiImageAttachment,
  type PiSavedAttachment,
  type PiSessionState,
  type PiStreamingBehavior,
} from "./parse";
import {
  modelRowsForProvider,
  parsePiModels,
  piSpawnEnv,
  resolvePiPrefs,
  type PiModelRow,
  type PiRuntimePrefs,
} from "./providers";
import { openPiSession, type PiSessionHandle } from "./rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./settingsSchema";
import { groupTurns, messageText } from "./turns";

export type PiOpenOptions = {
  cwd?: string;
  launcherDir?: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Resolved model roles for the session; ChatPane reads this for its
 *  data-pi-model / data-pi-smol root attributes. */
export type PiRoles = { provider: string; model: string; smol: string };

/** A prompt sent while a turn was streaming: queued locally in the order it
 *  was sent, with pi's acknowledgement state for the prompt command. */
export type PiQueued = {
  id: string;
  text: string;
  images: PiImageAttachment[];
  /** pi answered success for the prompt command: the follow-up is in its
   *  queue and Remove (a local-only recall) is no longer offered. */
  acked: boolean;
};

/** Text handed back to the composer after a refused send or a queued Remove:
 *  restored into the empty editor once, then cleared. */
export type PiRejectedDraft = {
  text: string;
  images: PiImageAttachment[];
  /** The rejection reason; null when the return was user-initiated. */
  error: string | null;
};

type PiTabEntry = {
  /** Open generation; a later open for the same tab supersedes this one. */
  gen: number;
  state: PiSessionState;
  session: PiSessionHandle | null;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
  roles: PiRoles;
  cwd?: string;
  pendingAttachments?: PiSavedAttachment[][];
  /** Follow-ups sent while a turn was streaming, in send order. */
  queued?: PiQueued[];
  /** The newest send whose prompt response has not landed yet; pi 0.3.0
   *  echoes no id for our id-less commands, so this is the correlation. */
  lastPrompt?: { text: string; images: PiImageAttachment[] } | null;
  rejectedDraft?: PiRejectedDraft | null;
};

type PiStore = {
  tabs: Record<number, PiTabEntry>;
  /** Parsed `pi --list-models` rows per provider id, cached so the composer's
   *  vision flag reads the table without a probe per render. */
  modelRows: Record<string, PiModelRow[]>;
  /**
   * Fetches and caches the model rows for one provider through the Rust
   * probe (`pi_list_models`), which runs pi with the stored cloud keys only.
   * No-op while a fetch is in flight or rows are already cached; a failed
   * probe leaves no cache entry so a later call retries.
   */
  ensureModelRows: (provider: string, cwd?: string) => Promise<void>;
  openSession: (tabId: number, opts: PiOpenOptions) => Promise<void>;
  sendPrompt: (
    tabId: number,
    text: string,
    images?: PiImageAttachment[],
  ) => Promise<void>;
  /** Drops a queued prompt that pi has not acknowledged yet and hands its
   *  text back to the composer. pi's own queue cannot be cancelled. */
  removeQueued: (tabId: number, id: string) => void;
  /** Clears the composer restore field once Composer has rebound the text. */
  clearRejectedDraft: (tabId: number) => void;
  answerAsk: (
    tabId: number,
    requestId: string,
    answers: PiAskAnswer[],
  ) => Promise<void>;
  dismissAsk: (tabId: number, requestId: string) => Promise<void>;
  kill: (tabId: number) => Promise<void>;
  close: (tabId: number) => void;
};

// Returns a store partial, not the map: zustand merges what `set` returns
// into the root state, so returning the map would write entries beside
// `tabs` and leave `tabs` untouched.
function patchEntry(
  tabs: Record<number, PiTabEntry>,
  tabId: number,
  patch: (entry: PiTabEntry) => PiTabEntry,
): { tabs: Record<number, PiTabEntry> } {
  const entry = tabs[tabId];
  if (!entry) return { tabs };
  return { tabs: { ...tabs, [tabId]: patch(entry) } };
}

let openGen = 0;

/** Session-wide counter giving each queued prompt a stable data-uat-key. */
let queuedSeq = 0;

function attachmentError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PiEventPatch = Pick<
  PiTabEntry,
  "state" | "pendingAttachments" | "queued" | "lastPrompt" | "rejectedDraft"
>;

/** Sniffs one event line for a prompt command response; null for anything
 *  else. The reducer ignores success frames, so the queue bookkeeping here
 *  reads both outcomes: success acknowledges the newest send (an idle start
 *  or an accepted follow-up, rpc.rs answers response_ok right after
 *  push_follow_up), failure refuses it. pi 0.3.0 echoes no id for our
 *  id-less commands, so lastPrompt is the correlation. */
function promptResponse(line: string): {
  ok: boolean;
  error: string | null;
} | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("{")) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "response" ||
    (event as { command?: unknown }).command !== "prompt"
  ) {
    return null;
  }
  const record = event as { success?: unknown; error?: unknown };
  return {
    ok: record.success !== false,
    error: typeof record.error === "string" ? record.error : null,
  };
}

function applyPiEvent(entry: PiTabEntry, line: string): PiEventPatch {
  const previous = entry.state;
  let state = applyEvent(previous, line);
  let pending = entry.pendingAttachments ?? [];
  let queued = entry.queued ?? [];
  let lastPrompt = entry.lastPrompt ?? null;
  let rejectedDraft = entry.rejectedDraft ?? null;

  const response = promptResponse(line);
  if (response && lastPrompt) {
    const sentPrompt = lastPrompt;
    if (response.ok) {
      // Accepted: whichever matching entry is still unacked is now in pi's
      // queue and Remove is no longer offered for it.
      let acked = false;
      queued = queued.map((q) => {
        if (acked || q.acked || q.text !== sentPrompt.text) return q;
        acked = true;
        return { ...q, acked: true };
      });
      lastPrompt = null;
    } else {
      // Refused: pi put the "prompt rejected" card on the feed; hand the
      // text back to the composer instead of leaving it lost, and do not
      // keep a queued entry pi never accepted.
      const index = queued.findIndex(
        (q) => !q.acked && q.text === sentPrompt.text,
      );
      if (index !== -1) queued = queued.filter((_, i) => i !== index);
      rejectedDraft = {
        text: sentPrompt.text,
        images: sentPrompt.images,
        error: response.error,
      };
      lastPrompt = null;
    }
  }

  if (state.switching || state.blocks.length < previous.blocks.length) {
    // The session that held the follow-up queue is gone: queued prompts can
    // never run, so they must not read as pending. The composer restore and
    // the send awaiting its ack are not tied to this session and stay.
    return {
      state,
      pendingAttachments: [],
      queued: [],
      lastPrompt,
      rejectedDraft,
    };
  }

  if (pending.length === 0 && queued.length === 0) {
    return {
      state,
      pendingAttachments: pending,
      queued,
      lastPrompt,
      rejectedDraft,
    };
  }

  const previousUserIds = new Set(
    previous.blocks
      .filter(
        (block): block is Extract<PiFeedItem, { kind: "message" }> =>
          block.kind === "message" && block.role === "user",
      )
      .map((block) => block.id),
  );
  const user = state.blocks.find(
    (block): block is Extract<PiFeedItem, { kind: "message" }> =>
      block.kind === "message" &&
      block.role === "user" &&
      !previousUserIds.has(block.id),
  );
  if (!user || user.kind !== "message") {
    return {
      state,
      pendingAttachments: pending,
      queued,
      lastPrompt,
      rejectedDraft,
    };
  }

  if (pending.length > 0) {
    state = recordSavedAttachments(state, user.id, pending[0]);
    pending = pending.slice(1);
  }
  // A queued follow-up leaves the local queue once pi emits the user block
  // carrying its text (the first matching block after the queue push).
  if (queued.length > 0) {
    const text = messageText(user);
    const index = queued.findIndex((q) => q.text === text);
    if (index !== -1) queued = queued.filter((_, i) => i !== index);
  }
  return {
    state,
    pendingAttachments: pending,
    queued,
    lastPrompt,
    rejectedDraft,
  };
}

/** Global pi prefs from the LazyStore (defaults when not yet hydrated). */
function globalPiPrefs(): Partial<PiRuntimePrefs> {
  const p = usePreferencesStore.getState();
  return {
    launcherDir: p.piLauncherDir,
    boardBin: p.piBoardBin,
    agentBin: p.piAgentBin,
    agentDir: p.piAgentDir,
    provider: p.piProvider,
    model: p.piModel,
    thinking: p.piThinking,
    smol: p.piSmol,
    bppcHost: p.piBppcHost,
  };
}

/** Parses `<cwd>/.pi/terax.json`; unreadable or missing file resolves to null. */
async function readWorkspaceOverrides(cwd?: string): Promise<unknown> {
  if (!cwd) return null;
  try {
    const res = await invoke<{ kind: string; content?: string }>(
      "fs_read_file",
      { path: `${cwd}/.pi/terax.json`, workspace: currentWorkspaceEnv() },
    );
    if (res.kind !== "text" || !res.content) return null;
    return JSON.parse(res.content) as unknown;
  } catch {
    return null;
  }
}

async function resolvePrefsForCwd(cwd?: string): Promise<PiRuntimePrefs> {
  const overrides = await readWorkspaceOverrides(cwd);
  return resolvePiPrefs(globalPiPrefs(), overrides);
}

/** Providers with a model-table fetch in flight; dedupes parallel calls. */
const modelRowsInFlight = new Set<string>();

export const usePiStore = create<PiStore>()((set, get) => ({
  tabs: {},
  modelRows: {},

  ensureModelRows: async (provider, cwd) => {
    const id = provider.trim();
    if (!id || modelRowsInFlight.has(id) || get().modelRows[id]) return;
    modelRowsInFlight.add(id);
    try {
      const resolved = await resolvePrefsForCwd(cwd);
      const out = await invoke<string>("pi_list_models", {
        prefs: {
          launcherDir: resolved.launcherDir,
          agentDir: resolved.agentDir,
        },
        pattern: null,
      });
      const rows = modelRowsForProvider(parsePiModels(out), id);
      // An empty listing (no stored key yet, or a provider with no models)
      // stays uncached: storing a key in Settings must let the next tab
      // fetch again instead of reading a frozen empty table.
      if (rows.length > 0) {
        set((s) => ({ modelRows: { ...s.modelRows, [id]: rows } }));
      }
    } catch {
      // No table (pi missing, probe failed): leave no cache entry, so the
      // vision flag stays unknown and a later call retries.
    } finally {
      modelRowsInFlight.delete(id);
    }
  },

  openSession: async (tabId, opts) => {
    // A second open for the same tab replaces the first; the stale in-flight
    // open is killed the moment it resolves.
    const gen = ++openGen;
    const resolved = await resolvePrefsForCwd(opts.cwd);
    // The PiTab default param equals the module default; an explicit caller
    // override wins, otherwise the user's launcherDir pref applies.
    const launcherDir =
      opts.launcherDir &&
      opts.launcherDir !== PI_MODULE_PREFS_DEFAULTS.launcherDir
        ? opts.launcherDir
        : resolved.launcherDir;
    const entry: PiTabEntry = {
      gen,
      state: initialPiSessionState(),
      session: null,
      exited: false,
      exitCode: null,
      error: null,
      roles: {
        provider: resolved.provider,
        model: resolved.model,
        smol: resolved.smol,
      },
      cwd: opts.cwd,
      pendingAttachments: [],
      queued: [],
      lastPrompt: null,
      rejectedDraft: null,
    };
    set((s) => ({ tabs: { ...s.tabs, [tabId]: entry } }));
    try {
      const session = await openPiSession({
        ...opts,
        launcherDir,
        env: {
          // Both spawn paths (checkout launcher, direct pi) inherit this env:
          // the bppc host rides from the pref (workspace override included),
          // and Rust injects the stored oMLX key caller-wins, so the
          // models.json render and pi itself see the same values.
          ...piSpawnEnv(resolved, resolved.agentDir, {
            bppcHost: resolved.bppcHost,
          }),
          ...opts.env,
        },
        onEvent: (line) =>
          set((s) =>
            patchEntry(s.tabs, tabId, (e) => {
              const next = applyPiEvent(e, line);
              return { ...e, ...next };
            }),
          ),
        onExit: (code) =>
          set((s) =>
            patchEntry(s.tabs, tabId, (e) => ({
              ...e,
              session: null,
              exited: true,
              exitCode: code,
            })),
          ),
      });
      // Events may have patched the entry before open resolved, so compare
      // the generation, not the object.
      if (get().tabs[tabId]?.gen !== gen) {
        void session.kill();
        return;
      }
      set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, session })));
    } catch (e) {
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => ({
          ...err,
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  sendPrompt: async (tabId, text, images) => {
    const entry = get().tabs[tabId];
    const session = entry?.session;
    if (!session) return;
    const attachments = images ?? [];
    // pi refuses a bare prompt while a turn is in flight ("Agent is currently
    // streaming; specify streamingBehavior"), which used to drop the text.
    // While thinking or running a tool the prompt rides streamingBehavior
    // "follow-up": pi queues it and runs it when the turn ends. awaiting-ask
    // stays on the plain path: a follow-up would sit behind the open question.
    const status = entry.state.status;
    const busy = status !== "idle" && status !== "awaiting-ask";
    const behavior: PiStreamingBehavior | undefined = busy
      ? "follow-up"
      : undefined;
    const queuedId = busy ? `queued-${(queuedSeq += 1)}` : null;
    const saved: PiSavedAttachment[] = [];
    if (attachments.length > 0) {
      const turn = groupTurns(messageBlocks(entry.state.blocks)).length;
      for (const [n, image] of attachments.entries()) {
        try {
          const path = await invoke<string>("pi_save_attachment", {
            cwd: entry.cwd ?? "",
            turn,
            n,
            mediaType: image.mediaType,
            data: image.data,
            workspace: currentWorkspaceEnv(),
          });
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("attachment writer returned no path");
          }
          saved.push({ path, error: null });
        } catch (error) {
          saved.push({ path: null, error: attachmentError(error) });
        }
      }
      if (get().tabs[tabId]?.session !== session) return;
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          pendingAttachments: [...(e.pendingAttachments ?? []), saved],
        })),
      );
    }
    // The queue entry lands before the write so pi's ack, which can only
    // arrive after the line is sent, finds it; the catch rolls it back.
    if (queuedId) {
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          queued: [
            ...(e.queued ?? []),
            { id: queuedId, text, images: attachments, acked: false },
          ],
        })),
      );
    }
    // The response frame names no id for our id-less commands, so the store
    // holds the newest send until its ack or rejection arrives.
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        lastPrompt: { text, images: attachments },
      })),
    );
    try {
      await session.send(promptLine(text, images, behavior));
    } catch (error) {
      if (saved.length > 0) {
        set((s) =>
          patchEntry(s.tabs, tabId, (e) => {
            const pending = e.pendingAttachments ?? [];
            const index = pending.indexOf(saved);
            return index === -1
              ? e
              : {
                  ...e,
                  pendingAttachments: [
                    ...pending.slice(0, index),
                    ...pending.slice(index + 1),
                  ],
                };
          }),
        );
      }
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          queued: queuedId
            ? (e.queued ?? []).filter((q) => q.id !== queuedId)
            : e.queued,
          // The write failed before pi saw the text: give it back to the
          // composer instead of dropping it on the floor.
          rejectedDraft: {
            text,
            images: attachments,
            error: attachmentError(error),
          },
        })),
      );
      throw error;
    }
  },

  removeQueued: (tabId, id) => {
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => {
        const queued = e.queued ?? [];
        const removed = queued.find((q) => q.id === id);
        if (!removed) return e;
        // Remove only pulls the text back into the composer (through the
        // same restore rejections use). pi 0.3.0 has no command that cancels
        // an already-accepted follow-up, so an acked prompt would still run
        // when the current turn ends; the button is only offered pre-ack.
        return {
          ...e,
          queued: queued.filter((q) => q.id !== id),
          rejectedDraft: {
            text: removed.text,
            images: removed.images,
            error: null,
          },
        };
      }),
    );
  },

  clearRejectedDraft: (tabId) => {
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({ ...e, rejectedDraft: null })),
    );
  },

  answerAsk: async (tabId, requestId, answers) => {
    const entry = get().tabs[tabId];
    if (!entry) return;
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        state: answerAskIn(e.state, requestId, answers),
      })),
    );
    try {
      await entry.session?.send(askResponseLine(requestId, answers));
    } catch (e) {
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => ({
          ...err,
          state: resetAskIn(err.state, requestId),
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  dismissAsk: async (tabId, requestId) => {
    const entry = get().tabs[tabId];
    if (!entry) return;
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        state: dismissAskIn(e.state, requestId),
      })),
    );
    try {
      await entry.session?.send(
        JSON.stringify({ type: "ask_response", requestId, dismissed: true }),
      );
    } catch (e) {
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => ({
          ...err,
          state: resetAskIn(err.state, requestId),
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  kill: async (tabId) => {
    const session = get().tabs[tabId]?.session;
    if (!session) return;
    await session.kill();
  },

  close: (tabId) => {
    const entry = get().tabs[tabId];
    if (!entry) return;
    set((s) => {
      if (!s.tabs[tabId]) return s;
      const tabs = { ...s.tabs };
      delete tabs[tabId];
      return { tabs };
    });
    void entry.session?.kill();
  },
}));
