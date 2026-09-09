import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { create } from "zustand";
import {
  abortLine,
  abortRetryLine,
  answerAsk as answerAskIn,
  applyEvent,
  askResponseLine,
  dismissAsk as dismissAskIn,
  initialPiSessionState,
  messageBlocks,
  promptLine,
  recordSavedAttachments,
  requestCancel,
  resetAsk as resetAskIn,
  sessionExited,
  turnInFlight,
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
import { clearDraft, loadDraft, loadDraftMeta, saveDraftMeta } from "./drafts";
import { stableIdOf } from "@/modules/tabs/lib/sid";

/** An image handed to sendPrompt: the wire shape plus the K13 transaction
 *  fields (stable attachment id and the draft file that already holds the
 *  bytes). Images without a draft file ride the legacy single-shot writer. */
export type ComposerImage = PiImageAttachment & {
  attachmentId?: string;
  draftPath?: string | null;
  sha256?: string | null;
};

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
  /** K13: the failed submission's attachment records, adopted by the
   *  composer's restored chips so ids and draft files survive the refusal. */
  records?: PiSentRecord[];
};

/** K13 transaction record for one attachment: the draft file it came from,
 *  the staged submission copy, and the content hash of both. */
export type PiSentRecord = {
  attachmentId: string;
  draftPath: string | null;
  stagedPath: string | null;
  sha256: string | null;
};

/** A submission whose send failed (transport throw or pi refusal). The
 *  draft record keeps state "failed" and the transcript offers a Retry
 *  submission control scoped to this id; a failed submission never binds
 *  to a later turn. */
export type PiFailedSubmission = {
  submissionId: string;
  text: string;
  /** The original images array; ChatPane matches its pending sets by
   *  identity to unbind thumbnails. */
  images: PiImageAttachment[];
  records: PiSentRecord[];
  error: string | null;
  state: "failed" | "retrying";
};

/** Attachments queued for binding, FIFO: the set that binds to the next
 *  user message block. `submissionId` is null for the legacy single-shot
 *  writer path (no transaction, no index entry); `text` carries the sent
 *  prompt so the post-bind draft cleanup can tell a stale draft from new
 *  text typed meanwhile. */
type PendingSet = {
  submissionId: string | null;
  saved: PiSavedAttachment[];
  records: PiSentRecord[];
  text: string | null;
};

/** A send awaiting pi's prompt-command acknowledgement. pi 0.3.0 accepts
 *  several follow-ups (rpc.rs MAX_RPC_PENDING_MESSAGES = 128) and echoes no
 *  id for our id-less commands, but answers them in stdin order, so the
 *  oldest entry is the correlation for the next response frame. */
export type PiPendingPrompt = {
  text: string;
  images: PiImageAttachment[];
  submissionId: string | null;
  records: PiSentRecord[];
};

/** Work created when an acknowledged user block binds a submission: the
 *  index append, then the draft record cleanup. */
type BindJob = {
  submissionId: string;
  turnId: string;
  sessionId: string | null;
  records: PiSentRecord[];
  text: string;
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
  pendingAttachments?: PendingSet[];
  /** Follow-ups sent while a turn was streaming, in send order. */
  queued?: PiQueued[];
  /** Sends whose prompt response has not landed yet, in send order; pi
   *  answers them in stdin order, so the head is the correlation. */
  pendingPrompts?: PiPendingPrompt[];
  rejectedDraft?: PiRejectedDraft | null;
  failedSubmission?: PiFailedSubmission | null;
  /** A failed attachment-index write, naming the path (design.md 3.4:
   *  a write error displays a message and the intended path). */
  bindError?: string | null;
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
    images?: ComposerImage[],
  ) => Promise<void>;
  /** Resends a failed submission under the same submission id: the staged
   *  copies are rewritten, the prompt is sent again, and only its own
   *  acknowledgement can bind the attachments to a turn. */
  retrySubmission: (tabId: number, submissionId: string) => Promise<void>;
  /** Drops a queued prompt that pi has not acknowledged yet and hands its
   *  text back to the composer. pi's own queue cannot be cancelled. */
  removeQueued: (tabId: number, id: string) => void;
  /** The one cancellation action behind Stop and composer Escape (design.md
   *  3.3): sends pi's rpc abort command, never kills the process, flips the
   *  strip to Cancelling at once and lets the abort response or the run's
   *  agent_end resolve it to idle. */
  cancelTurn: (tabId: number) => Promise<void>;
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

