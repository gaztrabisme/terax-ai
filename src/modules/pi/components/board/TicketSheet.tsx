import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { cn } from "@/lib/utils";
import {
  DEFAULT_AGENT_BIN,
  allowedActionFor,
  boardActionCommand,
  boardShowCommand,
  ensureAgentBin,
  latestGates,
  parseTicket,
  stateLabel,
  type BoardVerb,
  type Ticket,
} from "@/modules/pi/lib/board";

type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

type Props = {
  cwd?: string;
  boardBin: string;
  /** Overrides DEFAULT_AGENT_BIN; the settings worker wires a preference later. */
  agentBin?: string;
  ticketId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Bumped into the parent after a successful action. */
  onRefresh: () => void;
};

// No confirm dialogs here (they block the webview); the first click arms the
// button, the second click within a few seconds runs the action.
const ARM_RESET_MS = 4000;

const VERB_LABELS: Record<BoardVerb, string> = {
  align: "Align",
  land: "Land",
  close: "Close",
  rework: "Rework",
};

/** Canonical UAT id per verb, spelled out so each id is greppable. */
const VERB_UAT_IDS: Record<BoardVerb, string> = {
  align: "board-align",
  land: "board-land",
  close: "board-close",
  rework: "board-rework",
};

type VerbAuthority = { allowed: boolean; reason: string | null };

/**
 * The previous status heuristic, kept ONLY for a ticket whose harness sent no
 * allowedActions field at all (older binary): enablement then matches the
 * pre-K12 sheet instead of disabling everything on missing data.
 */
function fallbackEnabled(status: string | null, verb: BoardVerb): boolean {
  if (!status) return false;
  switch (verb) {
    case "align":
      return status === "align" || status === "todo";
    case "land":
      return status === "land" || status === "review";
    case "close":
      return status === "done";
    case "rework":
      return true;
  }
}

/**
 * Verb enablement from the harness authority (design.md section 3.2): the
 * allowedActions entry decides, and a disabled verb's reason is the harness
 * reason list verbatim. A verb the harness did not offer from the current
 * status (no spine successor entry) is disabled with that named instead.
 */
function verbAuthority(ticket: Ticket | null, verb: BoardVerb): VerbAuthority {
  if (!ticket) return { allowed: false, reason: null };
  const actions = ticket.allowedActions;
  if (actions === null) {
    return { allowed: fallbackEnabled(ticket.status, verb), reason: null };
  }
  const label = VERB_LABELS[verb];
  const entry = allowedActionFor(ticket, verb);
  if (!entry) {
    return {
      allowed: false,
      reason: `${label} is not offered from ${stateLabel(ticket.status)}`,
    };
  }
  if (entry.allowed) return { allowed: true, reason: null };
  const reasons =
    entry.reasons.length > 0 ? entry.reasons.join(", ") : "harness refused";
  return { allowed: false, reason: `${label} needs ${reasons}` };
}

function Section({
  title,
  uat,
  children,
}: {
  title: string;
  uat?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-uat={uat}>
      <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function SectionText({ value }: { value: string | null }) {
  return value && value.trim().length > 0 ? (
    <p className="whitespace-pre-wrap text-[14px] text-foreground">{value}</p>
  ) : (
    <p className="text-[14px] text-muted-foreground">None</p>
  );
}

function GateDot({ passed }: { passed: boolean }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        passed ? "bg-emerald-500" : "bg-destructive",
      )}
    />
  );
}

