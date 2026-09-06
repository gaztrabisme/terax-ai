import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PiToolBlock } from "@/modules/pi/lib/parse";
import { ToolRow, tokenEstimate } from "./ToolRow";

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
    ...over,
  };
}

describe("ToolRow fold state", () => {
  it("is folded by default: name and estimate visible, result hidden", () => {
    const html = renderToStaticMarkup(<ToolRow block={toolBlock()} />);
    expect(html).toContain("bash");
    expect(html).toContain("~1 tok");
    // Folded shows a one-line preview only: no args panel, no full result.
    expect(html).not.toContain("echo hi");
    expect(html).not.toContain("args:");
  });

  it("expanded shows the args and the full result text", () => {
    const html = renderToStaticMarkup(
      <ToolRow block={toolBlock()} defaultOpen />,
    );
    expect(html).toContain("echo hi");
    expect(html).toContain("hi");
  });

  it("running rows show the partial output estimate, no result", () => {
    const html = renderToStaticMarkup(
      <ToolRow
        block={toolBlock({
          status: "running",
          resultText: null,
          partialText: "working output here",
        })}
      />,
    );
    expect(html).toContain("...");
    expect(html).toContain("work");
  });

  it("token estimate is ceil(chars/4), minimum 1", () => {
    expect(tokenEstimate(null)).toBe(1);
    expect(tokenEstimate("")).toBe(1);
    expect(tokenEstimate("ab")).toBe(1);
    expect(tokenEstimate("abcde")).toBe(2);
  });
});