/** Session-wide counter minting submission ids for the K13 transaction. */
let submissionSeq = 0;

function attachmentError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftKeyOf(tabId: number): string {
  return stableIdOf(tabId) ?? String(tabId);
}

/** Rust stage reply for one attachment. */
type StagedReply = { attachmentId: string; path: string; sha256: string };

/** Records the transaction start on the draft file: the submission id and
 *  the queued attachments' state "draft". Fire-and-forget. */
function markDraftRecordPending(
  tabId: number,
  cwd: string | undefined,
  submissionId: string,
  records: PiSentRecord[],
): void {
  if (!cwd) return;
  const key = draftKeyOf(tabId);
  void loadDraftMeta(cwd, key)
    .then(async (meta) => {
      const base = meta ?? {
        v: 1 as const,
        submissionId: null,
        attachments: [],
        sources: [],
      };
      const ids = new Set(records.map((r) => r.attachmentId));
      await saveDraftMeta(cwd, key, {
        ...base,
        submissionId,
        attachments: base.attachments.map((a) =>
          ids.has(a.id) ? { ...a, state: "draft" } : a,
        ),
      });
    })
    .catch(() => {
      // The in-memory state stands; the record keeps its previous shape.
    });
}

/** Records the failed send on the draft file: state "failed", submission id
 *  kept. Fire-and-forget; the in-memory failedSubmission is the UI truth,
 *  the record is what a restart recovers. */
function markDraftRecordFailed(
  tabId: number,
  cwd: string | undefined,
  submissionId: string,
  records: PiSentRecord[],
): void {
  if (!cwd) return;
  const key = draftKeyOf(tabId);
  void loadDraftMeta(cwd, key)
    .then(async (meta) => {
      const base = meta ?? { v: 1 as const, submissionId: null, attachments: [], sources: [] };
      const failedIds = new Set(records.map((r) => r.attachmentId));
      const attachments = base.attachments.map((a) =>
        failedIds.has(a.id) ? { ...a, state: "failed" } : a,
      );
      await saveDraftMeta(cwd, key, {
        ...base,
        submissionId,
        attachments,
      });
    })
    .catch(() => {
      // The in-memory state stands; the record keeps its previous shape.
    });
}

/** Closes the draft record after a bound submission: the .json loses its
 *  attachments (the staged copies own them now), and the .md goes only when
 *  it still holds the sent text, so a draft typed meanwhile survives. */
async function closeDraftRecord(
  cwd: string,
  tabId: number,
  records: PiSentRecord[],
  text: string,
): Promise<void> {
  const key = draftKeyOf(tabId);
  for (const record of records) {
    if (!record.draftPath) continue;
    try {
      await invoke("fs_delete", {
        path: `${cwd.replace(/[\\/]+$/, "")}/${record.draftPath}`,
        workspace: currentWorkspaceEnv(),
      });
    } catch {
      // The draft file may already be gone; the staged copy is indexed.
    }
  }
  const draftText = await loadDraft(cwd, key);
  if (draftText !== null && draftText === text) {
    await clearDraft(cwd, key);
    return;
  }
  const meta = await loadDraftMeta(cwd, key);
  await saveDraftMeta(cwd, key, {
    v: 1,
    submissionId: null,
    attachments: [],
    sources: meta?.sources ?? [],
  });
}

/** Runs the bind job created by an acknowledged user block: append the
 *  index entries atomically, then close the draft record. A failed index
 *  write stands as a path-bearing bind error and keeps the record. */
