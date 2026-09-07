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
