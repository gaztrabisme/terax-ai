import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  BotIcon,
  CheckmarkCircle01Icon,
  CircuitBoardIcon,
  CopyIcon,
  FileCodeIcon,
  FileEditIcon,
  Folder01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  MessageResponse,
  Shimmer,
} from "@/components/chat";
import { Fragment, useCallback, useMemo, useState } from "react";
import {
  messageBlocks,
  retryPendingLabel,
  type PiAskAnswer,
  type PiErrorBlock,
  type PiFeedItem,
  type PiImageAttachment,
  type PiRetryBlock,
  type PiToolBlock,
  type PiUsage,
} from "@/modules/pi/lib/parse";
import {
  boardOp,
  childTranscriptPath,
  groupTurns,
  isBoardTool,
  isSubagentTool,
  subagentBrief,
  subagentName,
  type Turn,
} from "@/modules/pi/lib/turns";
import {
  artifactFileKey,
  detectArtifacts,
  type Artifact,
  type ArtifactFileRef,
} from "@/modules/pi/lib/artifacts";
import type { PiFailedSubmission, PiQueued } from "@/modules/pi/lib/piStore";
import { CACHE_QUALIFIER_TEXT, cacheShareLabel } from "@/modules/pi/lib/usage";
import { KeystoneCard } from "./blocks/KeystoneCard";
import { ToolStep } from "./blocks/ToolRow";

type Props = {
  blocks: PiFeedItem[];
  onAnswer: (requestId: string, answers: PiAskAnswer[]) => void;
  onDismiss: (requestId: string) => void;
  emptyHint?: string;
  /** Workspace root: anchors empty state and exported answer files. */
  cwd?: string;
  /** The pi session id, naming exported answer and artifact files. */
  sessionId?: string | null;
  /** Opens a child transcript tab from a subagent step. */
  onOpenChild?: (path: string) => void;
  /** Images sent with each turn, keyed by turn key (the user block id).
   *  Local state from the composer: the session file may not echo the bytes. */
  turnImages?: Record<string, PiImageAttachment[]>;
  /** Completed artifact files per `<turnKey>/<n>`; a turn's Open artifact
   *  control appears only when its file exists (K13 file-first). */
  artifactFiles?: Record<string, ArtifactFileRef>;
  /** The standing failed submission, when one is not acknowledged yet. */
  failedSubmission?: PiFailedSubmission | null;
  /** Resends a failed submission under its own id. */
  onRetrySubmission?: (submissionId: string) => void;
  /** Follow-up prompts sent while a turn was streaming; rendered after the
   *  turns until pi runs them. */
  queued?: PiQueued[];
  /** Returns a queued prompt's text to the composer. Only called pre-ack:
   *  it cannot cancel pi's queue (pi 0.3.0 has no command for that). */
  onRemoveQueued?: (id: string) => void;
};

/** Event the artifact pane listens for: select this turn's artifact and
 *  expand the pane if it is collapsed. */
export function openArtifactEvent(
  turn: number,
  n: number,
): CustomEvent<{ turn: number; n: number }> {
  return new CustomEvent("pi:open-artifact", { detail: { turn, n } });
}

/** Markdown stripped down to the text a reader sees, for plain Copy. */
export function renderedText(markdown: string): string {
  return markdown
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*|_)([^*_]+)\1/g, "$2")
    .trim();
}

/** Writes the answer's exact Markdown to `.pi/answers/<session-id>-<turn-id>.md`
 *  through the Rust writer (K13), which reads the file back and verifies
 *  content equality before the editor is allowed to open. */
async function openAnswerInEditor(
  cwd: string,
  sessionId: string | null | undefined,
  turnKey: string,
  markdown: string,
): Promise<string> {
  const res = await invoke<{ path: string }>("pi_write_answer", {
    cwd,
    sessionId: sessionId ?? "",
    turnId: turnKey,
    markdown,
    workspace: currentWorkspaceEnv(),
  });
  const absolute = `${cwd.replace(/[\\/]+$/, "")}/${res.path}`;
  window.dispatchEvent(
    new CustomEvent("pi:open-file", { detail: { path: absolute } }),
  );
  return absolute;
}

function basename(cwd?: string): string | null {
  const base = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return base ?? null;
}

