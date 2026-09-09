// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChildStore } from "@/modules/pi/lib/childStore";
import {
  actionRecord,
  ledgerSnapshot,
} from "@/modules/pi/lib/__fixtures__/ledger";
import { ledgerPath, useLedgerStore } from "@/modules/pi/lib/ledgerStore";
import { initialPiSessionState } from "@/modules/pi/lib/parse";
import { TicketSheet } from "./TicketSheet";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// A todo build ticket's authority is the harness's own K12a example: align is
// the only allowed action (its human gate is a reason, never a blocker) and
// rework is refused until an aligned attempt exists.
const TODO_TICKET = {
  id: "aa",
  kind: "build",
  status: "todo",
  attempt: 0,
  title: "Build the rail",
  priority: 2,
  created_at: null,
  updated_at: null,
  red_gates: 0,
  workpad: {
    plan: "plan",
    criteria: "criteria",
    validation: "bin/pi --mode rpc",
    notes: null,
    confusions: [],
  },
  gates: [],
  allowedActions: [
    { action: "align", allowed: true, reasons: ["criteria_confirmed"] },
    { action: "rework", allowed: false, reasons: ["criteria_confirmed"] },
  ],
};

// K12a + R6.3: close from review is red while the dated wiki-close pass is
// missing, with both reasons named; land stays a legal human decision.
const REVIEW_TICKET = {
  id: "wc",
  kind: "research",
  status: "review",
  attempt: 1,
  title: "Wiki the close",
  priority: 1,
  created_at: null,
  updated_at: null,
  red_gates: 1,
  workpad: null,
  gates: [
    {
      id: 1,
      gate: "tests_green",
      passed: true,
      provider: "bash",
      source: "machine",
      attempt: 1,
      note: "exit 0",
      created_at: "2026-09-08 10:00:00",
    },
    {
      id: 2,
      gate: "wiki-close",
      passed: false,
      provider: "board",
      source: "machine",
      attempt: 1,
      note: "no entry yet",
      created_at: "2026-09-08 10:01:00",
    },
  ],
  allowedActions: [
    { action: "land", allowed: true, reasons: ["landed"] },
    { action: "close", allowed: false, reasons: ["resolved", "wiki-close"] },
    { action: "rework", allowed: true, reasons: [] },
  ],
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
    if (cmd === "pi_paths") {
      return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
    }
    const command = args?.command ?? "";
    if (command.includes(" --json")) {
      return { stdout: JSON.stringify(TODO_TICKET), stderr: "", exit_code: 0 };
    }
    return { stdout: "", stderr: "", exit_code: 0 };
  });
  useLedgerStore.setState({ sessions: {} });
  useChildStore.getState().reset();
});

afterEach(() => cleanup());

/** Verb buttons carry their canonical uat id, so query by attribute: the
 * sheet's own X control is also named "Close" for role queries. */
function verbButton(uatId: string): HTMLElement {
  const el = document.body.querySelector(`[data-uat="${uatId}"]`);
  if (!el) throw new Error(`missing [data-uat=${uatId}]`);
  return el as HTMLElement;
}

function renderSheet(
  ticketId: string,
  onRefresh = vi.fn(),
  onOpenChild = vi.fn(),
) {
  render(
    <TicketSheet
      cwd="/proj"
      boardBin=""
      ticketId={ticketId}
      sessionId="session-1"
      onOpenChild={onOpenChild}
      onOpenChange={() => {}}
      onRefresh={onRefresh}
    />,
  );
  return { onRefresh, onOpenChild };
}

function actionRuns() {
  return invokeMock.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "shell_run_command" &&
      !(args as { command?: string })?.command?.includes(" --json"),
  );
}

/** Seeds the ledger and the child store with one delegation for ticket aa. */
function seedChildRun(
  record: Partial<ReturnType<typeof actionRecord>> = {},
  childStatus?: "thinking" | "done",
) {
  const transcript = "/proj/.pi/agent-hub/run-1/worker-1.transcript.jsonl";
  useLedgerStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [ledgerPath("/proj", "session-1")]: ledgerSnapshot([
        actionRecord({
          ticketId: "aa",
          sessionId: "session-1",
          evidencePath: transcript,
          ...record,
        }),
      ]),
    },
  }));
  if (childStatus) {
    useChildStore.setState((s) => ({
      children: {
        ...s.children,
        [transcript]: {
          ...initialPiSessionState(),
          status: childStatus,
        },
      },
    }));
  }
}