async function runBindJob(tabId: number, job: BindJob): Promise<void> {
  const entry = usePiStore.getState().tabs[tabId];
  const cwd = entry?.cwd;
  if (!entry || !cwd) return;
  try {
    await invoke("pi_record_attachment_binding", {
      cwd,
      submissionId: job.submissionId,
      sessionId: job.sessionId ?? "",
      turnId: job.turnId,
      bindings: job.records.map((r) => ({
        attachmentId: r.attachmentId,
        path: r.stagedPath ?? "",
        sha256: r.sha256 ?? "",
      })),
      workspace: currentWorkspaceEnv(),
    });
  } catch (error) {
    const message = attachmentError(error);
    usePiStore.setState((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        bindError: `${message} (.pi/attachments/index.json)`,
      })),
    );
    return;
  }
  await closeDraftRecord(cwd, tabId, job.records, job.text).catch(() => {});
  usePiStore.setState((s) =>
    patchEntry(s.tabs, tabId, (e) =>
      e.bindError ? { ...e, bindError: null } : e,
    ),
  );
}

type PiEventPatch = Pick<
  PiTabEntry,
  "state"
  | "pendingAttachments"
  | "queued"
  | "pendingPrompts"
  | "rejectedDraft"
  | "failedSubmission"
> & { bind: BindJob | null };

