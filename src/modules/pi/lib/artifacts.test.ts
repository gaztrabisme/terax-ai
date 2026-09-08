import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CSP,
  artifactCspMeta,
  attachmentExtensionFromMediaType,
  attachmentFileName,
  artifactFileName,
  detectArtifacts,
  fencedBlocks,
  htmlDataUrl,
  imageExtensionFromDataUrl,
  injectCsp,
  turnFileName,
  viewerDocument,
  type ArtifactDoc,
} from "./artifacts";

const GROUPED_MD = [
  "Here is a small page.",
  "",
  "```html",
  "<!doctype html>",
  "<html>",
  "<head><title>Dot grid</title></head>",
  '<body><div id="app"></div></body>',
  "</html>",
  "```",
  "",
  "```css",
  "body { background: #111; }",
  "```",
  "",
  "```js",
  "console.log(1);",
  "```",
].join("\n");

describe("detectArtifacts grouping", () => {
  it("folds sibling css and js blocks into the html document", () => {
    const artifacts = detectArtifacts(GROUPED_MD);
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    expect(artifact.kind).toBe("html");
    expect(artifact.title).toBe("Dot grid");
    expect(artifact.source).toContain("<title>Dot grid</title>");
    // css rides in the head, js before the body closes.
    expect(artifact.source).toMatch(
      /<style>\nbody \{ background: #111; \}\n<\/style>\n<\/head>/,
    );
    expect(artifact.source).toMatch(
      /<script>\nconsole\.log\(1\);\n<\/script>\n<\/body>/,
    );
  });

  it("starts a new document at every html block", () => {
    const markdown = [
      "```html",
      "<html><head><title>One</title></head><body></body></html>",
      "```",
      "```css",
      ".a { color: red; }",
      "```",
      "```html",
      "<html><head><title>Two</title></head><body></body></html>",
      "```",
      "```css",
      ".b { color: blue; }",
      "```",
    ].join("\n");
    const artifacts = detectArtifacts(markdown);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.title).toBe("One");
    expect(artifacts[0]?.source).toContain(".a");
    expect(artifacts[0]?.source).not.toContain(".b");
    expect(artifacts[1]?.title).toBe("Two");
    expect(artifacts[1]?.source).toContain(".b");
    expect(artifacts[1]?.source).not.toContain(".a");
  });

  it("leaves javascript as an alias of js", () => {
    const markdown = [
      "```html",
      "<html><body></body></html>",
      "```",
      "```javascript",
      "window.x = 1;",
      "```",
    ].join("\n");
    const [artifact] = detectArtifacts(markdown);
    expect(artifact?.source).toContain("window.x = 1;");
  });

  it("does not attach css or js without an html group", () => {
    const markdown = [
      "```css",
      "body { color: red; }",
      "```",
      "```js",
      "x();",
      "```",
    ].join("\n");
    expect(detectArtifacts(markdown)).toEqual([]);
  });
});

describe("detectArtifacts svg", () => {
  it("takes a fenced svg block as one artifact with its title", () => {
    const markdown = [
      "A dot:",
      "",
      "```svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">',
      "<title>Dot</title>",
      '<circle cx="5" cy="5" r="4"/>',
      "</svg>",
      "```",
    ].join("\n");
    const artifacts = detectArtifacts(markdown);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("svg");
    expect(artifacts[0]?.title).toBe("Dot");
    expect(artifacts[0]?.source).toContain("<circle");
  });

  it("detects an untagged fence holding a bare svg element", () => {
    const markdown = ["```", '<svg width="8" height="8"></svg>', "```"].join(
      "\n",
    );
    const artifacts = detectArtifacts(markdown);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("svg");
  });

  it("falls back to the generic svg title", () => {
    const [artifact] = detectArtifacts("```svg\n<svg></svg>\n```");
    expect(artifact?.title).toBe("SVG artifact");
  });
});

describe("detectArtifacts none", () => {
  it("never treats mermaid or markdown blocks as artifacts", () => {
    const markdown = [
      "```mermaid",
      "graph TD; A --> B;",
      "```",
      "```markdown",
      "# Notes",
      "```",
    ].join("\n");
    expect(detectArtifacts(markdown)).toEqual([]);
  });

  it("finds nothing in a plain prose answer", () => {
    const markdown = "Just words, and `inline code`.\n\n- a list";
    expect(detectArtifacts(markdown)).toEqual([]);
  });

  it("finds nothing in the empty answer", () => {
    expect(detectArtifacts("")).toEqual([]);
  });
});

