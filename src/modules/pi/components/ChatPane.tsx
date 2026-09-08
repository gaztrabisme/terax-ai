import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { retryPendingLabel, type PiImageAttachment } from "../lib/parse";
import { modelAcceptsImages } from "../lib/providers";
import { bindPendingImages } from "../lib/turnImages";
import type { ArtifactFileRef } from "../lib/artifacts";
import { usePiStore, type ComposerImage } from "../lib/piStore";
import { Composer } from "./Composer";
import { formatCost, Transcript } from "./Transcript";

type Props = {
  tabId: number;
  cwd?: string;
  onOpenChild: (path: string) => void;
  /** Completed artifact files keyed by `<turnKey>/<n>` (K13 file-first). */
  artifactFiles?: Record<string, ArtifactFileRef>;
};

function statusLabel(
  status: string,
  exited: boolean,
  exitCode: number | null,
): string {
  if (exited) return `exited (${exitCode ?? "signal"})`;
  switch (status) {
    case "idle":
      return "idle";
    case "thinking":
      return "thinking";
    case "tool":
      return "running tool";
    case "awaiting-ask":
      return "waiting for answer";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return status;
  }
}

// The chat column of a pi tab: session header, transcript, composer. Owns no
// session lifecycle beyond the header buttons; PiTab opens the session and
// the layout owns the tab.
export function ChatPane({ tabId, cwd, onOpenChild, artifactFiles }: Props) {
  const entry = usePiStore((s) => s.tabs[tabId]);
  const sendPrompt = usePiStore((s) => s.sendPrompt);
  const retrySubmission = usePiStore((s) => s.retrySubmission);
  const removeQueued = usePiStore((s) => s.removeQueued);
  const answerAsk = usePiStore((s) => s.answerAsk);
  const dismissAsk = usePiStore((s) => s.dismissAsk);
  const kill = usePiStore((s) => s.kill);
  const close = usePiStore((s) => s.close);
  const openSession = usePiStore((s) => s.openSession);
  const [sendError, setSendError] = useState<string | null>(null);

  const blocks = entry?.state.blocks ?? [];
  const state = entry?.state;

  // Sent thumbnails are local turn state: pi's session file may not echo the
  // image bytes back, so each queued set binds FIFO to the next user message
  // block that arrives. Turn.key is that block id (turns.ts groupBlocks).
  const [turnImages, setTurnImages] = useState<
    Record<string, PiImageAttachment[]>
  >({});
  const pendingImagesRef = useRef<PiImageAttachment[][]>([]);
  const boundUserIdsRef = useRef<Set<string>>(new Set());

  // A new session restarts the block feed: drop bound and queued thumbnails.
  useEffect(() => {
    if (blocks.length > 0) return;
    if (
      boundUserIdsRef.current.size === 0 &&
      pendingImagesRef.current.length === 0
    )
      return;
    boundUserIdsRef.current.clear();
    pendingImagesRef.current = [];
    setTurnImages({});
  }, [blocks]);

  useEffect(() => {
    const additions = bindPendingImages(
      blocks,
      boundUserIdsRef.current,
      pendingImagesRef.current,
    );
    if (additions) setTurnImages((prev) => ({ ...prev, ...additions }));
  }, [blocks]);

  // K13: a failed submission's thumbnail set leaves the pending queue, so a
  // later plain send cannot own its images (bindPendingImages semantics
  // stay; the failure is what must not rebind). The splice runs only while
  // the failure stands, never on the "retrying" state.
  const failedSubmission = entry?.failedSubmission ?? null;
  useEffect(() => {
    if (!failedSubmission || failedSubmission.state !== "failed") return;
    const index = pendingImagesRef.current.indexOf(
      failedSubmission.images as PiImageAttachment[],
    );
    if (index !== -1) pendingImagesRef.current.splice(index, 1);
  }, [failedSubmission]);

  const status = state?.status ?? "idle";
  const exited = entry?.exited === true;
  // A pending auto-retry replaces the running label until it resolves.
  const retry = state?.retry ?? null;
  // Stop only while the session is actively working; New session takes over
  // once the run is done, nothing is busy, or the process exited. The two are
  // mutually exclusive, so a done-but-alive session no longer shows both.
  const showStop =
    !exited &&
    (status === "thinking" || status === "tool" || status === "awaiting-ask");
  const showNew =
    exited || status === "done" || status === "idle" || status === "error";

  // Best-known model for the composer chip: the store's resolved roles win;
  // the last assistant message is the fallback while roles.model is empty.
  const model = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (
        block.kind === "message" &&
        block.role === "assistant" &&
        block.model
      ) {
        return block.model;
      }
    }
    return null;
  }, [blocks]);
  const roles = entry?.roles;
  const chipModel = roles?.model || model;

  // Vision flag for the effective provider/model, read from the cached
  // model table (fetched once per provider through pi_list_models, which
  // runs pi with the stored cloud keys only). Undefined keeps the composer
  // notice on its conservative text when the table has no row for the pair.
  const modelRows = usePiStore((s) => s.modelRows);
  const ensureModelRows = usePiStore((s) => s.ensureModelRows);
  useEffect(() => {
    const provider = roles?.provider?.trim();
    if (provider) void ensureModelRows(provider, cwd);
  }, [roles?.provider, cwd, ensureModelRows]);
  const tabModelAcceptsImages = useMemo(
    () =>
      modelAcceptsImages(
        roles?.provider ? modelRows[roles.provider] : undefined,
        roles?.provider,
        chipModel,
      ),
    [modelRows, roles?.provider, chipModel],
  );

  const submit = (markdown: string, images: ComposerImage[]) => {
    if (!entry?.session || entry.exited) return;
    setSendError(null);
    if (images.length > 0) pendingImagesRef.current.push(images);
    sendPrompt(tabId, markdown, images).catch((e) => {
      // The send failed, so unbind: the queued set must not attach to a
      // later user message. The store's failedSubmission carries the same
      // array and the failed-submission effect splices it as well.
      const idx = pendingImagesRef.current.indexOf(images);
      if (idx !== -1) pendingImagesRef.current.splice(idx, 1);
      setSendError(e instanceof Error ? e.message : String(e));
    });
  };

  // K13 retry: the same submission id resends the same text and images.
  // Thumbnails ride the pending queue again, FIFO, so only the retried
  // send's own acknowledged turn can own them.
  const retryFailed = (submissionId: string) => {
    const failed = entry?.failedSubmission;
    if (!failed || failed.submissionId !== submissionId) return;
    setSendError(null);
    pendingImagesRef.current.push(failed.images);
    void retrySubmission(tabId, submissionId);
  };

  const newSession = () => {
    setSendError(null);
    close(tabId);
    void openSession(tabId, { cwd });
  };
  const stop = () => void kill(tabId);

  // K14: a launch failure is an entry error with no session behind it (a
  // failed preparation or spawn never produced a process). Errors that arrive
  // mid-session keep the plain card below.
  const launchFailed =
    entry?.error != null && entry?.session == null && entry?.exited !== true;

  // Open log opens the project's launcher.log in an editor tab through the
  // same bridge the transcript's file links use (App listens for pi:open-file).
  const openLauncherLog = () => {
    if (!cwd) return;
    window.dispatchEvent(
      new CustomEvent("pi:open-file", {
        detail: { path: `${cwd}/.pi/launcher.log` },
      }),
    );
  };

  const headerBtn =
    "rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-accent hover:text-foreground";

  return (
    <div
      data-pi-model={chipModel ?? undefined}
      data-pi-smol={roles?.smol || undefined}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card"
    >
      <div
        data-uat="session-strip"
        className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            exited || status === "error"
              ? "bg-destructive"
              : status === "awaiting-ask"
                ? "bg-yellow-500"
                : showStop
                  ? "animate-pulse bg-blue-500"
                  : "bg-muted-foreground/40",
          )}
        />
        <span className="font-medium text-foreground">pi</span>
        <span data-uat="session-status">
          {!exited && retry
            ? retryPendingLabel(retry)
            : statusLabel(status, exited, entry?.exitCode ?? null)}
        </span>
        {state && state.turnTokens > 0 ? (
          <span data-uat="turn-tokens">
            {state.turnTokens.toLocaleString()} tok
          </span>
        ) : null}
        {state && state.sessionCost > 0 ? (
          <span data-uat="session-cost">{formatCost(state.sessionCost)}</span>
        ) : null}
        <span className="flex-1" />
        {showStop ? (
          <button
            type="button"
            data-uat="stop-button"
            onClick={stop}
            className={headerBtn}
          >
            Stop
          </button>
        ) : null}
        {showNew ? (
          <button
            type="button"
            data-uat="new-session"
            onClick={newSession}
            className={headerBtn}
          >
            New session
          </button>
        ) : null}
      </div>

      {launchFailed ? (
        <div
          data-uat="launch-error"
          role="alert"
          className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1" title={entry?.error ?? undefined}>
            Launch failed: {entry?.error}
          </span>
          {cwd ? (
            <button
              type="button"
              data-uat="open-launcher-log"
              aria-label="Open log"
              title="Open log"
              onClick={openLauncherLog}
              className="shrink-0 rounded-md border border-destructive/40 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/20"
            >
              Open log
            </button>
          ) : null}
        </div>
      ) : entry?.error ? (
        <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {entry.error}
        </div>
      ) : null}
      {sendError ? (
        <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {sendError}
        </div>
      ) : null}
      {entry?.bindError ? (
        <div
          role="status"
          className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {entry.bindError}
        </div>
      ) : null}

      <Transcript
        blocks={blocks}
        turnImages={turnImages}
        queued={entry?.queued ?? []}
        onRemoveQueued={(id) => removeQueued(tabId, id)}
        onAnswer={(requestId, answers) =>
          void answerAsk(tabId, requestId, answers)
        }
        onDismiss={(requestId) => void dismissAsk(tabId, requestId)}
        cwd={cwd}
        sessionId={state?.sessionId ?? null}
        artifactFiles={artifactFiles}
        failedSubmission={entry?.failedSubmission ?? null}
        onRetrySubmission={retryFailed}
        onOpenChild={onOpenChild}
      />

      <Composer
        tabId={tabId}
        cwd={cwd}
        disabled={!entry?.session || entry.exited}
        placeholder={
          entry?.session
            ? "Message pi (markdown, Enter sends)"
            : entry?.exited
              ? "Session exited"
              : "Waiting for pi..."
        }
        modelAcceptsImages={tabModelAcceptsImages}
        onSubmit={submit}
        onStop={showStop ? stop : undefined}
      />
    </div>
  );
}