async function loadedButton(name: RegExp | string) {
  return screen.findByRole("button", { name });
}

describe("TicketSheet harness authority", () => {
  it("enables verbs from allowedActions and names disabled reasons", async () => {
    renderSheet("aa");
    const align = await loadedButton(/^Align$/);
    expect((align as HTMLButtonElement).disabled).toBe(false);

    // Not spine successors of todo: the harness offers no entry.
    const land = verbButton("board-land");
    expect((land as HTMLButtonElement).disabled).toBe(true);
    expect(land.getAttribute("aria-disabled")).toBe("true");
    expect(land.getAttribute("title")).toBe("Land is not offered from Todo");
    const close = verbButton("board-close");
    expect((close as HTMLButtonElement).disabled).toBe(true);
    expect(close.getAttribute("title")).toBe("Close is not offered from Todo");

    // The harness reason uses the readable gate label.
    const rework = verbButton("board-rework");
    expect((rework as HTMLButtonElement).disabled).toBe(true);
    expect(rework.getAttribute("title")).toBe("Rework needs Criteria confirmed");

    // One muted line carries every disabled verb's reason, in button order.
    const line = screen.getByText(
      "Land is not offered from Todo · Close is not offered from Todo · Rework needs Criteria confirmed",
    );
    expect(line).not.toBeNull();
  });

  it("disables close with the shared reason list while wiki-close is red", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "pi_paths") {
        return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
      }
      const command = args?.command ?? "";
      if (command.includes(" --json")) {
        return { stdout: JSON.stringify(REVIEW_TICKET), stderr: "", exit_code: 0 };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    renderSheet("wc");
    await loadedButton(/^Land$/);

    const close = verbButton("board-close");
    expect((close as HTMLButtonElement).disabled).toBe(true);
    expect(close.getAttribute("aria-disabled")).toBe("true");
    expect(close.getAttribute("title")).toBe("Close needs resolved, Wiki close");
    // One muted line, in button order: align is not a review successor.
    expect(
      screen.getByText(
        "Align is not offered from Review · Close needs resolved, Wiki close",
      ),
    ).not.toBeNull();

    // land is a legal human decision from review: enabled, no refusal title.
    expect((screen.getByRole("button", { name: "Land" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Land" }).getAttribute("title")).toBeNull();
  });

  it("renders the refusal stderr verbatim when a run verb fails", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "pi_paths") {
        return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
      }
      const command = args?.command ?? "";
      if (command.includes(" --json")) {
        return { stdout: JSON.stringify(TODO_TICKET), stderr: "", exit_code: 0 };
      }
      return {
        stdout: "",
        stderr: "error: align refused: attempt 0 has no criteria_confirmed pass",
        exit_code: 1,
      };
    });
    renderSheet("aa");
    const align = await loadedButton(/^Align$/);
    fireEvent.click(align);

    // The confirmation area names the exact transition; its Confirm commits.
    const area = document.body.querySelector('[data-uat="board-confirm-area"]')!;
    expect(area.getAttribute("aria-label")).toBe("Confirm Align");
    expect(area.textContent).toContain("aa: todo to in_progress through align");
    fireEvent.click(area.querySelector('[data-uat="board-confirm"]')!);

    const refusal = await screen.findByText(
      "error: align refused: attempt 0 has no criteria_confirmed pass",
    );
    expect(refusal).not.toBeNull();
  });

  it("gives the two Close controls distinct contextual names (UX-15)", async () => {
    renderSheet("aa");
    await loadedButton(/^Align$/);

    // The board verb: accessible name "Close ticket", visible text unchanged;
    // while the harness refuses, the tooltip still carries the reason.
    const close = verbButton("board-close");
    expect(close.getAttribute("aria-label")).toBe("Close ticket");
    expect(close.textContent).toBe("Close");
    expect(close.getAttribute("title")).toBe("Close is not offered from Todo");

    // The sheet's dismiss: "Close sheet", name and tooltip agree.
    const dismiss = document.body.querySelector(
      "button[aria-label='Close sheet']",
    );
    expect(dismiss).not.toBeNull();
    expect(dismiss!.getAttribute("title")).toBe("Close sheet");
  });

  it("titles an enabled Close verb Close ticket", async () => {
    const DONE_TICKET = {
      ...TODO_TICKET,
      id: "dd",
      status: "done",
      allowedActions: [{ action: "close", allowed: true, reasons: [] }],
    };
    invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "pi_paths") {
        return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
      }
      const command = args?.command ?? "";
      if (command.includes(" --json")) {
        return { stdout: JSON.stringify(DONE_TICKET), stderr: "", exit_code: 0 };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    renderSheet("dd");
    const close = await verbButton("board-close");
    await waitFor(() => {
      expect((close as HTMLButtonElement).disabled).toBe(false);
    });
    expect(close.getAttribute("aria-label")).toBe("Close ticket");
    expect(close.getAttribute("title")).toBe("Close ticket");
  });
});

