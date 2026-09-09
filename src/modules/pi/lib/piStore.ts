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
} from "./parse";
import {
  modelRowsForProvider,
  parsePiModels,
  piSpawnEnv,
  resolvePiPrefs,
  type PiModelRow,
  type PiRuntimePrefs,
} from "./providers";
import { loadLastSession, restoredUsageTotals, type ParsedSessionFile } from "./sessionFile";
import { openPiSession, type PiSessionHandle } from "./rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./settingsSchema";
import { groupTurns } from "./turns";
import { loadDraft, loadDraftRecord, saveDraft, updateDraftMeta, draftMetaPath, type DraftQueuedPrompt } from "@/modules/pi/lib/drafts";
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
  recoverLast?: boolean;
  cwd?: string;
  launcherDir?: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Resolved model roles for the session; ChatPane reads this for its
 *  data-pi-model / data-pi-smol root attributes. */
export type PiRoles = { provider: string; model: string; smol: string };

export type PiQueued = DraftQueuedPrompt & {
  images: ComposerImage[];
  state: "queued" | "not-sent" | "sending";
  autoSend?: boolean;
};

/** A refused send restores into the empty editor; queue Edit appends once. */
export type PiRejectedDraft = {
  text: string;
  images: PiImageAttachment[];
  /** The rejection reason; null when the return was user-initiated. */
  error: string | null;
  /** K13: the failed submission's attachment records, adopted by the
   *  composer's restored chips so ids and draft files survive the refusal. */
  records?: PiSentRecord[];
  queueReturn?: boolean;
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
  queueId?: string;
};

