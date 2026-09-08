/** Artifact detection over an answer's fenced code blocks, and the document
 *  builder behind the artifact pane's iframe. An artifact is html: one html
 *  block starts a document and sibling css and js blocks fold into it as
 *  style and script tags (Open WebUI's grouping). A fenced svg block, tagged
 *  or bare, is its own artifact. Mermaid and markdown blocks stay out:
 *  Streamdown renders them inline. The pane shows a file-viewer variant of
 *  the same document for project files, so any html, svg, md or image file
 *  can pass through it. */

export type ArtifactKind = "html" | "svg";

export type Artifact = {
  kind: ArtifactKind;
  title: string;
  /** The document source: html text, or the raw <svg> markup. */
  source: string;
};

/** Document kinds the viewer renders. */
export type ArtifactDocKind = "html" | "svg" | "md" | "image";

/** What the pane's iframe shows. Kinds beyond detection cover project files
 *  viewed through the same pane; `path` marks an artifact that already is a
 *  project file. K13 file-first fields: a detected answer artifact gains
 *  `artifactId`, `turnKey`, `sessionId`, `mime` and `sha256` once its file
 *  exists under .pi/artifacts; the viewer reads the file, never the answer
 *  text. */
export type ArtifactDoc = {
  kind: "html" | "svg" | "md" | "image";
  title: string;
  /** html/svg/md text, or a data: URL for image kind. */
  source: string;
  /** Project path, when the document already lives on disk. */
  path?: string;
  /** Turn index and artifact index within the answer: the Save name. */
  turn?: number;
  n?: number;
  /** Stable opaque id of the artifact's file under .pi/artifacts. */
  artifactId?: string;
  /** The owning turn's stable key (the user block id). */
  turnKey?: string;
  /** The owning pi session id. */
  sessionId?: string | null;
  /** Media type recorded in the artifact index. */
  mime?: string;
  /** Hash of the file the viewer reads. */
  sha256?: string;
};

type FencedBlock = { lang: string; content: string };

const HTML_LANGS = new Set(["html", "htm"]);
const STYLE_LANGS = new Set(["css"]);
const SCRIPT_LANGS = new Set(["js", "javascript", "jsx"]);

/** Primary token of a fence info string: "js live" and "html:light" are js
 *  and html. */
