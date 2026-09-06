import { describe, expect, it } from "vitest";
// Table fidelity spike (R6 quote-required item 4): @tiptap/extension-table
// 3.31.x ships renderTableToMarkdown and a GFM pipe tokenizer, wired through
// the MarkdownManager's renderMarkdown/markdownTokenizer extension fields.
// This exercises the upstream serializer directly with a minimal fake node,
// which is exactly what editor.getMarkdown() delegates to for table nodes.
import { renderTableToMarkdown } from "@tiptap/extension-table";

type FakeNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: FakeNode[];
  text?: string;
};

type TableRenderer = typeof renderTableToMarkdown;
type RendererNode = Parameters<TableRenderer>[0];
type RendererHelpers = Parameters<TableRenderer>[1];

function render(node: FakeNode, _h?: unknown): string {
  return renderTableToMarkdown(
    node as unknown as RendererNode,
    h as unknown as RendererHelpers,
  );
}

function frag(children: FakeNode[]) {
  let i = 0;
  return {
    length: children.length,
    forEach(fn: (child: FakeNode) => void) {
      while (i < children.length) fn(children[i]);
      i += 1;
    },
  };
}
void frag;

function cell(
  type: "tableCell" | "tableHeader",
  text: string,
  align?: string,
): FakeNode {
  return {
    type,
    ...(align ? { attrs: { align } } : {}),
    content: [{ type: "text", text }],
  };
}

function table(rows: FakeNode[][]): FakeNode {
  return {
    type: "table",
    attrs: {},
    content: rows.map((cells) => ({
      type: "tableRow",
      attrs: {},
      content: cells,
    })),
  };
}

// renderChildren receives the cell's child list; text children carry .text.
const h = {
  renderChildren: (content: FakeNode[] | unknown): string =>
    Array.isArray(content)
      ? content.map((c) => String((c as { text?: string }).text ?? "")).join("")
      : "",
};

describe("table fidelity: schema to GFM markdown", () => {
  it("serializes a header table to a GFM pipe table", () => {
    const md = render(
      table([
        [cell("tableHeader", "Name"), cell("tableHeader", "Qty")],
        [cell("tableCell", "Widget"), cell("tableCell", "4")],
      ]),
      h,
    );
    expect(md).toBe("\n| Name   | Qty |\n| ------ | --- |\n| Widget | 4   |\n");
  });

  it("round-trips a pasted (Google Docs style) table without losing structure", () => {
    // What the schema looks like after parseHTML swallows an HTML <table>
    // paste: 3 columns with a header row.
    const pasted = table([
      [
        cell("tableHeader", "Task"),
        cell("tableHeader", "Owner"),
        cell("tableHeader", "Done"),
      ],
      [
        cell("tableCell", "ship"),
        cell("tableCell", "gary"),
        cell("tableCell", "yes"),
      ],
    ]);
    const md = render(pasted, h);
    const lines = md.trim().split("\n");
    expect(lines).toEqual([
      "| Task | Owner | Done |",
      "| ---- | ----- | ---- |",
      "| ship | gary  | yes  |",
    ]);
  });

  it("encodes left alignment in the delimiter row", () => {
    const md = render(
      table([
        [cell("tableHeader", "A"), cell("tableHeader", "B")],
        [cell("tableCell", "1", "left"), cell("tableCell", "2")],
      ]),
      h,
    );
    expect(md).toContain("| :--- | --- |");
  });

  it("returns empty for a table with no rows", () => {
    expect(render(table([]), h)).toBe("");
  });
});