/** Unanswered prompt commands, correlated in stdin order for pi 0.3.0. */
export type PiPendingPrompt = {
  id?: string;
  queueId?: string;
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

/** A session switch staged for an atomic commit (F1b): the target file has
 *  already been read and parsed, so the switch command goes out only when
 *  the restored transcript is in hand and the reset can swap it in the
 *  moment pi acknowledges. */
export type PendingSwitch = ParsedSessionFile & {
  /** Absolute path of the session file, for the strip identity and errors. */
  path: string;
  /** The hit's snippet, scrolled to once the transcript has swapped in. */
  snippet: string;
};

/** One pending scroll-to-turn after a committed switch; `seq` pairs the
 *  consume acknowledgement so an older request is never cleared by mistake. */
export type ScrollRequest = { seq: number; snippet: string };

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
  /** Durable prompts waiting for a successful turn or an explicit Retry. */
  queued?: PiQueued[];
  queueError?: string | null;
  queueBusy?: string | null;
  queueEpoch?: number;
  /** Sends whose prompt response has not landed yet, in send order; pi
   *  answers them in stdin order, so the head is the correlation. */
  pendingPrompts?: PiPendingPrompt[];
  rejectedDraft?: PiRejectedDraft | null;
  failedSubmission?: PiFailedSubmission | null;
  /** A failed attachment-index write, naming the path (design.md 3.4:
   *  a write error displays a message and the intended path). */
  bindError?: string | null;
  /** A staged switch waiting for pi's switch_session acknowledgement. */
  pendingSwitch?: PendingSwitch | null;
  /** A failed or refused switch, naming the session file; the previous
   *  conversation stays untouched (design.md 3.5: an error names its path). */
  switchError?: string | null;
  locatorPending?: boolean;
  recovering?: boolean;
  /** The session file pi has loaded, known once a switch committed. */
  sessionPath?: string | null;
  /** A turn to scroll to after the restored transcript has rendered. */
  scrollRequest?: ScrollRequest | null;
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
  retryQueued: (tabId: number, id: string) => Promise<void>;
  editQueued: (tabId: number, id: string) => Promise<void>;
  cancelQueued: (tabId: number, id: string) => Promise<void>;
  discardQueued: (tabId: number) => Promise<void>;
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
  /** Switches the tab's pi session to an already-parsed session file (F1b):
   *  stages the parsed transcript, sends switch_session, and lets the ack
   *  swap it in atomically. The current transcript stays until the commit;
   *  a refused send stages nothing and reports the file. One switch at a
   *  time per tab: a second call while one is in flight throws. */
  switchToSession: (
    tabId: number,
    request: PendingSwitch,
  ) => Promise<void>;
  /** Consumes a committed switch's scroll request once the transcript has
   *  rendered and the turn has been scrolled to. */
  clearScrollRequest: (tabId: number, seq: number) => void;
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

/** Session-wide counter pairing scroll requests with their consumers. */
let scrollSeq = 0;

function attachmentError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftKeyOf(tabId: number): string {
  return stableIdOf(tabId) ?? String(tabId);
}

/** Rust stage reply for one attachment. */
type StagedReply = { attachmentId: string; path: string; sha256: string };

function markDraftRecordPending(tabId: number, cwd: string | undefined, submissionId: string, records: PiSentRecord[]): void {
  markDraftAttachments(tabId, cwd, submissionId, records, "draft");
}

function markDraftRecordFailed(tabId: number, cwd: string | undefined, submissionId: string, records: PiSentRecord[]): void {
  markDraftAttachments(tabId, cwd, submissionId, records, "failed");
}

function markDraftAttachments(
  tabId: number, cwd: string | undefined, submissionId: string, records: PiSentRecord[], state: string,
): void {
  if (!cwd) return;
  const ids = new Set(records.map((r) => r.attachmentId));
  void updateDraftMeta(cwd, draftKeyOf(tabId), (meta) => ({
    ...meta,
    submissionId,
    attachments: meta.attachments.map((a) => ids.has(a.id) ? { ...a, state } : a),
  })).catch((error) => queueFailure(tabId, error));
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
  await updateDraftMeta(cwd, key, async (meta) => {
    const boundIds = new Set(records.map((r) => r.attachmentId));
    const queuedIds = new Set(meta.queue?.flatMap((q) => q.attachmentIds));
    for (const record of records) {
      if (!record.draftPath || queuedIds.has(record.attachmentId)) continue;
      try {
        await invoke("fs_delete", {
          path: `${cwd.replace(/[\\/]+$/, "")}/${record.draftPath}`,
          workspace: currentWorkspaceEnv(),
        });
      } catch { /* The staged copy is already indexed. */ }
    }
    return { ...meta, submissionId: null, attachments: meta.attachments.filter((a) => !boundIds.has(a.id) || queuedIds.has(a.id)) };
  });
  const draftText = await loadDraft(cwd, key);
  if (draftText !== null && draftText === text) await saveDraft(cwd, key, "");
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
  | "pendingSwitch"
  | "switchError"
  | "sessionPath"
  | "scrollRequest"
> & { bind: BindJob | null };

/** Sniffs one event line for a switch_session response; null for anything
 *  else. pi 0.3.0 answers the switch with response_ok
 *  {data:{cancelled:false}} and no session id (rpc.rs "switch_session"); an
 *  extension veto answers {cancelled:true}, a refused switch success:false. */
function switchAck(line: string): {
  ok: boolean;
  cancelled: boolean;
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
    (event as { command?: unknown }).command !== "switch_session"
  ) {
    return null;
  }
  const record = event as { success?: unknown; error?: unknown; data?: unknown };
  const cancelled =
    isRecord(record.data) && record.data.cancelled === true;
  return {
    ok: record.success !== false && !cancelled,
    cancelled,
    error: typeof record.error === "string" ? record.error : null,
  };
}

/** Is `record` a plain object? Local twin of parse.ts's guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

/** Switch bookkeeping that branches below do not touch: a staged switch
 *  stays staged until its ack arrives, and a standing switch error or the
 *  committed session path survive unrelated events. */
function switchPassthrough(
  entry: PiTabEntry,
): Pick<PiTabEntry, "pendingSwitch" | "switchError" | "sessionPath" | "scrollRequest"> {
  return {
    pendingSwitch: entry.pendingSwitch ?? null,
    switchError: entry.switchError ?? null,
    sessionPath: entry.sessionPath ?? null,
    scrollRequest: entry.scrollRequest ?? null,
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

  // The staged switch resolves on pi's switch_session ack (F1b). With the
  // parsed transcript already staged, the commit is one atomic swap: the
  // reset the reducer applies on the ack lands with the restored history
  // already in it, so the chat never shows an empty transcript. A refused
  // or vetoed switch keeps the previous conversation and names the file.
  const ack = switchAck(line);
  const staged = entry.pendingSwitch ?? null;
  if (ack && staged) {
    if (!ack.ok) {
      return {
        state: previous,
        pendingAttachments: pending,
        queued,
        pendingPrompts,
        rejectedDraft,
        failedSubmission,
        pendingSwitch: null,
        switchError: `${staged.path}: ${ack.error ?? (ack.cancelled ? "switch cancelled" : "switch refused")}`,
        sessionPath: entry.sessionPath ?? null,
        scrollRequest: entry.scrollRequest ?? null,
        bind: null,
      };
    }
    const totals = restoredUsageTotals(staged.blocks);
    return {
      state: {
        ...state,
        // applyEvent reset to a fresh session on the ack; swap the parsed
        // history in as the new session's transcript and adopt its id.
        switching: false,
        sessionId: staged.sessionId,
        blocks: staged.blocks,
        turnTokens: totals.turnTokens,
        sessionCost: totals.sessionCost,
        turnUsage: totals.turnUsage,
      },
      pendingAttachments: [],
      queued: queued.map((q) => ({ ...q, state: "not-sent", autoSend: false })),
      pendingPrompts: [],
      rejectedDraft,
      failedSubmission,
      pendingSwitch: null,
      switchError: null,
      sessionPath: staged.path,
      scrollRequest: { seq: (scrollSeq += 1), snippet: staged.snippet },
      bind: null,
    };
  }
  if (ack && !staged) {
    // An ack with nothing staged (a late duplicate) must not clear the
    // conversation: keep the state as it was before this line.
    state = previous;
  }

  const response = promptResponse(line);
  if (response && pendingPrompts.length > 0) {
    // pi answers prompts in stdin order: the oldest in-flight send owns this
    // response frame.
    const sentPrompt = pendingPrompts[0]!;
    pendingPrompts = pendingPrompts.slice(1);
    if (response.ok) {
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
      state = { ...state, status: "idle" };
      // A refused queue Retry keeps its durable record. Only this send's
      // attachments leave the binding FIFO.
      if (sentPrompt.queueId) queued = queued.map((q) => q.id === sentPrompt.queueId ? { ...q, state: "not-sent" } : q);
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
      } else if (sentPrompt.submissionId !== null && !sentPrompt.queueId) {
        failedSubmission = {
          submissionId: sentPrompt.submissionId,
          text: sentPrompt.text,
          images: sentPrompt.images,
          records: sentPrompt.records,
          error: response.error,
          state: "failed",
        };
      }
      if (!sentPrompt.queueId) rejectedDraft = {
        text: sentPrompt.text,
        images: sentPrompt.images,
        error: response.error,
        records: sentPrompt.records,
      };
    }
  }

  if (state.switching || state.blocks.length < previous.blocks.length) {
    // Queued work belongs to the tab and requires an explicit Retry after a switch.
    return {
      state,
      pendingAttachments: [],
      queued: queued.map((q) => ({ ...q, state: "not-sent", autoSend: false })),
      pendingPrompts: [],
      rejectedDraft,
      failedSubmission,
      ...switchPassthrough(entry),
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
      ...switchPassthrough(entry),
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
      ...switchPassthrough(entry),
      bind: null,
    };
  }

  if (pending.length > 0) {
    const head = pending[0]!;
    if (head.queueId) queued = queued.filter((q) => q.id !== head.queueId);
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
  return {
    state,
    pendingAttachments: pending,
    queued,
    pendingPrompts,
    rejectedDraft,
    failedSubmission,
    ...switchPassthrough(entry),
    bind,
  };
}

function queueFailure(tabId: number, error: unknown): void {
  usePiStore.setState((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, queueError: attachmentError(error) })));
}