export function TicketSheet({
  cwd,
  boardBin,
  agentBin = DEFAULT_AGENT_BIN,
  ticketId,
  onOpenChange,
  onRefresh,
}: Props) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [armed, setArmed] = useState<BoardVerb | null>(null);
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!ticketId || !cwd) {
      setTicket(null);
      setLoadError(null);
      return;
    }
    let alive = true;
    setTicket(null);
    setLoadError(null);
    ensureAgentBin(agentBin)
      .then((bin) =>
        invoke<CommandOutput>("shell_run_command", {
          command: boardShowCommand(boardBin, cwd, ticketId, bin),
          cwd,
          timeoutSecs: 15,
          workspace: currentWorkspaceEnv(),
        }),
      )
      .then((out) => {
        if (!alive) return;
        try {
          setTicket(parseTicket(out.stdout));
          setLoadError(null);
        } catch {
          setLoadError(
            out.stderr.trim() ||
              `board exited ${out.exit_code ?? "with no code"}`,
          );
        }
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [ticketId, cwd, boardBin]);

  useEffect(() => {
    return () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    };
  }, []);

  const disarm = () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArmed(null);
  };

  const runAction = (verb: BoardVerb) => {
    if (!cwd || !ticketId || running) return;
    if (armed !== verb) {
      setArmed(verb);
      setActionError(null);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(null), ARM_RESET_MS);
      return;
    }
    disarm();
    setRunning(true);
    setActionError(null);
    ensureAgentBin(agentBin)
      .then((bin) =>
        invoke<CommandOutput>("shell_run_command", {
          command: boardActionCommand(bin, cwd, verb, ticketId),
          cwd,
          timeoutSecs: 30,
          workspace: currentWorkspaceEnv(),
        }),
      )
      .then((out) => {
        setRunning(false);
        if (out.exit_code !== 0) {
          setActionError(
            out.stderr.trim() || `agent exited ${out.exit_code ?? "with no code"}`,
          );
          return;
        }
        onRefresh();
      })
      .catch((e: unknown) => {
        setRunning(false);
        setActionError(e instanceof Error ? e.message : String(e));
      });
  };

  const verbs = Object.keys(VERB_LABELS) as BoardVerb[];
  const authorities = Object.fromEntries(
    verbs.map((verb) => [verb, verbAuthority(ticket, verb)]),
  ) as Record<BoardVerb, VerbAuthority>;
  // One muted line under the verbs: every disabled verb's harness reason, in
  // button order.
  const reasonLine = verbs
    .map((verb) => (!authorities[verb].allowed ? authorities[verb].reason : null))
    .filter((reason): reason is string => reason !== null)
    .join(" · ");
  const gateRows = ticket ? latestGates(ticket) : [];
  const wikiGate = gateRows.find((g) => g.gate === "wiki-close") ?? null;

  return (
    <Sheet open={ticketId !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-uat="ticket-sheet"
        data-uat-key={ticketId ?? undefined}
        className="flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]"
      >
        <SheetHeader className="gap-1 border-b border-border/60 px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-[14px]">
            <span className="font-mono">{ticketId}</span>
            {ticket ? (
              <>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[12px] font-normal text-secondary-foreground">
                  {ticket.kind}
                </span>
                <span className="text-[12px] font-normal text-muted-foreground">
                  {stateLabel(ticket.status)}
                  {ticket.attempt > 0 ? ` · attempt ${ticket.attempt}` : ""}
                </span>
              </>
            ) : null}
          </SheetTitle>
          {ticket && ticket.title ? (
            <SheetDescription className="line-clamp-2 text-[14px]">
              {ticket.title}
            </SheetDescription>
          ) : (
            <SheetDescription className="sr-only">Ticket detail</SheetDescription>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {loadError ? (
            <pre className="whitespace-pre-wrap rounded bg-accent/40 p-2 font-mono text-[12px] text-destructive">
              {loadError}
            </pre>
          ) : !ticket ? (
            <p className="text-[14px] text-muted-foreground">Loading...</p>
          ) : (
            <>
              <Section title="Plan">
                <SectionText value={ticket.workpad?.plan ?? null} />
              </Section>
              <Section title="Acceptance criteria">
                <SectionText value={ticket.workpad?.criteria ?? null} />
              </Section>
              <Section title="Validation" uat="ticket-acceptance">
                <SectionText value={ticket.workpad?.validation ?? null} />
              </Section>
              <Section title="Notes">
                <SectionText value={ticket.workpad?.notes ?? null} />
              </Section>
              <Section title="Confusions">
                {ticket.workpad && ticket.workpad.confusions.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-[14px] text-foreground">
                    {ticket.workpad.confusions.map((confusion, i) => (
                      <li key={i}>{confusion}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[14px] text-muted-foreground">None</p>
                )}
              </Section>
              <Section title="Gates">
                {gateRows.length === 0 ? (
                  <p className="text-[14px] text-muted-foreground">None</p>
                ) : (
                  <ul className="space-y-2">
                    {gateRows.map((gate, gi) => (
                      <li
                        key={gate.gate}
                        data-uat="ticket-gate"
                        data-uat-key={gate.gate}
                        data-uat-index={gi}
                        className="border-l-2 border-border pl-2.5"
                      >
                        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <GateDot passed={gate.passed} />
                          <span className="text-foreground">{gate.gate}</span>
                          <span>{gate.passed ? "pass" : "fail"}</span>
                          <span aria-hidden>&middot;</span>
                          <span>
                            {gate.source}/{gate.provider}
                          </span>
                          {gate.created_at ? (
                            <>
                              <span aria-hidden>&middot;</span>
                              <span>{gate.created_at}</span>
                            </>
                          ) : null}
                        </div>
                        {gate.note ? (
                          <p className="mt-0.5 text-[14px] text-foreground">
                            {gate.note}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div
                  data-uat="ticket-wiki-close"
                  className="mt-2 flex items-center gap-1.5 text-[12px]"
                >
                  <span className="text-foreground">wiki-close</span>
                  {wikiGate ? (
                    <span
                      className={cn(
                        "flex items-center gap-1.5",
                        wikiGate.passed
                          ? "text-foreground"
                          : "text-destructive",
                      )}
                    >
                      <GateDot passed={wikiGate.passed} />
                      <span>{wikiGate.passed ? "pass" : "fail"}</span>
                      {wikiGate.created_at ? (
                        <span className="text-muted-foreground">
                          &middot; {wikiGate.created_at}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      no verdict recorded
                    </span>
                  )}
                </div>
              </Section>
            </>
          )}
        </div>

        <SheetFooter className="flex-row items-start gap-2 border-t border-border/60 px-4 py-3">
          {actionError ? (
            <pre className="mb-2 w-full whitespace-pre-wrap rounded bg-accent/40 p-2 font-mono text-[12px] text-destructive">
              {actionError}
            </pre>
          ) : null}
          <div className="w-full">
            <div className="flex w-full flex-wrap gap-2">
              {verbs.map((verb) => {
                const authority = authorities[verb];
                const disabled = running || !authority.allowed;
                return (
                  <Button
                    key={verb}
                    type="button"
                    size="sm"
                    // The armed verb IS the two-click confirm: the second
                    // click targets board-confirm (design.md section 3.7).
                    data-uat={
                      armed === verb ? "board-confirm" : VERB_UAT_IDS[verb]
                    }
                    data-uat-key={verb}
                    variant={armed === verb ? "destructive" : "outline"}
                    disabled={disabled}
                    aria-disabled={disabled || undefined}
                    title={
                      disabled && authority.reason ? authority.reason : undefined
                    }
                    onClick={() => runAction(verb)}
                    className="text-[12px]"
                  >
                    {armed === verb
                      ? `${VERB_LABELS[verb]}: click again`
                      : VERB_LABELS[verb]}
                  </Button>
                );
              })}
              {armed ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-uat="board-cancel"
                  onClick={disarm}
                  className="text-[12px]"
                >
                  Cancel
                </Button>
              ) : null}
            </div>
            {reasonLine ? (
              <p className="mt-2 text-[12px] text-muted-foreground">
                {reasonLine}
              </p>
            ) : null}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
