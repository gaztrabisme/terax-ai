import { afterEach, describe, expect, it } from "vitest";
import {
  FallbackPartRenderer,
  panelForTool,
  registerPartRenderer,
  registerPiPanel,
  rendererForPart,
} from "./registry";

afterEach(() => {
  viRestore();
});

function viRestore() {
  unregisterPart?.();
  unregisterPart = undefined;
  unregisterPanel?.();
  unregisterPanel = undefined;
}

let unregisterPart: (() => void) | undefined;
let unregisterPanel: (() => void) | undefined;

describe("renderer registry", () => {
  it("resolves built-in content type renderers", () => {
    expect(rendererForPart("text")).not.toBe(FallbackPartRenderer);
    expect(rendererForPart("code")).not.toBe(FallbackPartRenderer);
    expect(rendererForPart("csv")).not.toBe(FallbackPartRenderer);
  });

  it("falls back gracefully for unknown content types", () => {
    expect(rendererForPart("spreadsheet-xml")).toBe(FallbackPartRenderer);
  });

  it("registers and unregisters a content type", () => {
    const custom = () => null;
    unregisterPart = registerPartRenderer("markdown_table", custom);
    expect(rendererForPart("markdown_table")).toBe(custom);
    unregisterPart();
    expect(rendererForPart("markdown_table")).toBe(FallbackPartRenderer);
  });

  it("registers and unregisters a tool panel manifest", () => {
    unregisterPanel = registerPiPanel({
      toolName: "bash",
      renderer: () => null,
    });
    expect(panelForTool("bash")?.toolName).toBe("bash");
    unregisterPanel();
    expect(panelForTool("bash")).toBeNull();
  });

  it("unregister does not remove a later registration for the same tool", () => {
    const first = registerPiPanel({ toolName: "ask", renderer: () => null });
    const second = registerPiPanel({ toolName: "ask", renderer: () => null });
    first();
    expect(panelForTool("ask")?.toolName).toBe("ask");
    second();
    second();
  });
});