async function recoverQueue(cwd: string, key: string): Promise<PiQueued[]> {
  const record = await loadDraftRecord(cwd, key);
  if (!record || record.kind !== "chat") return [];
  return Promise.all((record.meta.queue ?? []).map(async (q) => ({
    ...q,
    state: "not-sent" as const,
    images: await Promise.all(q.attachmentIds.map(async (id): Promise<ComposerImage> => {
      const att = record.meta.attachments.find((a) => a.id === id)!;
      let data = "";
      try {
        const bytes = await invoke<{ base64: string }>("fs_read_file_bytes", {
          path: `${cwd.replace(/[\\/]+$/, "")}/${att.path}`, workspace: currentWorkspaceEnv(),
        });
        data = bytes.base64;
      } catch { /* Keep missing chips available to Edit. */ }
      return { attachmentId: id, draftPath: att.path, sha256: att.sha256, mediaType: att.mime, data };
    })),
  })));
}

const queueWrites = new Map<number, Promise<void>>();

function enqueuePrompt(tabId: number, text: string, images: ComposerImage[]): Promise<void> {
  const entry = usePiStore.getState().tabs[tabId]!;
  const previous = queueWrites.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => persistQueuedPrompt(tabId, entry, text, images));
  queueWrites.set(tabId, next);
  void next.finally(() => { if (queueWrites.get(tabId) === next) queueWrites.delete(tabId); }).catch(() => {});
  return next;
}