/** Sniffs one event line for a prompt command response; null for anything
 *  else. The reducer ignores success frames, so the queue bookkeeping here
 *  reads both outcomes: success acknowledges the send (an idle start or an
 *  accepted follow-up, rpc.rs answers response_ok right after
 *  push_follow_up), failure refuses it. pi 0.3.0 echoes no id for our
 *  id-less commands but answers prompts in stdin order, so the oldest
 *  pendingPrompts entry is the correlation. */
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
  let pendingPrompts = entry.pendingPrompts ?? [];
  let rejectedDraft = entry.rejectedDraft ?? null;
  let failedSubmission = entry.failedSubmission ?? null;
  let bind: BindJob | null = null;

  const response = promptResponse(line);
  if (response && pendingPrompts.length > 0) {
    // pi answers prompts in stdin order: the oldest in-flight send owns this
    // response frame.
    const sentPrompt = pendingPrompts[0]!;
    pendingPrompts = pendingPrompts.slice(1);
    if (response.ok) {
      // Accepted: the oldest matching entry still unacked is now in pi's
      // queue and Remove is no longer offered for it.
      let acked = false;
      queued = queued.map((q) => {
        if (acked || q.acked || q.text !== sentPrompt.text) return q;
        acked = true;
        return { ...q, acked: true };
      });
      // A retried submission's ack clears the standing failure card; only
      // its acknowledged turn can own the attachments.
      if (
        failedSubmission &&
        sentPrompt.submissionId !== null &&
        failedSubmission.submissionId === sentPrompt.submissionId
      ) {
        failedSubmission = null;
      }
    } else {
      // Refused: pi put the "prompt rejected" card on the feed; hand the
      // text back to the composer instead of leaving it lost, and do not
      // keep a queued entry pi never accepted. The refused send's own
      // pending set (matched by submission id, text for the legacy path)
      // leaves the queue too: a failed submission never binds to a later
      // turn.
      const index = queued.findIndex(
        (q) => !q.acked && q.text === sentPrompt.text,
      );
      if (index !== -1) queued = queued.filter((_, i) => i !== index);
      const pendingIndex = pending.findIndex(
        (p) =>
          p.submissionId !== null
            ? p.submissionId === sentPrompt.submissionId
            : sentPrompt.submissionId === null && p.text === sentPrompt.text,
      );
      if (pendingIndex !== -1) {
        pending = pending.filter((_, i) => i !== pendingIndex);
      }
      if (
        failedSubmission &&
        sentPrompt.submissionId !== null &&
        failedSubmission.submissionId === sentPrompt.submissionId
      ) {
        failedSubmission = {
          ...failedSubmission,
          error: response.error,
          state: "failed",
        };
      } else if (sentPrompt.submissionId !== null) {
        failedSubmission = {
          submissionId: sentPrompt.submissionId,
          text: sentPrompt.text,
          images: sentPrompt.images,
          records: sentPrompt.records,
          error: response.error,
          state: "failed",
        };
      }
      rejectedDraft = {
        text: sentPrompt.text,
        images: sentPrompt.images,
        error: response.error,
        records: sentPrompt.records,
      };
    }
  }

  if (state.switching || state.blocks.length < previous.blocks.length) {
    // The session that held the follow-up queue is gone: queued prompts can
    // never run, so they must not read as pending. The composer restore and
    // the sends awaiting their acks are not tied to this session and stay.
    return {
      state,
      pendingAttachments: [],
      queued: [],
      pendingPrompts,
      rejectedDraft,
      failedSubmission,
      bind: null,
    };
  }

  if (pending.length === 0 && queued.length === 0) {
    return {
      state,
      pendingAttachments: pending,
      queued,
      pendingPrompts,
      rejectedDraft,
      failedSubmission,
      bind: null,
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
      pendingPrompts,
      rejectedDraft,
      failedSubmission,
      bind: null,
    };
  }

  if (pending.length > 0) {
    const head = pending[0]!;
    state = recordSavedAttachments(state, user.id, head.saved);
    pending = pending.slice(1);
    // pi's acknowledgement for the submission is this user block: append
    // the index entries and bind the chip to this turn (K13 transaction).
    if (head.submissionId !== null && head.records.length > 0) {
      bind = {
        submissionId: head.submissionId,
        turnId: user.id,
        sessionId: state.sessionId,
        records: head.records,
        text: head.text ?? "",
      };
      if (
        failedSubmission &&
        failedSubmission.submissionId === head.submissionId
      ) {
        failedSubmission = null;
      }
    }
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
    pendingPrompts,
    rejectedDraft,
    failedSubmission,
    bind,
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
      pendingPrompts: [],
      rejectedDraft: null,
      failedSubmission: null,
      bindError: null,
    };
    set((s) => ({ tabs: { ...s.tabs, [tabId]: entry } }));
    try {
      const session = await openPiSession({
        ...opts,
        launcherDir,
        // F7b: the global Settings piAgentBin rides to the launch resolver
        // (the project override wins Rust-side); empty leaves it unset.
        agentBin: resolved.agentBin,
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
        onEvent: (line) => {
          // The holder object survives the closure: TypeScript cannot track
          // the assignment through set(), and a bind job must run after the
          // reduction published it.
          const job: { bind: BindJob | null } = { bind: null };
          set((s) =>
            patchEntry(s.tabs, tabId, (e) => {
              const next = applyPiEvent(e, line);
              job.bind = next.bind;
              return { ...e, ...next };
            }),
          );
          if (job.bind) void runBindJob(tabId, job.bind);
        },
        onExit: (code) =>
          set((s) =>
            patchEntry(s.tabs, tabId, (e) =>
              // A late exit from a superseded open must not mark the entry
              // that replaced this session.
              e.gen !== gen
                ? e
                : {
                    ...e,
                    session: null,
                    exited: true,
                    exitCode: code,
                    // Whatever the status said, the process is gone: never a
                    // stale thinking or Cancelling (UX-08).
                    state: sessionExited(e.state),
                  },
            ),
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
    const attachments: ComposerImage[] = images ?? [];
    // A Stop is winding the run down. pi would accept the follow-up but
    // never executes input queued behind an aborted turn (rpc.rs preserves
    // it unexecuted), so refusing here is the honest acknowledgement: the
    // text returns to the composer with the reason, the click is never
    // silently swallowed.
    if (entry.state.status === "cancelling") {
      const message = "cancellation in progress; send again once the strip is idle";
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          rejectedDraft: { text, images: attachments, error: message },
        })),
      );
      throw new Error(message);
    }
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

    // K13 transaction: chips that carry a draft file run as one submission.
    // The draft files are copied to .pi/attachments/<submission-id>-<...>
    // before the prompt is sent; on pi's acknowledgement (the user message
    // block for this text) the index entries are appended atomically and
    // the chips bind to that turn. Any failure before the acknowledgement
    // marks the draft record "failed" and offers the retry control.
    const draftBacked =
      attachments.length > 0 &&
      attachments.every(
        (a) => typeof a.attachmentId === "string" && a.attachmentId.length > 0,
      );
    if (draftBacked) {
      const submissionId = `sub-${(submissionSeq += 1)}`;
      const records: PiSentRecord[] = attachments.map((a) => ({
        attachmentId: a.attachmentId!,
        draftPath: a.draftPath ?? null,
        stagedPath: null,
        sha256: a.sha256 ?? null,
      }));
      const failTransaction = (message: string) => {
        set((s) =>
          patchEntry(s.tabs, tabId, (e) => ({
            ...e,
            queued: queuedId
              ? (e.queued ?? []).filter((q) => q.id !== queuedId)
              : e.queued,
            failedSubmission: {
              submissionId,
              text,
              images: attachments,
              records,
              error: message,
              state: "failed",
            },
            // The write failed before pi accepted the text: give it back
            // to the composer instead of dropping it on the floor.
            rejectedDraft: {
              text,
              images: attachments,
              error: message,
              records,
            },
          })),
        );
        markDraftRecordFailed(tabId, entry.cwd, submissionId, records);
      };

      let staged: StagedReply[] | null = null;
      try {
        staged = await invoke<StagedReply[]>("pi_stage_submission", {
          cwd: entry.cwd ?? "",
          submissionId,
          attachments: records.map((r) => ({
            attachmentId: r.attachmentId,
            path: r.draftPath ?? "",
          })),
          workspace: currentWorkspaceEnv(),
        });
      } catch (error) {
        const message = attachmentError(error);
        failTransaction(message);
        throw new Error(message);
      }
      for (const record of records) {
        const hit = staged.find((s) => s.attachmentId === record.attachmentId);
        record.stagedPath = hit?.path ?? null;
        record.sha256 = hit?.sha256 ?? record.sha256;
      }
      const unstaged = records.find((r) => r.stagedPath === null);
      if (unstaged) {
        const message = `attachment copy failed: ${unstaged.draftPath ?? unstaged.attachmentId}`;
        failTransaction(message);
        throw new Error(message);
      }
      if (get().tabs[tabId]?.session !== session) return;

      const pendingSet: PendingSet = {
        submissionId,
        saved: records.map((r) => ({ path: r.stagedPath, error: null })),
        records,
        text,
      };
      // The queue entry lands before the send so pi's ack, which can only
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
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          pendingAttachments: [...(e.pendingAttachments ?? []), pendingSet],
          pendingPrompts: [
            ...(e.pendingPrompts ?? []),
            { text, images: attachments, submissionId, records },
          ],
        })),
      );
      markDraftRecordPending(tabId, entry.cwd, submissionId, records);
      try {
        await session.send(promptLine(text, images, behavior));
      } catch (error) {
        set((s) =>
          patchEntry(s.tabs, tabId, (e) => {
            const pending = e.pendingAttachments ?? [];
            const index = pending.indexOf(pendingSet);
            return {
              ...e,
              pendingAttachments:
                index === -1
                  ? pending
                  : [
                      ...pending.slice(0, index),
                      ...pending.slice(index + 1),
                    ],
              queued: queuedId
                ? (e.queued ?? []).filter((q) => q.id !== queuedId)
                : e.queued,
              failedSubmission: {
                submissionId,
                text,
                images: attachments,
                records,
                error: attachmentError(error),
                state: "failed",
              },
              rejectedDraft: {
                text,
                images: attachments,
                error: attachmentError(error),
                records,
              },
            };
          }),
        );
        markDraftRecordFailed(tabId, entry.cwd, submissionId, records);
        throw error;
      }
      return;
    }

    // Legacy single-shot path: images without draft files (callers that
    // bypass the composer) still land as project copies before the send.
    const saved: PiSavedAttachment[] = [];
    const pendingSet: PendingSet = { submissionId: null, saved, records: [], text };
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
          pendingAttachments: [...(e.pendingAttachments ?? []), pendingSet],
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
    // holds every send in flight until its ack or rejection arrives, in send
    // order.
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        pendingPrompts: [
          ...(e.pendingPrompts ?? []),
          { text, images: attachments, submissionId: null, records: [] },
        ],
      })),
    );
    try {
      await session.send(promptLine(text, images, behavior));
    } catch (error) {
      if (saved.length > 0) {
        set((s) =>
          patchEntry(s.tabs, tabId, (e) => {
            const pending = e.pendingAttachments ?? [];
            const index = pending.indexOf(pendingSet);
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

  retrySubmission: async (tabId, submissionId) => {
    const entry = get().tabs[tabId];
    const session = entry?.session;
    const failed = entry?.failedSubmission;
    if (
      !session ||
      !entry ||
      !failed ||
      failed.state === "retrying" ||
      failed.submissionId !== submissionId
    ) {
      return;
    }
    set((s) =>
      patchEntry(s.tabs, tabId, (e) =>
        e.failedSubmission?.submissionId === submissionId
          ? {
              ...e,
              failedSubmission: { ...e.failedSubmission!, state: "retrying" },
            }
          : e,
      ),
    );
    const status = entry.state.status;
    const busy = status !== "idle" && status !== "awaiting-ask";
    const behavior: PiStreamingBehavior | undefined = busy
      ? "follow-up"
      : undefined;
    const failRetry = (message: string) => {
      set((s) =>
        patchEntry(s.tabs, tabId, (e) =>
          e.failedSubmission?.submissionId === submissionId
            ? {
                ...e,
                failedSubmission: {
                  ...e.failedSubmission!,
                  state: "failed",
                  error: message,
                },
              }
            : e,
        ),
      );
    };
    try {
      const staged = await invoke<StagedReply[]>("pi_stage_submission", {
        cwd: entry.cwd ?? "",
        submissionId,
        attachments: failed.records.map((r) => ({
          attachmentId: r.attachmentId,
          path: r.draftPath ?? "",
        })),
        workspace: currentWorkspaceEnv(),
      });
      const records: PiSentRecord[] = failed.records.map((r) => {
        const hit = staged.find((s) => s.attachmentId === r.attachmentId);
        return { ...r, stagedPath: hit?.path ?? null, sha256: hit?.sha256 ?? r.sha256 };
      });
      const unstaged = records.find((r) => r.stagedPath === null);
      if (unstaged) {
        failRetry(
          `attachment copy failed: ${unstaged.draftPath ?? unstaged.attachmentId}`,
        );
        return;
      }
      if (get().tabs[tabId]?.session !== session) return;
      const pendingSet: PendingSet = {
        submissionId,
        saved: records.map((r) => ({ path: r.stagedPath, error: null })),
        records,
        text: failed.text,
      };
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          pendingAttachments: [...(e.pendingAttachments ?? []), pendingSet],
          pendingPrompts: [
            ...(e.pendingPrompts ?? []),
            {
              text: failed.text,
              images: failed.images,
              submissionId,
              records,
            },
          ],
        })),
      );
      try {
        await session.send(promptLine(failed.text, failed.images, behavior));
      } catch (error) {
        set((s) =>
          patchEntry(s.tabs, tabId, (e) => {
            if (e.failedSubmission?.submissionId !== submissionId) return e;
            const pending = e.pendingAttachments ?? [];
            const index = pending.indexOf(pendingSet);
            return {
              ...e,
              pendingAttachments:
                index === -1
                  ? pending
                  : [...pending.slice(0, index), ...pending.slice(index + 1)],
              failedSubmission: {
                ...e.failedSubmission,
                state: "failed",
                error: attachmentError(error),
              },
            };
          }),
        );
      }
    } catch (error) {
      // Staging failed before anything was queued: the failure stands.
      failRetry(attachmentError(error));
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

  cancelTurn: async (tabId) => {
    const entry = get().tabs[tabId];
    const session = entry?.session;
    if (!session || entry.exited || !turnInFlight(entry.state.status)) {
      return;
    }
    // Acknowledge at once: the strip shows Cancelling and Stop disables
    // before the wire round-trip. requestCancel is idempotent, so a second
    // click during the wind-down is a no-op.
    const retryPending = entry.state.retry !== null;
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({ ...e, state: requestCancel(e.state) })),
    );
    try {
      // pi's rpc abort stops the run in flight and always answers
      // response_ok (rpc.rs "abort"); the process lives on. A pending
      // auto-retry also gets abort_retry so the backoff window cannot
      // restart the turn after the cancel.
      await (session.abort ? session.abort() : session.send(abortLine()));
      if (retryPending) await session.send(abortRetryLine());
    } catch (error) {
      // The abort write failed (the process is likely gone; the exit event
      // resolves the status). Surface it: a clicked Stop is never silent.
      set((s) =>
        patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          error:
            e.error ??
            (error instanceof Error ? error.message : String(error)),
        })),
      );
    }
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