function normalizeLang(info: string): string {
  return (
    info
      .trim()
      .split(/[\s:{]/, 1)[0]
      ?.toLowerCase() ?? ""
  );
}

/** Fenced code blocks in order: a fence opens with 3+ backticks and closes
 *  at a line of at least as many. An unterminated fence yields its tail. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^[ \t]*(`{3,})(.*)$/);
    if (!open) {
      i += 1;
      continue;
    }
    const ticks = open[1].length;
    const lang = normalizeLang(open[2] ?? "");
    const body: string[] = [];
    i += 1;
    while (i < lines.length) {
      const close = lines[i].match(/^[ \t]*(`{3,})[ \t]*$/);
      if (close && close[1].length >= ticks) {
        i += 1;
        break;
      }
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ lang, content: body.join("\n") });
  }
  return blocks;
}

function isSvgBlock(block: FencedBlock): boolean {
  if (block.lang === "svg") return true;
  if (block.lang) return false;
  const text = block.content.trim();
  return /^<svg[\s>]/i.test(text) && /<\/svg>\s*$/i.test(text);
}

function tagText(source: string): string | null {
  const match = source.match(/<title[^>]*>([^<]*)<\/title>/i);
  const text = match?.[1].trim();
  return text ? text : null;
}

/** Folds css into the head and js before the body's close; fragments get the
 *  snippet prepended (style) or appended (script). */
function composeHtmlDocument(doc: {
  html: string;
  css: string[];
  js: string[];
}): string {
  let html = doc.html;
  if (doc.css.length > 0) {
    const style = `<style>\n${doc.css.join("\n\n")}\n</style>`;
    html = injectSnippet(html, "head", style);
  }
  if (doc.js.length > 0) {
    const script = `<script>\n${doc.js.join("\n;\n")}\n</script>`;
    html = injectSnippet(html, "body", script);
  }
  return html;
}

function injectSnippet(
  html: string,
  section: "head" | "body",
  snippet: string,
): string {
  const close = new RegExp(`</${section}\\s*>`, "i");
  if (close.test(html)) {
    return html.replace(close, `${snippet}\n</${section}>`);
  }
  return section === "head" ? `${snippet}\n${html}` : `${html}\n${snippet}`;
}

/** Detection over one answer's markdown: html groups plus standalone svg, in
 *  document order. */
export function detectArtifacts(markdown: string): Artifact[] {
  const artifacts: Artifact[] = [];
  let doc: { html: string; css: string[]; js: string[] } | null = null;
  const flush = () => {
    if (!doc) return;
    const html = composeHtmlDocument(doc);
    artifacts.push({
      kind: "html",
      title: tagText(doc.html) ?? "HTML artifact",
      source: html,
    });
    doc = null;
  };
  for (const block of fencedBlocks(markdown)) {
    if (HTML_LANGS.has(block.lang)) {
      flush();
      doc = { html: block.content, css: [], js: [] };
      continue;
    }
    if (isSvgBlock(block)) {
      flush();
      artifacts.push({
        kind: "svg",
        title: tagText(block.content) ?? "SVG artifact",
        source: block.content.trim(),
      });
      continue;
    }
    // css and js only attach to an open html group; mermaid, markdown and
    // orphan css/js render inline and are not artifacts.
    if (STYLE_LANGS.has(block.lang) && doc) doc.css.push(block.content);
    else if (SCRIPT_LANGS.has(block.lang) && doc) doc.js.push(block.content);
  }
  flush();
  return artifacts;
}

/** Meta CSP for the artifact document: no network anywhere, data: and blob:
 *  for the resource types, inline style and script so the artifact works and
 *  the consented scripts run. Exactly this string rides every viewer doc. */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src data: blob:; form-action 'none'";

// ---------------------------------------------------------------------------
// K13 file-first artifacts
// ---------------------------------------------------------------------------

/** A completed artifact file recorded under .pi/artifacts: the viewer's
 *  authoritative input (design.md 3.4 row "Answers and artifacts"). */
export type ArtifactFileRef = { path: string; sha256: string };

/** Map key for one detected artifact within its turn. */
export function artifactFileKey(turnKey: string, n: number): string {
  return `${turnKey}/${n}`;
}

/** Media type the Rust artifact writer records for one detected kind. */
export function artifactMime(kind: ArtifactDoc["kind"]): string {
  switch (kind) {
    case "html":
      return "text/html";
    case "svg":
      return "image/svg+xml";
    case "md":
      return "text/markdown";
    case "image":
      return "application/octet-stream";
  }
}

/**
 * Stable opaque artifact file id: a hash over the session id, the turn key
 * (the user block id) and the index within the answer, so the same artifact
 * writes to the same `<project>/.pi/artifacts/<artifact-id>.<ext>` across
 * re-detections and restarts while the filename never carries a list
 * position. sha256Hex keeps the id ASCII filename-safe.
 */
export async function artifactIdFor(
  sessionId: string | null,
  turnKey: string,
  n: number,
): Promise<string> {
  const { sha256Hex } = await import("./drafts");
  const digest = await sha256Hex(`${sessionId ?? ""}\n${turnKey}\n${n}`);
  return `art-${digest.slice(0, 16)}`;
}

export function artifactCspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
}

function spliceAt(html: string, index: number, insert: string): string {
  return `${html.slice(0, index)}${insert}${html.slice(index)}`;
}

/** Puts the CSP meta at the top of the document: after <head> when present,
 *  else right after <html>, else before everything. */