async function persistQueuedPrompt(tabId: number, entry: PiTabEntry, text: string, images: ComposerImage[]): Promise<void> {
  if (!entry.cwd) throw new Error("Open a project to save queued prompts (.pi/drafts)");
  const key = draftKeyOf(tabId);
  const id = `queued-${crypto.randomUUID()}`;
  try {
    const backed: ComposerImage[] = [];
    for (const image of images) {
      const attachmentId = image.attachmentId ?? `att-${crypto.randomUUID()}`;
      const saved = image.draftPath && image.sha256 ? { path: image.draftPath, sha256: image.sha256 }
        : await invoke<{ path: string; sha256: string }>("pi_save_draft_attachment", {
            cwd: entry.cwd, tabId: key, attachmentId, mediaType: image.mediaType, data: image.data, workspace: currentWorkspaceEnv(),
          });
      backed.push({ ...image, attachmentId, draftPath: saved.path, sha256: saved.sha256 });
    }
    const queued: PiQueued = { id, text, images: backed, attachmentIds: backed.map((a) => a.attachmentId!),
      submittedAt: new Date().toISOString(), state: "queued", autoSend: true };
    await updateDraftMeta(entry.cwd, key, (meta) => ({ ...meta,
      queue: [...(meta.queue ?? []), { id, text, attachmentIds: queued.attachmentIds, submittedAt: queued.submittedAt }],
      attachments: [...meta.attachments.filter((a) => !queued.attachmentIds.includes(a.id)), ...backed.map((a) => ({
        ...meta.attachments.find((saved) => saved.id === a.attachmentId),
        id: a.attachmentId!, path: a.draftPath!, sha256: a.sha256!, mime: a.mediaType, state: "queued",
      }))],
    }));
    usePiStore.setState((s) => patchEntry(s.tabs, tabId, (e) => {
      if (e.cwd !== entry.cwd) return e;
      const interrupted = e.gen !== entry.gen || e.exited || e.state.cancelRequested ||
        (e.queueEpoch ?? 0) !== (entry.queueEpoch ?? 0);
      const state = interrupted || e.state.status === "error" || e.state.status === "idle" || e.state.status === "cancelling"
        ? "not-sent" : "queued";
      return { ...e, queueError: null, queued: [
        ...(e.queued ?? []).filter((q) => q.id !== id), { ...queued, state, autoSend: !interrupted },
      ] };
    }));
    if (usePiStore.getState().tabs[tabId]?.state.status === "done") void drainQueue(tabId);
  } catch (error) {
    const message = `${draftMetaPath(entry.cwd, key)}: ${attachmentError(error)}`;
    queueFailure(tabId, message);
    throw new Error(message);
  }
}

