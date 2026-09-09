import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PiToolBlock } from "@/modules/pi/lib/parse";
import { ToolRow, toolFamilyIcon, toolSummary } from "./ToolRow";

function toolBlock(over: Partial<PiToolBlock> = {}): PiToolBlock {
  return {
    kind: "tool",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "echo hi" },
    status: "done",
    partialText: "hi\n",
    resultText: "hi\n",
    isError: false,
    at: 0,
    ...over,
  };
}

describe("ToolStep fold state", () => {
  it("is folded by default: icon family, name and one-line summary visible", () => {
    const html = renderToStaticMarkup(<ToolRow block={toolBlock()} />);
    expect(html).toContain("bash");
    expect(html).toContain("echo hi");
    // Folded shows the summary only: no args panel, no full result body.
    expect(html).not.toContain("Args");
    expect(html).not.toContain("Result");
  });

  it("expanded shows the args and the result body", () => {
    const html = renderToStaticMarkup(
      <ToolRow block={toolBlock()} defaultOpen />,
    );
    expect(html).toContain("Args");
    expect(html).toContain("echo hi");
    expect(html).toContain("Result");
    expect(html).toContain("hi");
  });

  it("running rows show a live status and no result yet", () => {
    const html = renderToStaticMarkup(
      <ToolRow
        block={toolBlock({
          status: "running",
          resultText: null,
          partialText: "working output here",
        })}
      />
    );
    expect(html).toContain("running");
    expect(html).not.toContain("Result");
  });

  it("summaries fall back to the result text when args carry nothing", () => {
    const block = toolBlock({ args: {}, resultText: "line one\nline two" });
    expect(toolSummary(block)).toBe("line one");
  });

  it("icons follow the tool family", () => {
    // Unknown tools keep the generic wrench; families map to their own icon.
    expect(toolFamilyIcon("bash")).not.toBe(toolFamilyIcon("read"));
    expect(toolFamilyIcon("mystery_tool")).toBeTruthy();
  });
});

// The K7C K12 refusal, verbatim as the gate writes it into the tool result.
const REFUSAL =
  "Tool execution blocked: unticketed-action: board_start refused: delegation needs status in_progress (ticket t2, state todo). permission log: /private/tmp/standalone-proj/.pi/logs/session.jsonl";

describe("ToolStep refusal (K7C K12)", () => {
  const refused = toolBlock({
    toolName: "board_start",
    args: { id: "t2" },
    status: "refused",
    partialText: null,
    resultText: REFUSAL,
    isError: false,
  });

  it("folded row shows the muted refused mark and the refused title", () => {
    const html = renderToStaticMarkup(<ToolRow block={refused} />);
    expect(html).toContain("board_start refused");
    expect(html).toContain('aria-label="refused"');
    // Neither the green done mark nor the red error mark.
    expect(html).not.toContain('aria-label="done"');
    expect(html).not.toContain('aria-label="error"');
    expect(html).not.toContain("text-green-600");
    expect(html).not.toContain("text-destructive");
  });

  it("expanded row shows the reason verbatim and the copyable log path", () => {
    const html = renderToStaticMarkup(<ToolRow block={refused} defaultOpen />);
    expect(html).toContain("Tool execution blocked: unticketed-action");
    expect(html).toContain(
      "/private/tmp/standalone-proj/.pi/logs/session.jsonl",
    );
    expect(html).toContain('aria-label="Copy permission log path"');
    expect(html).toContain('data-uat="refusal-copy-log"');
  });

  it("a refusal that names no log path shows no copy control", () => {
    const html = renderToStaticMarkup(
      <ToolRow
        block={toolBlock({
          status: "refused",
          partialText: null,
          resultText:
            "Tool execution blocked: unticketed-action: board_new refused",
        })}
        defaultOpen
      />,
    );
    expect(html).toContain("Tool execution blocked");
    expect(html).not.toContain('aria-label="Copy permission log path"');
  });

  it("done rows keep the green mark and the plain title", () => {
    const html = renderToStaticMarkup(
      <ToolRow block={toolBlock({ toolName: "bash" })} />,
    );
    expect(html).toContain('aria-label="done"');
    expect(html).toContain("bash");
    expect(html).not.toContain("bash refused");
  });
});
