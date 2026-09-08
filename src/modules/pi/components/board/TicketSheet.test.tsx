// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});

afterEach(() => cleanup());

/** Verb buttons carry their canonical uat id, so query by attribute: the
 * sheet's own X control is also named "Close" for role queries. */
function verbButton(uatId: string): HTMLElement {
  const el = document.body.querySelector(`[data-uat="${uatId}"]`);
  if (!el) throw new Error(`missing [data-uat=${uatId}]`);
  return el as HTMLElement;
}

function renderSheet(ticketId: string, onRefresh = vi.fn()) {
  render(
    <TicketSheet
      cwd="/proj"
      boardBin=""
      ticketId={ticketId}
      onOpenChange={() => {}}
      onRefresh={onRefresh}
    />,
  );
  return onRefresh;
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

    // The aligned-attempt gate is the harness reason, verbatim gate name.
    const rework = verbButton("board-rework");
    expect((rework as HTMLButtonElement).disabled).toBe(true);
    expect(rework.getAttribute("title")).toBe("Rework needs criteria_confirmed");

    // One muted line carries every disabled verb's reason, in button order.
    const line = screen.getByText(
      "Land is not offered from Todo · Close is not offered from Todo · Rework needs criteria_confirmed",
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
    expect(close.getAttribute("title")).toBe("Close needs resolved, wiki-close");
    // One muted line, in button order: align is not a review successor.
    expect(
      screen.getByText(
        "Align is not offered from Review · Close needs resolved, wiki-close",
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

    // The armed button is the two-click confirm target.
    const confirm = await screen.findByRole("button", {
      name: "Align: click again",
    });
    expect(confirm.getAttribute("data-uat")).toBe("board-confirm");
    fireEvent.click(confirm);

    const refusal = await screen.findByText(
      "error: align refused: attempt 0 has no criteria_confirmed pass",
    );
    expect(refusal).not.toBeNull();
  });
});

describe("TicketSheet two-click arm", () => {
  it("runs the action only on the second click and cancel disarms", async () => {
    const onRefresh = renderSheet("aa");
    const align = await loadedButton(/^Align$/);
    expect(align.getAttribute("data-uat")).toBe("board-align");

    // First click arms; no command runs yet.
    fireEvent.click(align);
    const confirm = screen.getByRole("button", { name: "Align: click again" });
    expect(confirm.getAttribute("data-uat")).toBe("board-confirm");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("data-uat")).toBe("board-cancel");
    const actionCalls = invokeMock.mock.calls.filter(
      ([cmd, args]) =>
        cmd === "shell_run_command" &&
        !(args as { command?: string })?.command?.includes(" --json"),
    );
    expect(actionCalls).toHaveLength(0);

    // Cancel disarms without running anything.
    fireEvent.click(cancel);
    expect(screen.getByRole("button", { name: "Align" }).getAttribute("data-uat")).toBe(
      "board-align",
    );

    // Second click on the verb commits.
    fireEvent.click(screen.getByRole("button", { name: "Align" }));
    fireEvent.click(screen.getByRole("button", { name: "Align: click again" }));
    await waitFor(() => {
      const runs = invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "shell_run_command" &&
          !(args as { command?: string })?.command?.includes(" --json"),
      );
      expect(runs).toHaveLength(1);
      expect((runs[0][1] as { command: string }).command).toBe(
        "HARNESS_DB='/proj/.pi/board.db' '/bin/agent' align 'aa'",
      );
      expect(onRefresh).toHaveBeenCalled();
    });
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
    expect(wiki?.textContent).toContain("wiki-close");
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