function projectPath(cwd: string, relative: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  return `${base}/${relative.replace(/^[\\/]+/, "")}`;
}

function AttachmentActions({
  cwd,
  attachments,
}: {
  cwd?: string;
  attachments: Turn["savedAttachments"];
}) {
  const button =
    "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1">
      {attachments.map((attachment, i) => {
        const absolute =
          attachment.path && cwd ? projectPath(cwd, attachment.path) : null;
        return (
          <div
            key={`${attachment.path ?? "failed"}-${i}`}
            data-uat="attachment-chip"
            data-uat-key={attachment.path ?? `failed-${i}`}
            data-uat-index={i}
            className={cn(
              "flex max-w-full flex-wrap items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-xs",
              attachment.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span
              className="max-w-48 truncate font-mono"
              title={attachment.path ?? undefined}
            >
              {attachment.path ?? `attachment ${i + 1}`}
            </span>
            {attachment.error ? <span>failed: {attachment.error}</span> : null}
            {absolute ? (
              <>
                <button
                  type="button"
                  title={`Open ${absolute} in the editor`}
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("pi:open-file", {
                        detail: { path: absolute },
                      }),
                    )
                  }
                  className={button}
                >
                  <HugeiconsIcon
                    icon={FileEditIcon}
                    size={12}
                    strokeWidth={1.75}
                  />
                  Open in editor
                </button>
                <button
                  type="button"
                  title={`Reveal ${absolute}`}
                  onClick={() => {
                    void revealItemInDir(absolute).catch(() => {});
                  }}
                  className={button}
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                  Reveal
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function streamingLabel(turn: Turn): string {
  const running = [...turn.activity]
    .reverse()
    .find((entry) => entry.kind === "tool" && entry.block.status === "running");
  if (running?.kind === "tool") {
    const block = running.block;
    if (isBoardTool(block)) return `Board: ${boardOp(block.toolName)}`;
    if (isSubagentTool(block)) return `${subagentName(block)} working`;
    return `Running ${block.toolName}`;
  }
  return "Thinking";
}

/**
 * Groups the card items (errors and retries) by the turn they belong to: the
 * turn index mirrors groupBlocks (a user message opens the next group,
 * leading blocks share group 0), so each card renders attached to the turn
 * it happened in, in feed order.
 */
function cardsByTurn(
  blocks: PiFeedItem[],
): Map<number, (PiErrorBlock | PiRetryBlock)[]> {
  const map = new Map<number, (PiErrorBlock | PiRetryBlock)[]>();
  let userCount = 0;
  for (const block of blocks) {
    if (block.kind === "error" || block.kind === "retry") {
      const turn = userCount > 0 ? userCount - 1 : 0;
      const list = map.get(turn);
      if (list) list.push(block);
      else map.set(turn, [block]);
      continue;
    }
    if (block.kind === "message" && block.role === "user") userCount += 1;
  }
  return map;
}

function addUsage(a: PiUsage, b: PiUsage): PiUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    costTotal: a.costTotal + b.costTotal,
  };
}

/**
 * Per-turn usage, summed over the turn's assistant messages (a turn with
 * tool calls makes several model requests; pi closes each with its own
 * usage, the last one also riding turn_end). Turn indices mirror
 * groupBlocks so footer i reads usage.get(i).
 */
export function usageByTurn(blocks: PiFeedItem[]): Map<number, PiUsage> {
  const map = new Map<number, PiUsage>();
  let userCount = 0;
  for (const block of blocks) {
    if (block.kind === "message" && block.role === "user") {
      userCount += 1;
      continue;
    }
    if (block.kind !== "message" || block.role !== "assistant") continue;
    if (!block.usage) continue;
    const turn = userCount > 0 ? userCount - 1 : 0;
    const acc = map.get(turn);
    map.set(turn, acc ? addUsage(acc, block.usage) : block.usage);
  }
  return map;
}

/** "1,204 in, 312 out"; the cached share renders separately (K10). */
export function usageLabel(usage: PiUsage): string {
  return `${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`;
}

/** "$0.0031" for the small per-turn sums, "$0.92" once a run adds up. */
export function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

function ErrorCard({
  block,
  retry,
}: {
  block: PiErrorBlock;
  /** K13: the Retry submission control scoped to the failed submission id. */
  retry?: {
    submissionId: string;
    retrying: boolean;
    onRetry: () => void;
  };
}) {
  return (
    <div
      data-uat="error-card"
      data-uat-key={retry?.submissionId}
      className="flex max-w-[72ch] items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
    >
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={14}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0"
      />
      <span className="select-text whitespace-pre-wrap wrap-break-word">
        {block.text}
      </span>
      {retry ? (
        <button
          type="button"
          data-uat="submission-retry"
          data-uat-key={retry.submissionId}
          aria-label="Retry submission"
          title="Retry submission"
          disabled={retry.retrying}
          onClick={retry.onRetry}
          className="shrink-0 rounded-md border border-destructive/40 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          {retry.retrying ? "Retrying..." : "Retry submission"}
        </button>
      ) : null}
    </div>
  );
}

function RetryCard({ block }: { block: PiRetryBlock }) {
  const text =
    block.phase === "start"
      ? retryPendingLabel({
          attempt: block.attempt,
          max: block.max ?? block.attempt,
          delayMs: block.delayMs ?? 0,
        })
      : block.success === true
        ? `retry ${block.attempt} succeeded`
        : block.success === false
          ? `retry ${block.attempt} failed`
          : `retry ${block.attempt}`;
  return (
    <div
      data-uat="retry-card"
      className="flex max-w-[72ch] items-start gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground"
    >
      <HugeiconsIcon
        icon={Refresh01Icon}
        size={14}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0"
      />
      <span className="select-text whitespace-pre-wrap wrap-break-word">
        {text}
      </span>
    </div>
  );
}

export function workedLabel(turn: Turn, usage: PiUsage | null): string {
  const parts: string[] = [];
  if (turn.durationMs !== null) {
    parts.push(`Worked ${Math.max(1, Math.round(turn.durationMs / 1000))} s`);
  }
  if (turn.counts.tools > 0) parts.push(`${turn.counts.tools} tools`);
  if (turn.counts.children > 0) parts.push(`${turn.counts.children} children`);
  // Zero-usage turns (failed requests) show no numbers and no "$0": a local
  // provider and a zero-priced catalog row both bill nothing.
  if (usage && (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0)) {
    parts.push(usageLabel(usage));
  }
  if (usage && usage.costTotal > 0) parts.push(formatCost(usage.costTotal));
  return parts.join(", ") || "Worked";
}

function ThinkingEntry({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n")[0] ?? "";
  return (
    <div className="text-[13px] text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded text-left italic hover:text-foreground"
      >
        {open ? "Thought" : firstLine}
        {!open && trimmed.includes("\n") ? "..." : ""}
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap wrap-break-word">
          {trimmed}
        </div>
      ) : null}
    </div>
  );
}

function BoardChip({ block }: { block: PiToolBlock }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
      <HugeiconsIcon icon={CircuitBoardIcon} size={12} strokeWidth={1.75} />
      Board: {boardOp(block.toolName)}
      {block.status === "running" ? "..." : ""}
    </span>
  );
}

function ChildCard({
  block,
  cwd,
  onOpenChild,
}: {
  block: PiToolBlock;
  cwd?: string;
  onOpenChild?: (path: string) => void;
}) {
  const path = childTranscriptPath(block, cwd);
  return (
    <div
      data-uat="child-card"
      data-uat-key={block.toolCallId}
      className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
    >
      <HugeiconsIcon
        icon={BotIcon}
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{subagentName(block)}</div>
        {subagentBrief(block) ? (
          <div className="truncate text-xs text-muted-foreground">
            {subagentBrief(block)}
          </div>
        ) : null}
      </div>
      {path && onOpenChild ? (
        <button
          type="button"
          data-uat="open-transcript"
          onClick={() => onOpenChild(path)}
          className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-accent hover:text-foreground"
        >
          Open transcript
        </button>
      ) : null}
    </div>
  );
}

/**
 * K10: the unconditional provider-neutral qualifier, on every rendered usage
 * footer including unknown usage. The sentence rides the title and
 * aria-label; the visible form is one muted glyph (aesthetic and
 * minimalist).
 */
function CacheQualifier() {
  return (
    <span
      data-uat="cache-qualifier"
      title={CACHE_QUALIFIER_TEXT}
      aria-label={CACHE_QUALIFIER_TEXT}
      className="text-muted-foreground"
    >
      ?
    </span>
  );
}

function ActivityFold({
  turn,
  usage,
  open,
  onToggle,
  cwd,
  onOpenChild,
}: {
  turn: Turn;
  usage: PiUsage | null;
  open: boolean;
  onToggle: () => void;
  cwd?: string;
  onOpenChild?: (path: string) => void;
}) {
  return (
    <div className="w-full">
      <button
        type="button"
        data-uat="turn-fold"
        data-uat-key={turn.key}
        onClick={onToggle}
        className="group flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {turn.status === "streaming" ? (
          <Shimmer duration={1.4}>{streamingLabel(turn)}</Shimmer>
        ) : (
          <>
            <span data-uat="usage-footer" data-uat-key={turn.key}>
              {workedLabel(turn, usage)}
            </span>
            {/* The unstable cache segment, split out of the footer string:
                the computed share, or "cache unknown" when the prompt size
                is 0. UAT never asserts this text. */}
            {usage ? (
              <span data-uat="cache-share" data-uat-unstable="1">
                {cacheShareLabel(usage)}
              </span>
            ) : null}
            <CacheQualifier />
          </>
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={1.75}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="mt-1.5 ml-1 space-y-2 border-l border-border/60 pl-3">
          {turn.activity.map((entry, i) => (
            // Activity entries are positional: a turn's feed only appends.
            <div key={i}>
              {entry.kind === "thinking" ? (
                <ThinkingEntry text={entry.text} />
              ) : null}
              {entry.kind === "narration" ? (
                <div className="text-[13px] text-muted-foreground whitespace-pre-wrap wrap-break-word">
                  {entry.text}
                </div>
              ) : null}
              {entry.kind === "tool" ? (
                isSubagentTool(entry.block) ? (
                  <ChildCard
                    block={entry.block}
                    cwd={cwd}
                    onOpenChild={onOpenChild}
                  />
                ) : isBoardTool(entry.block) ? (
                  <BoardChip block={entry.block} />
                ) : (
                  <ToolStep block={entry.block} />
                )
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AnswerActions({
  cwd,
  sessionId,
  turn,
  markdown,
  artifacts,
  artifactFiles,
}: {
  cwd?: string;
  sessionId?: string | null;
  turn: Turn;
  markdown: string;
  /** Artifacts detected over this answer; one chip each. */
  artifacts: Artifact[];
  /** Completed artifact files keyed by `<turnKey>/<n>`: only these may
   *  open the viewer (K13 file-first, no answer-text-only activation). */
  artifactFiles?: Record<string, ArtifactFileRef>;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copyRendered = useCallback(() => {
    void navigator.clipboard
      ?.writeText(renderedText(markdown))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [markdown]);

  const copyMarkdown = useCallback(() => {
    void navigator.clipboard
      ?.writeText(markdown)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [markdown]);

  const openInEditor = useCallback(() => {
    if (!cwd) return;
    setError(null);
    openAnswerInEditor(cwd, sessionId, turn.key, markdown)
      .then((path) => {
        setSaved(path.split(/[\\/]/).pop() ?? path);
        window.setTimeout(() => setSaved(null), 2000);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [cwd, sessionId, markdown, turn.key]);

  const btn =
    "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div
      data-uat="answer-actions"
      data-uat-key={turn.key}
      className="flex items-center gap-1"
    >
      <button
        type="button"
        data-uat="copy"
        onClick={copyRendered}
        className={btn}
      >
        <HugeiconsIcon
          icon={copied ? CheckmarkCircle01Icon : CopyIcon}
          size={12}
          strokeWidth={1.75}
        />
        Copy
      </button>
      <button
        type="button"
        data-uat="copy-markdown"
        onClick={copyMarkdown}
        className={btn}
      >
        <HugeiconsIcon
          icon={copied ? CheckmarkCircle01Icon : CopyIcon}
          size={12}
          strokeWidth={1.75}
        />
        Copy markdown
      </button>
      {cwd ? (
        <button
          type="button"
          data-uat="open-in-editor"
          onClick={openInEditor}
          className={btn}
        >
          <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} />
          Open in editor
        </button>
      ) : null}
      {artifacts.map((artifact, i) => {
        // File-first: a detected document without a completed file offers
        // no viewer control at all.
        const file = artifactFiles?.[artifactFileKey(turn.key, i)];
        if (!file) return null;
        return (
          <button
            key={`${artifact.kind}-${i}`}
            type="button"
            data-uat="open-artifact"
            data-uat-key={`${turn.key}/artifact-${i}`}
            data-uat-index={i}
            title={artifact.title}
            onClick={() =>
              window.dispatchEvent(openArtifactEvent(turn.index, i))
            }
            className={btn}
          >
            <HugeiconsIcon icon={FileCodeIcon} size={12} strokeWidth={1.75} />
            {artifacts.length > 1 ? `Open artifact ${i + 1}` : "Open artifact"}
          </button>
        );
      })}
      {saved ? (
        <span className="text-xs text-muted-foreground">saved {saved}</span>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

function TurnView({
  turn,
  usage,
  images,
  open,
  onToggle,
  cwd,
  sessionId,
  onOpenChild,
  onAnswer,
  onDismiss,
  artifactFiles,
}: {
  turn: Turn;
  usage: PiUsage | null;
  images?: PiImageAttachment[];
  open: boolean;
  onToggle: () => void;
  cwd?: string;
  sessionId?: string | null;
  onOpenChild?: (path: string) => void;
  onAnswer: (requestId: string, answers: PiAskAnswer[]) => void;
  onDismiss: (requestId: string) => void;
  artifactFiles?: Record<string, ArtifactFileRef>;
}) {
  // Artifacts only once the answer is final: a streaming document would
  // redraw the pane on every chunk.
  const artifacts = useMemo(
    () => (turn.status === "done" ? detectArtifacts(turn.answer) : []),
    [turn.status, turn.answer],
  );
  const hasUserContent =
    turn.user.length > 0 ||
    (images?.length ?? 0) > 0 ||
    turn.savedAttachments.length > 0;
  return (
    <div
      data-uat="pi-turn"
      data-uat-key={turn.key}
      data-uat-index={turn.index}
      className="flex flex-col gap-2"
    >
      {hasUserContent ? (
        <div className="flex justify-end">
          <div
            data-uat="turn-user"
            className="max-w-[65%] rounded-md bg-muted/70 px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-foreground"
          >
            {images && images.length > 0 ? (
              <div className="mb-2 flex flex-wrap justify-end gap-1.5">
                {images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={`attached image ${i + 1}`}
                    className="max-h-32 rounded-md border border-border/60 object-contain"
                  />
                ))}
              </div>
            ) : null}
            {turn.user}
            {turn.savedAttachments.length > 0 ? (
              <AttachmentActions
                cwd={cwd}
                attachments={turn.savedAttachments}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {turn.activity.length > 0 || turn.asks.length > 0 ? (
        <ActivityFold
          turn={turn}
          usage={usage}
          open={open}
          onToggle={onToggle}
          cwd={cwd}
          onOpenChild={onOpenChild}
        />
      ) : null}
      {turn.asks.map((ask) => (
        <KeystoneCard
          key={ask.requestId}
          block={ask}
          onAnswer={(answers) => onAnswer(ask.requestId, answers)}
          onDismiss={() => onDismiss(ask.requestId)}
        />
      ))}
      {turn.answer ? (
        <div data-uat="answer-body" className="max-w-[72ch]">
          <MessageResponse
            streaming={turn.status === "streaming"}
            className="text-[14px] leading-relaxed text-foreground"
          >
            {turn.answer}
          </MessageResponse>
          {turn.status === "done" ? (
            <div className="mt-1.5">
              <AnswerActions
                cwd={cwd}
                sessionId={sessionId}
                turn={turn}
                markdown={turn.answer}
                artifacts={artifacts}
                artifactFiles={artifactFiles}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Source-agnostic: the parent feed comes from piStore, a child transcript
// from the child store. Callers wire their own store reads.
export function Transcript({
  blocks,
  onAnswer,
  onDismiss,
  emptyHint = "Enter sends, Shift+Enter newline",
  cwd,
  sessionId,
  onOpenChild,
  turnImages,
  artifactFiles,
  failedSubmission,
  onRetrySubmission,
  queued,
  onRemoveQueued,
}: Props) {
  // Error and retry blocks render as their own cards attached to the turn
  // they belong to, so the turn model never sees them.
  const turns = useMemo(() => groupTurns(messageBlocks(blocks)), [blocks]);
  const cards = useMemo(() => cardsByTurn(blocks), [blocks]);
  const usage = useMemo(() => usageByTurn(blocks), [blocks]);
  // Fold state is remembered per turn for as long as this tab lives.
  const [openTurns, setOpenTurns] = useState<Record<string, boolean>>({});
  const toggle = useCallback((key: string) => {
    setOpenTurns((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (turns.length === 0 && cards.size === 0 && (queued?.length ?? 0) === 0) {
    return (
      <div
        data-uat="transcript"
        className="min-h-0 flex-1 select-text overflow-y-auto"
      >
        <ConversationEmptyState
          title={basename(cwd) ?? "pi"}
          description={emptyHint}
        />
      </div>
    );
  }

  return (
    <div
      data-uat="transcript"
      className="relative flex min-h-0 flex-1 flex-col select-text"
    >
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-6 p-4">
          {turns.map((turn, i) => (
            <Fragment key={turn.key}>
              <TurnView
                key={turn.key}
                turn={turn}
                usage={usage.get(i) ?? null}
                images={turnImages?.[turn.key]}
                open={openTurns[turn.key] ?? false}
                onToggle={() => toggle(turn.key)}
                cwd={cwd}
                sessionId={sessionId}
                onOpenChild={onOpenChild}
                onAnswer={onAnswer}
                onDismiss={onDismiss}
                artifactFiles={artifactFiles}
              />
              {(cards.get(i) ?? []).map((block, j) =>
                block.kind === "error" ? (
                  <ErrorCard key={`card-${i}-${j}`} block={block} />
                ) : (
                  <RetryCard key={`card-${i}-${j}`} block={block} />
                ),
              )}
            </Fragment>
          ))}
          {/* Cards with no turn under them (failed before any message). */}
          {(cards.get(turns.length) ?? []).map((block, j) =>
            block.kind === "error" ? (
              <ErrorCard key={`card-bare-${j}`} block={block} />
            ) : (
              <RetryCard key={`card-bare-${j}`} block={block} />
            ),
          )}
          {/* A failed submission stands as its own error card carrying the
              Retry submission control scoped to the submission id (K13).
              Retrying sends the same text and images under the same id;
              only the acknowledged turn can own the attachments. */}
          {failedSubmission ? (
            <ErrorCard
              block={{
                kind: "error",
                at: 0,
                text: `submission ${failedSubmission.submissionId} failed: ${
                  failedSubmission.error ?? "the send was refused"
                }`,
              }}
              retry={{
                submissionId: failedSubmission.submissionId,
                retrying: failedSubmission.state === "retrying",
                onRetry: () =>
                  onRetrySubmission?.(failedSubmission.submissionId),
              }}
            />
          ) : null}
          {/* Queued follow-ups: pi accepted each one (the prompt command's
              success response) and runs it when the current turn ends; the
              block then leaves the queue and renders as a normal user turn.
              Remove exists only before that ack: it hands the text back to
              the composer but cannot cancel pi's queue, which pi 0.3.0
              gives no command for, so an acked follow-up always runs. */}
          {(queued ?? []).map((q) => (
            <div
              key={q.id}
              data-uat="turn-queued"
              data-uat-key={q.id}
              className="flex justify-end"
            >
              <div className="max-w-[65%] rounded-md border border-border/60 bg-muted/40 px-3.5 py-2 text-[14px] leading-relaxed">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Queued</span>
                  {!q.acked && onRemoveQueued ? (
                    <button
                      type="button"
                      data-uat="queued-remove"
                      aria-label="Remove queued prompt"
                      title="Returns the text to the composer; the queued follow-up cannot be cancelled"
                      onClick={() => onRemoveQueued(q.id)}
                      className="rounded-md border border-border/60 px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap wrap-break-word text-foreground">
                  {q.text}
                </div>
              </div>
            </div>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}