describe("TicketSheet arm and confirm", () => {
  it("commits only through the confirmation area; Cancel disarms", async () => {
    const { onRefresh } = renderSheet("aa");
    const align = await loadedButton(/^Align$/);
    expect(align.getAttribute("data-uat")).toBe("board-align");

    // First click arms: the stable area names the ticket, the exact
    // transition and the harness consequences; no command runs yet.
    fireEvent.click(align);
    const area = document.body.querySelector('[data-uat="board-confirm-area"]')!;
    expect(area.getAttribute("aria-label")).toBe("Confirm Align");
    expect(area.textContent).toContain("aa: todo to in_progress through align");
    expect(area.textContent).toContain("Consequences: Criteria confirmed");
    const confirm = area.querySelector('[data-uat="board-confirm"]')!;
    expect(confirm.textContent).toBe("Confirm");
    const cancel = area.querySelector('[data-uat="board-cancel"]')!;
    expect(cancel.textContent).toBe("Cancel");
    expect(actionRuns()).toHaveLength(0);

    // A repeat click on the armed verb itself commits nothing.
    fireEvent.click(screen.getByRole("button", { name: "Align" }));
    expect(actionRuns()).toHaveLength(0);

    // Cancel disarms without running anything.
    fireEvent.click(cancel);
    expect(
      document.body.querySelector('[data-uat="board-confirm-area"]'),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Align" }).getAttribute("data-uat")).toBe(
      "board-align",
    );

    // Arm again and Confirm commits once.
    fireEvent.click(screen.getByRole("button", { name: "Align" }));
    fireEvent.click(
      document.body.querySelector('[data-uat="board-confirm"]')!,
    );
    await waitFor(() => {
      const runs = actionRuns();
      expect(runs).toHaveLength(1);
      expect((runs[0][1] as { command: string }).command).toBe(
        "HARNESS_DB='/proj/.pi/board.db' '/bin/agent' align 'aa'",
      );
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("names the rework worktree cleanup in the consequences", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "pi_paths") {
        return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
      }
      const command = args?.command ?? "";
      if (command.includes(" --json")) {
        return { stdout: JSON.stringify(REWORKABLE_TICKET), stderr: "", exit_code: 0 };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    renderSheet("rr");
    fireEvent.click(await loadedButton(/^Rework$/));
    const area = document.body.querySelector('[data-uat="board-confirm-area"]')!;
    expect(area.textContent).toContain(
      "Consequences: none recorded by the harness; Rework cleans up the attempt worktree before the next aligned attempt.",
    );
  });

  it("Escape cancels the armed action and keeps the sheet open", async () => {
    renderSheet("aa");
    fireEvent.click(await loadedButton(/^Align$/));
    expect(
      document.body.querySelector('[data-uat="board-confirm-area"]'),
    ).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(
      document.body.querySelector('[data-uat="board-confirm-area"]'),
    ).toBeNull();
    expect(document.body.querySelector('[data-uat="ticket-sheet"]')).not.toBeNull();
    expect(actionRuns()).toHaveLength(0);
  });
});

// A rework the harness allows with no reasons recorded: the area must still
// explain the worktree cleanup before confirmation (design.md section 3.2).
const REWORKABLE_TICKET = {
  ...TODO_TICKET,
  id: "rr",
  status: "in_progress",
  allowedActions: [
    { action: "rework", allowed: true, reasons: [] },
    { action: "align", allowed: false, reasons: ["resolved"] },
  ],
};

describe("TicketSheet run summary", () => {
  it("names a running child, its agent and elapsed time, with a transcript link", () => {
    seedChildRun(
      {
        actionId: "run-1",
        status: "running",
        endedAt: null,
        durationMs: null,
        startedAt: new Date(Date.now() - 5000).toISOString(),
      },
      "thinking",
    );
    const { onOpenChild } = renderSheet("aa");

    const summary = document.body.querySelector('[data-uat="ticket-run-summary"]')!;
    expect(summary.textContent).toContain("Running");
    expect(summary.textContent).toContain("worker-1");
    expect(summary.textContent).toContain("5.0s");
    const link = summary.querySelector('[data-uat="child-open-transcript-link"]')!;
    expect(link.textContent).toBe("Open transcript");
    fireEvent.click(link);
    expect(onOpenChild).toHaveBeenCalledWith(
      "/proj/.pi/agent-hub/run-1/worker-1.transcript.jsonl",
    );
  });

  it("shows a finished run from the record and no link without a transcript", () => {
    seedChildRun({
      actionId: "run-2",
      status: "done",
      evidencePath: null,
    });
    renderSheet("aa");
    const summary = document.body.querySelector('[data-uat="ticket-run-summary"]')!;
    expect(summary.textContent).toContain("Done");
    expect(summary.textContent).toContain("worker-1");
    expect(summary.textContent).toContain("2.5s");
    expect(summary.querySelector('[data-uat="child-open-transcript-link"]')).toBeNull();
  });

  it("reports no child run without a delegation record", () => {
    renderSheet("aa");
    const summary = document.body.querySelector('[data-uat="ticket-run-summary"]')!;
    expect(summary.textContent).toContain("No child run for this ticket");
    expect(summary.querySelector('[data-uat="child-open-transcript-link"]')).toBeNull();
  });
});

// The committed state lives in the database, not in this sheet's memory
// (UX-11): a confirmed action refetches the exact ticket at once, holds a
// pending state on the verbs, then shows the committed state and gates or
// the harness error.
const ALIGNED_TICKET = {
  ...TODO_TICKET,
  status: "in_progress",
  attempt: 1,
  gates: [
    {
      id: 1,
      gate: "criteria_confirmed",
      passed: true,
      provider: "human",
      source: "human",
      attempt: 1,
      note: "confirmed in the sheet",
      created_at: "2026-09-09 09:00:00",
    },
  ],
  allowedActions: [
    { action: "land", allowed: false, reasons: ["resolved"] },
    { action: "rework", allowed: true, reasons: [] },
  ],
};

function showSequence(responses: (() => Promise<unknown>)[]) {
  let call = 0;
  invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
    if (cmd === "pi_paths") {
      return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
    }
    if (cmd !== "shell_run_command" || !(args?.command ?? "").includes(" --json")) {
      return { stdout: "", stderr: "", exit_code: 0 };
    }
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next();
  });
}

describe("TicketSheet refetch after a confirmed action", () => {
  it("refetches the ticket at once and holds a pending state until it returns", async () => {
    let release: ((value: unknown) => void) | null = null;
    showSequence([
      () => Promise.resolve({ stdout: JSON.stringify(TODO_TICKET), stderr: "", exit_code: 0 }),
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      () => Promise.resolve({ stdout: JSON.stringify(ALIGNED_TICKET), stderr: "", exit_code: 0 }),
    ]);
    renderSheet("aa");
    fireEvent.click(await loadedButton(/^Align$/));
    fireEvent.click(document.body.querySelector('[data-uat="board-confirm"]')!);

    // The verbs show pending until the refetched ticket arrives.
    const pending = await screen.findByRole("button", { name: "Align pending" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(pending.getAttribute("data-pending")).toBe("true");
    // The stale Todo view is still on screen while the refetch is in flight.
    expect(screen.getByText("Todo")).toBeTruthy();

    await act(async () => {
      release?.({ stdout: JSON.stringify(ALIGNED_TICKET), stderr: "", exit_code: 0 });
    });

    // The committed state and its gates replace the stale view (the header
    // span names the state and attempt; the reason line also mentions states,
    // so match the header text).
    expect(await screen.findByText(/In progress · attempt 1/)).toBeTruthy();
    const gate = document.body.querySelector('[data-uat="ticket-gate"]');
    expect(gate?.textContent).toContain("criteria_confirmed");
    expect(gate?.textContent).toContain("pass");
    expect(screen.queryByRole("button", { name: "Align pending" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Align" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the harness error when the refetch after a confirmed action fails", async () => {
    showSequence([
      () => Promise.resolve({ stdout: JSON.stringify(TODO_TICKET), stderr: "", exit_code: 0 }),
      () =>
        Promise.resolve({
          stdout: "",
          stderr: "error: cannot read ticket aa",
          exit_code: 1,
        }),
    ]);
    renderSheet("aa");
    fireEvent.click(await loadedButton(/^Align$/));
    fireEvent.click(document.body.querySelector('[data-uat="board-confirm"]')!);

    // The refetch here returns within a microtask, so the pending window is
    // too short to poll; the held-pending behavior is asserted in the test
    // above. Wait for the harness error, then for the pending state to clear.
    const failure = await screen.findByText("error: cannot read ticket aa");
    expect(failure).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Align pending" })).toBeNull(),
    );
  });
});

describe("TicketSheet gates and acceptance ids", () => {
  it("marks the validation section, keyed gate rows and the wiki-close verdict", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { command?: string }) => {
      if (cmd === "pi_paths") {
        return { agent: { path: "/bin/agent", source: "bundled", candidates: [] } };
      }
      const command = args?.command ?? "";
      if (command.includes(" --json")) {
        return { stdout: JSON.stringify(REVIEW_TICKET), stderr: "", exit_code: 0 };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    renderSheet("wc");
    await loadedButton(/^Land$/);

    // Acceptance section carries the stored validation command.
    const acceptance = document.body.querySelector('[data-uat="ticket-acceptance"]');
    expect(acceptance).not.toBeNull();
    // The review ticket's stored validation is empty, so the section reads None.
    expect(acceptance?.textContent).toContain("None");

    // One row per gate name, keyed, with source and latest verdict.
    const rows = document.body.querySelectorAll('[data-uat="ticket-gate"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-uat-key")).toBe("tests_green");
    expect(rows[0].textContent).toContain("pass");
    expect(rows[0].textContent).toContain("machine/bash");
    expect(rows[1].getAttribute("data-uat-key")).toBe("wiki-close");
    expect(rows[1].textContent).toContain("fail");

    // The wiki-close verdict is its own named row.
    const wiki = document.body.querySelector('[data-uat="ticket-wiki-close"]');
    expect(wiki).not.toBeNull();
    expect(wiki?.textContent).toContain("Wiki close");
    expect(wiki?.textContent).toContain("fail");
    // The evidence itself stays on the keyed gate row.
    expect(rows[1].textContent).toContain("no entry yet");
  });

  it("reports no wiki-close verdict when the ticket has none", async () => {
    renderSheet("aa");
    await loadedButton(/^Align$/);
    const wiki = document.body.querySelector('[data-uat="ticket-wiki-close"]');
    expect(wiki).not.toBeNull();
    expect(wiki?.textContent).toContain("no verdict recorded");
  });
});

it("separates readable gate labels from identifiers and human or machine sources", async () => {
  const ticket = { ...REVIEW_TICKET, gates: [...REVIEW_TICKET.gates, {
    id: 3, gate: "criteria_confirmed", passed: true, provider: "gary", source: "human",
    attempt: 1, note: "Confirmed", created_at: "2026-09-09",
  }] };
  invokeMock.mockImplementation(async (cmd: string) => cmd === "pi_paths"
    ? { agent: { path: "/bin/agent", source: "bundled", candidates: [] } }
    : { stdout: JSON.stringify(ticket), stderr: "", exit_code: 0 });
  renderSheet("wc");
  await waitFor(() => expect(screen.getByText("Criteria confirmed")).toBeTruthy());
  for (const [id, label, source] of [
    ["criteria_confirmed", "Criteria confirmed", "human/gary"],
    ["tests_green", "Tests green", "machine/bash"],
    ["wiki-close", "Wiki close", "machine/board"],
  ]) {
    const row = document.querySelector(`[data-uat="ticket-gate"][data-uat-key="${id}"]`)!;
    expect(row.firstElementChild?.textContent).toContain(label);
    expect(row.firstElementChild?.textContent).not.toContain(id);
    expect(row.querySelector("p")?.textContent).toContain(`${id} · Source: ${source}`);
    expect(row.querySelector("button")).toBeNull();
  }
});
