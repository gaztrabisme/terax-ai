// @vitest-environment jsdom
import { Editor } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { autolinkable, composerExtensions } from "./Composer";

// @tiptap/core is not a direct dependency, but @tiptap/react re-exports it
// (the same route editorSchema.test.ts uses for getSchema), so Editor here is
// the headless core editor running on jsdom's document.

describe("autolinkable", () => {
  it("rejects bare filenames and accepts real URLs", () => {
    expect(autolinkable("CLAUDE.md")).toBe(false);
    expect(autolinkable("README.md")).toBe(false);
    expect(autolinkable("foo.bar")).toBe(false);
    expect(autolinkable("https://example.com/x")).toBe(true);
    expect(autolinkable("www.example.com")).toBe(true);
  });
});

type JsonNode = {
  type: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: JsonNode[];
};

// Integration: the changed range must end in whitespace for the autolink
// plugin's appendTransaction to fire, which is why typing a trailing space is
// what triggers the link; insert the whole sentence in one transaction and
// let appendTransaction do what typing the space would do.
describe("composerExtensions autolink", () => {
  it("links the URL and leaves CLAUDE.md as plain text", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = new Editor({
      extensions: composerExtensions(),
      element,
      content: "",
    });
    try {
      editor.commands.insertContent("see CLAUDE.md and https://example.com/x ");

      const json = editor.getJSON() as JsonNode;
      const texts: { text: string; links: string[] }[] = [];
      const walk = (node: JsonNode) => {
        const links = (node.marks ?? [])
          .filter((mark) => mark.type === "link")
          .map((mark) => String(mark.attrs?.href));
        if (node.text !== undefined) texts.push({ text: node.text, links });
        for (const child of node.content ?? []) walk(child);
      };
      walk(json);

      const marked = texts.filter((entry) => entry.links.length > 0);
      expect(marked).toHaveLength(1);
      expect(marked[0].text).toBe("https://example.com/x");
      expect(marked[0].links).toEqual(["https://example.com/x"]);

      const plain = texts
        .filter((entry) => entry.links.length === 0)
        .map((entry) => entry.text)
        .join("");
      expect(plain).toContain("see CLAUDE.md and ");

      // The serializer behind editor.getMarkdown() on submit: the URL renders
      // as a link, CLAUDE.md stays literal.
      expect(editor.getMarkdown()).toBe(
        "see CLAUDE.md and [https://example.com/x](https://example.com/x) ",
      );
    } finally {
      editor.destroy();
      element.remove();
    }
  });
});