async function removeQueueRecords(cwd: string, key: string, ids: string[], edit = false): Promise<void> {
  await updateDraftMeta(cwd, key, (meta) => {
    const removed = new Set((meta.queue ?? []).filter((q) => ids.includes(q.id)).flatMap((q) => q.attachmentIds));
    const queue = (meta.queue ?? []).filter((q) => !ids.includes(q.id));
    const retained = new Set(queue.flatMap((q) => q.attachmentIds));
    return { ...meta, queue, attachments: meta.attachments.flatMap((a) =>
      !removed.has(a.id) || retained.has(a.id) ? [a] : edit ? [{ ...a, state: "draft" }] : []) };
  });
}

async function changeQueue(tabId: number, id: string | null, edit: boolean): Promise<void> {
  const entry = usePiStore.getState().tabs[tabId];
  if (!entry || entry.queueBusy) return;
  const items = (entry.queued ?? []).filter((q) => id === null || q.id === id);
  if (!items.length || items.some((q) => q.state === "sending")) return;
  if (edit && entry.rejectedDraft) throw new Error("Return the pending draft to the composer first");
  usePiStore.setState((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, queueBusy: id ?? "discard" })));
  try {
    if (!entry.cwd) throw new Error("Open a project to update queued prompts (.pi/drafts)");
    const key = draftKeyOf(tabId);
    if (edit) {
      const existing = await loadDraft(entry.cwd, key);
      await saveDraft(entry.cwd, key, [existing, items[0].text].filter(Boolean).join("\n\n"));
    }
    await removeQueueRecords(entry.cwd, key, items.map((q) => q.id), edit);
    usePiStore.setState((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, queueError: null,
      queued: e.queued?.filter((q) => !items.some((item) => item.id === q.id)),
      ...(edit && { rejectedDraft: { text: items[0].text, images: items[0].images, error: null, queueReturn: true,
        records: items[0].images.map((a) => ({ attachmentId: a.attachmentId!, draftPath: a.draftPath ?? null, stagedPath: null, sha256: a.sha256 ?? null })) } }),
    })));
  } catch (error) {
    queueFailure(tabId, error);
    throw error;
  } finally {
    usePiStore.setState((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, queueBusy: null })));
  }
}

async function drainQueue(tabId: number): Promise<void> {
  const entry = usePiStore.getState().tabs[tabId];
  if (!entry || entry.state.status !== "done" || entry.queueBusy || entry.exited) return;
  const next = entry.queued?.find((q) => q.state !== "sending" && q.autoSend);
  if (next) await usePiStore.getState().retryQueued(tabId, next.id).catch((error) => queueFailure(tabId, error));
}