describe("fencedBlocks", () => {
  it("keeps the primary language token of an info string", () => {
    const blocks = fencedBlocks('```js live title="x"\nlet a = 1;\n```');
    expect(blocks).toEqual([{ lang: "js", content: "let a = 1;" }]);
  });

  it("honours longer fences and unterminated tails", () => {
    const blocks = fencedBlocks("````html\n<b>\n````\nafter");
    expect(blocks).toEqual([{ lang: "html", content: "<b>" }]);
    expect(fencedBlocks("```css\n.x {")[0]?.lang).toBe("css");
  });
});

describe("injectCsp and viewerDocument", () => {
  it("sits right after the head tag of a full document", () => {
    const out = injectCsp(
      "<!doctype html><html><head><title>t</title></head></html>",
    );
    expect(out).toContain('<head>\n<meta http-equiv="Content-Security-Policy"');
  });

  it("prepends the meta to a fragment", () => {
    expect(injectCsp("<div>hi</div>").startsWith(artifactCspMeta())).toBe(true);
  });

  it("wraps svg, markdown and image kinds in the same CSP shell", () => {
    const svgDoc: ArtifactDoc = {
      kind: "svg",
      title: "s",
      source: "<svg></svg>",
    };
    const svgHtml = viewerDocument(svgDoc);
    expect(svgHtml).toContain(ARTIFACT_CSP);
    expect(svgHtml).toContain("<svg></svg>");

    const mdHtml = viewerDocument({
      kind: "md",
      title: "m",
      source: "<b>bold</b>",
    });
    expect(mdHtml).toContain(ARTIFACT_CSP);
    expect(mdHtml).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(mdHtml).not.toContain("<b>bold</b>");

    const imgHtml = viewerDocument({
      kind: "image",
      title: "shot",
      source: "data:image/png;base64,AAAA",
    });
    expect(imgHtml).toContain(ARTIFACT_CSP);
    expect(imgHtml).toContain(
      '<img alt="shot" src="data:image/png;base64,AAAA">',
    );
  });

  it("keeps the html kind intact apart from the injected meta", () => {
    const html = viewerDocument({
      kind: "html",
      title: "t",
      source: "<html><head></head><body>x</body></html>",
    });
    expect(html).toContain(ARTIFACT_CSP);
    expect(html).toContain("<body>x</body>");
  });
});

describe("naming helpers", () => {
  it("names saved artifacts after the turn and index", () => {
    expect(artifactFileName(2, 0, "html")).toBe("2-0.html");
    expect(artifactFileName(2, 1, "svg")).toBe("2-1.svg");
    expect(artifactFileName(3, 0, "md")).toBe("3-0.md");
    expect(artifactFileName(4, 0, "image", "data:image/jpeg;base64,A")).toBe(
      "4-0.jpg",
    );
  });

  it("maps image data urls to file extensions", () => {
    expect(imageExtensionFromDataUrl("data:image/png;base64,A")).toBe("png");
    expect(imageExtensionFromDataUrl("data:image/webp;base64,A")).toBe("webp");
    expect(imageExtensionFromDataUrl("data:text/plain;base64,A")).toBe("img");
  });

  it("shares turn-indexed names with project attachments", () => {
    expect(turnFileName(4, 2, "png")).toBe("4-2.png");
    expect(attachmentFileName(4, 2, "image/jpeg")).toBe("4-2.jpg");
    expect(attachmentFileName(4, 3, "image/webp")).toBe("4-3.webp");
    expect(attachmentFileName(4, 4, "image/bmp")).toBeNull();
    expect(attachmentExtensionFromMediaType(" IMAGE/GIF ")).toBe("gif");
  });

  it("encodes the consented render as a utf-8 data url", () => {
    const url = htmlDataUrl("<html><body>café</body></html>");
    expect(url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true);
    // Round-trip through the same utf-8 codec the iframe will use.
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) =>
      c.charCodeAt(0),
    );
    expect(new TextDecoder().decode(bytes)).toContain("café");
  });
});