export function injectCsp(html: string): string {
  const meta = artifactCspMeta();
  const head = /<head[^>]*>/i.exec(html);
  if (head) return spliceAt(html, head.index + head[0].length, `\n${meta}`);
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    return spliceAt(
      html,
      root.index + root[0].length,
      `\n<head>${meta}</head>`,
    );
  }
  return `${meta}\n${html}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

const SVG_SHELL_STYLE =
  "html,body{margin:0;padding:0;background:#fff}svg{max-width:100%;height:auto}";

const MD_SHELL_STYLE =
  "body{margin:0;padding:16px;background:#fff;color:#111;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}";

const IMAGE_SHELL_STYLE =
  "body{margin:0;display:grid;place-items:center;background:#fff}img{max-width:100%;max-height:100vh;object-fit:contain}";

/** The full srcdoc payload for a document: the CSP meta always first. */
export function viewerDocument(doc: ArtifactDoc): string {
  const meta = artifactCspMeta();
  switch (doc.kind) {
    case "html":
      return injectCsp(doc.source);
    case "svg":
      return `<!doctype html>\n<html>\n<head>\n${meta}\n<style>${SVG_SHELL_STYLE}</style>\n</head>\n<body>\n${doc.source}\n</body>\n</html>`;
    case "md":
      return `<!doctype html>\n<html>\n<head>\n${meta}\n<style>${MD_SHELL_STYLE}</style>\n</head>\n<body>${escapeHtml(doc.source)}</body>\n</html>`;
    case "image":
      return `<!doctype html>\n<html>\n<head>\n${meta}\n<style>${IMAGE_SHELL_STYLE}</style>\n</head>\n<body><img alt="${escapeHtml(doc.title)}" src="${escapeHtml(doc.source)}"></body>\n</html>`;
  }
}

/** base64 data: URL for the consented (allow-scripts) render: a data: iframe
 *  carries an empty policy container, so the app's own CSP does not follow
 *  the artifact in and only the injected meta applies. */
export function htmlDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`;
}

const IMAGE_EXTENSIONS: Record<ArtifactDoc["kind"], string> = {
  html: "html",
  svg: "svg",
  md: "md",
  image: "img",
};

const ATTACHMENT_EXTENSIONS: Record<string, "png" | "jpg" | "gif" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** "image/png" -> png, "image/jpeg" -> jpg, unknown -> img. */
export function imageExtensionFromDataUrl(dataUrl: string): string {
  const match = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(dataUrl.trim());
  if (!match) return IMAGE_EXTENSIONS.image;
  const raw = match[1].toLowerCase();
  if (raw === "jpeg") return "jpg";
  if (raw === "svg+xml") return "svg";
  return raw;
}

/** The extension accepted by the project attachment writer for one media type. */
export function attachmentExtensionFromMediaType(
  mediaType: string,
): "png" | "jpg" | "gif" | "webp" | null {
  return ATTACHMENT_EXTENSIONS[mediaType.trim().toLowerCase()] ?? null;
}

/** Shared turn-indexed filename shape used by artifacts and attachments. */
export function turnFileName(
  turn: number,
  n: number,
  extension: string,
): string {
  return `${turn}-${n}.${extension}`;
}

/** <turn>-<n>.<ext>, the Save name under .pi/artifacts. */
export function artifactFileName(
  turn: number,
  n: number,
  kind: ArtifactDoc["kind"],
  source?: string,
): string {
  const ext =
    kind === "image" && source
      ? imageExtensionFromDataUrl(source)
      : IMAGE_EXTENSIONS[kind];
  return turnFileName(turn, n, ext);
}

/** <turn>-<n>.<ext>, the initial name under .pi/attachments. */
export function attachmentFileName(
  turn: number,
  n: number,
  mediaType: string,
): string | null {
  const ext = attachmentExtensionFromMediaType(mediaType);
  return ext ? turnFileName(turn, n, ext) : null;
}