async function sendNow(tabId: number, text: string, images: ComposerImage[], queueId?: string): Promise<void> {
  const get = usePiStore.getState;
  const set = usePiStore.setState;
  const entry = get().tabs[tabId];
  const session = entry?.session;
  if (!session || entry.exited) throw new Error("Session exited");
  const missing = images.find((a) => !a.data);
  if (missing) throw new Error(`Attachment file is missing: ${missing.draftPath ?? missing.attachmentId}`);
  const id = `prompt-${crypto.randomUUID()}`;
  const draftBacked = images.length > 0 && images.every((a) => !!a.attachmentId);
  const submissionId = draftBacked ? `sub-${crypto.randomUUID()}` : null;
  const records: PiSentRecord[] = draftBacked ? images.map((a) => ({ attachmentId: a.attachmentId!,
    draftPath: a.draftPath ?? null, stagedPath: null, sha256: a.sha256 ?? null })) : [];
  const pendingSet: PendingSet = { submissionId, saved: [], records, text, queueId };
  set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, state: { ...e.state, status: "thinking" },
    queued: e.queued?.map((q) => q.id === queueId ? { ...q, state: "sending" } : queueId ? q : { ...q, autoSend: false }), queueError: null,
  })));
  try {
    if (draftBacked) {
      const staged = await invoke<StagedReply[]>("pi_stage_submission", { cwd: entry.cwd ?? "", submissionId,
        attachments: records.map((r) => ({ attachmentId: r.attachmentId, path: r.draftPath ?? "" })), workspace: currentWorkspaceEnv() });
      for (const record of records) {
        const hit = staged.find((s) => s.attachmentId === record.attachmentId);
        if (!hit?.path) throw new Error(`attachment copy failed: ${record.draftPath ?? record.attachmentId}`);
        record.stagedPath = hit.path;
        record.sha256 = hit.sha256;
        pendingSet.saved.push({ path: hit.path, error: null });
      }
      markDraftRecordPending(tabId, entry.cwd, submissionId!, records);
    } else {
      const turn = groupTurns(messageBlocks(entry.state.blocks)).length;
      for (const [n, image] of images.entries()) {
        try {
          const path = await invoke<string>("pi_save_attachment", { cwd: entry.cwd ?? "", turn, n,
            mediaType: image.mediaType, data: image.data, workspace: currentWorkspaceEnv() });
          if (!path) throw new Error("attachment writer returned no path");
          pendingSet.saved.push({ path, error: null });
        } catch (error) { pendingSet.saved.push({ path: null, error: attachmentError(error) }); }
      }
    }
    if (get().tabs[tabId]?.session !== session) throw new Error("Session exited before the prompt was sent");
    set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e,
      pendingAttachments: [...(e.pendingAttachments ?? []), pendingSet],
      pendingPrompts: [...(e.pendingPrompts ?? []), { id, queueId, text, images, submissionId, records }],
    })));
    await session.send(promptLine(text, images));
    const rejected = get().tabs[tabId]?.rejectedDraft;
    if (!queueId && rejected?.images === images) throw new Error(rejected.error ?? "Prompt rejected");
  } catch (error) {
    const message = attachmentError(error);
    set((s) => patchEntry(s.tabs, tabId, (e) => e.gen !== entry.gen ? e : ({ ...e,
      state: { ...e.state, status: "idle" },
      pendingAttachments: e.pendingAttachments?.filter((p) => p !== pendingSet),
      pendingPrompts: e.pendingPrompts?.filter((p) => p.id !== id),
      queued: e.queued?.map((q) => ({ ...q, state: "not-sent", autoSend: false })),
      queueEpoch: (e.queueEpoch ?? 0) + 1,
      ...(queueId ? { queueError: `${message} (.pi/logs/session.jsonl)` } : {
        rejectedDraft: { text, images, error: message, ...(records.length && { records }) },
        ...(submissionId && { failedSubmission: { submissionId, text, images, records, error: message, state: "failed" as const } }),
      }),
    })));
    if (submissionId) markDraftRecordFailed(tabId, entry.cwd, submissionId, records);
    throw error;
  }
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
      pendingSwitch: null,
      switchError: null,
      sessionPath: null,
      recovering: true,
      scrollRequest: null,
    };
    set((s) => ({ tabs: { ...s.tabs, [tabId]: entry } }));
    try {
      if (opts.cwd) {
        try {
          const queued = await recoverQueue(opts.cwd, draftKeyOf(tabId));
          set((s) => patchEntry(s.tabs, tabId, (e) => e.gen === gen ? { ...e, queued } : e));
        } catch (error) {
          set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, queueError: String(error) })));
        }
      }
      const recovered = opts.cwd && opts.recoverLast !== false ? await loadLastSession(opts.cwd) : null;
      if (get().tabs[tabId]?.gen !== gen) return;
      if (recovered) {
        set((s) => patchEntry(s.tabs, tabId, (e) => ({
          ...e,
          sessionPath: recovered.path,
          state: { ...initialPiSessionState(), sessionId: recovered.sessionId, blocks: recovered.blocks, ...restoredUsageTotals(recovered.blocks) },
        })));
      }
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
          if (get().tabs[tabId]?.gen !== gen) return;
          const before = get().tabs[tabId]!;
          const ack = switchAck(line);
          const committed = ack?.ok ? before.pendingSwitch : null;
          const recoveryRefused = before.recovering && ack && !ack.ok;
          if (recoveryRefused) void before.session?.kill();
          const job: { bind: BindJob | null; removed: string[]; drain: boolean } = { bind: null, removed: [], drain: false };
          set((s) =>
            patchEntry(s.tabs, tabId, (e) => {
              if (e.gen !== gen) return e;
              const next = applyPiEvent(e, line);
              job.bind = next.bind;
              let queueEpoch = e.queueEpoch ?? 0;
              job.removed = (e.queued ?? []).filter((q) => !(next.queued ?? []).some((n) => n.id === q.id)).map((q) => q.id);
              if (next.state.status === "error" || next.state.cancelRequested || next.state.switching) {
                next.queued = next.queued?.map((q) => ({ ...q, state: "not-sent" }));
              }
              const newest = next.state.blocks[next.state.blocks.length - 1];
              if (newest !== e.state.blocks[e.state.blocks.length - 1] && newest?.kind === "retry" && newest.phase === "end" && newest.success === false) {
                next.queued = next.queued?.map((q) => ({ ...q, autoSend: false }));
                queueEpoch += 1;
              }
              if (next.queued?.length && e.state.status !== "done" && next.state.status === "done" && !e.state.cancelRequested) {
                const currentUser = next.state.blocks.map((b) => b.kind === "message" && b.role === "user").lastIndexOf(true);
                const empty = next.state.blocks.slice(Math.max(0, currentUser)).some((b) => b.kind === "error" && b.text === "empty completion: no usage reported");
                job.drain = !empty;
                if (empty) {
                  next.queued = next.queued.map((q) => ({ ...q, state: "not-sent", autoSend: false }));
                  queueEpoch += 1;
                }
              }
              return {
                ...e, ...next, queueEpoch,
                ...(committed ? { locatorPending: true } : ack ? { recovering: false } : {}),
                ...(recoveryRefused ? { session: null, error: `Session recovery failed: ${next.switchError}` } : {}),
                ...(e.recovering && recovered && !ack ? { state: e.state } : {}),
              };
            }),
          );
          if (job.removed.length && opts.cwd) {
            void removeQueueRecords(opts.cwd, draftKeyOf(tabId), job.removed).catch((error) => queueFailure(tabId, error));
          }
          if (committed) {
            void invoke("pi_record_session_switch", {
              cwd: before.cwd, sessionId: committed.sessionId, path: committed.path,
              workspace: currentWorkspaceEnv(),
            }).then(() => {
              set((s) => patchEntry(s.tabs, tabId, (e) => e.gen !== gen ? e : ({ ...e, locatorPending: false, recovering: false })));
            }).catch((error: unknown) => {
              set((s) => patchEntry(s.tabs, tabId, (e) => e.gen !== gen ? e : ({
                ...e, locatorPending: false, recovering: false,
                switchError: `${committed.path}: could not record ${before.cwd}/.pi/session-manifest.json: ${attachmentError(error)}`,
              })));
            });
          }
          if (job.bind) void runBindJob(tabId, job.bind);
          if (job.drain) void drainQueue(tabId);
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
                    queued: e.queued?.map((q) => ({ ...q, state: "not-sent", autoSend: false })),
                    queueEpoch: (e.queueEpoch ?? 0) + 1,
                    pendingPrompts: [],
                    pendingAttachments: [],
                    recovering: false,
                    pendingSwitch: null,
                    switchError: e.pendingSwitch ? `${e.pendingSwitch.path}: pi exited before the switch committed` : e.switchError,
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
      set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, session, recovering: !!recovered })));
      if (recovered) await get().switchToSession(tabId, { ...recovered, snippet: "" });
    } catch (e) {
      const failed = get().tabs[tabId];
      if (failed?.gen === gen && failed.recovering) void failed.session?.kill();
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => err.gen !== gen ? err : ({
          ...err,
          session: err.recovering ? null : err.session,
          recovering: false,
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  sendPrompt: async (tabId, text, images = []) => {
    const entry = get().tabs[tabId];
    if (!entry?.session || entry.exited) throw new Error("Session exited");
    images = images.filter((image) => image.data.length > 0);
    if (!text.trim() && images.length === 0) return;
    if (entry.state.status === "cancelling" || entry.state.cancelRequested) {
      const error = "cancellation in progress; send again once the strip is idle";
      set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, rejectedDraft: { text, images, error } })));
      throw new Error(error);
    }
    if (turnInFlight(entry.state.status) || entry.state.retry) {
      await enqueuePrompt(tabId, text, images);
    } else {
      await sendNow(tabId, text, images);
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
      failed.submissionId !== submissionId || turnInFlight(entry.state.status) || entry.state.retry || entry.state.cancelRequested
    ) {
      return;
    }
    set((s) =>
      patchEntry(s.tabs, tabId, (e) =>
        e.failedSubmission?.submissionId === submissionId
          ? {
              ...e,
              failedSubmission: { ...e.failedSubmission!, state: "retrying" },
              state: { ...e.state, status: "thinking" },
            }
          : e,
      ),
    );
    const failRetry = (message: string) => {
      set((s) =>
        patchEntry(s.tabs, tabId, (e) =>
          e.failedSubmission?.submissionId === submissionId
            ? {
                ...e,
                state: { ...e.state, status: "idle" },
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
          // The failed card owns its own copy of the source bytes: restaging
          // reads the staged file, so removing the composer chips (which
          // deletes the draft files) cannot orphan the retry. Only a
          // submission that never staged falls back to its draft file.
          path: r.stagedPath ?? r.draftPath ?? "",
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
        await session.send(promptLine(failed.text, failed.images));
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
              state: { ...e.state, status: "idle" },
              pendingPrompts: e.pendingPrompts?.filter((p) => p.submissionId !== submissionId),
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

  retryQueued: async (tabId, id) => {
    const entry = get().tabs[tabId];
    const queued = entry?.queued?.find((q) => q.id === id);
    if (!queued || queued.state === "sending" || entry.queueBusy || !entry.session || entry.exited ||
        turnInFlight(entry.state.status) || entry.state.retry || entry.state.status === "cancelling" || entry.state.cancelRequested) return;
    await sendNow(tabId, queued.text, queued.images, id);
  },

  editQueued: (tabId, id) => changeQueue(tabId, id, true),
  cancelQueued: (tabId, id) => changeQueue(tabId, id, false),
  discardQueued: (tabId) => changeQueue(tabId, null, false),

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
      patchEntry(s.tabs, tabId, (e) => ({ ...e, state: requestCancel(e.state), queueEpoch: (e.queueEpoch ?? 0) + 1, queued: e.queued?.map((q) => ({ ...q, state: "not-sent", autoSend: false })) })),
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

  switchToSession: async (tabId, request) => {
    const entry = get().tabs[tabId];
    const session = entry?.session;
    if (!entry || !session) {
      throw new Error(`${request.path}: no live pi session to switch into`);
    }
    if (entry.pendingSwitch || entry.locatorPending) {
      throw new Error(
        `switch_session already in progress (${entry.pendingSwitch?.path ?? entry.sessionPath})`,
      );
    }
    // Stage the parsed transcript before the wire command: the ack can then
    // swap it in atomically, and the current conversation stays untouched
    // until pi confirms the switch.
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        pendingSwitch: request,
        switchError: null,
      })),
    );
    try {
      await session.send(
        JSON.stringify({ type: "switch_session", sessionPath: request.path }),
      );
    } catch (error) {
      // The write never reached pi or its pipe was gone: unstage and name
      // the file. The previous conversation stands.
      set((s) =>
        patchEntry(s.tabs, tabId, (e) =>
          e.pendingSwitch === request
            ? {
                ...e,
                pendingSwitch: null,
                switchError: `${request.path}: ${attachmentError(error)}`,
              }
            : e,
        ),
      );
      throw error;
    }
  },

  clearScrollRequest: (tabId, seq) => {
    set((s) =>
      patchEntry(s.tabs, tabId, (e) =>
        e.scrollRequest?.seq === seq ? { ...e, scrollRequest: null } : e,
      ),
    );
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
