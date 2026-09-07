import { Markdown as TiptapMarkdown } from "@tiptap/markdown";
import { EditorContent, Node, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo } from "react";

// ---------------------------------------------------------------------------
// Markdown images
// ---------------------------------------------------------------------------

/** Sources that must reach the img element untouched. */
const PASS_THROUGH_SRC = /^(https?|data|blob|asset):/i;

/** Absolute host paths: unix, windows drive, and UNC forms. */
function isAbsoluteHostPath(src: string): boolean {
  return (
    src.startsWith("/") || src.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(src)
  );
}

/** Join a session-relative image path onto the workspace cwd. */
export function joinImagePath(cwd: string, rel: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

/**
 * Resolve a markdown image src for rendering: http, data, blob and asset URLs
 * pass through unchanged; relative paths resolve against the session cwd;
 * local absolute paths and the resolved joins convert through the asset
 * protocol. Falls back to the original src when conversion is unavailable
 * (tests, plain browser); a broken img is the caller's signal.
 */
export function markdownImageSrc(src: string, cwd?: string | null): string {
  const trimmed = src.trim();
  if (!trimmed || PASS_THROUGH_SRC.test(trimmed)) return src;
  const absolute = isAbsoluteHostPath(trimmed)
    ? trimmed
    : cwd
      ? joinImagePath(cwd, trimmed)
      : null;
  if (!absolute) return src;
  try {
    return convertFileSrc(absolute);
  } catch {
    return src;
  }
}

// The session cwd the read-only renderer resolves relative image paths
// against. MarkdownRenderer assigns it synchronously during its render pass,
// before useEditor parses the content in the same pass.
let markdownSessionCwd: string | null = null;

export function setMarkdownSessionCwd(cwd?: string | null): void {
  markdownSessionCwd = cwd?.trim() ? cwd : null;
}

/**
 * Inline image node so `![alt](path)` survives the shared composer/renderer
 * schema. The src attribute is rewritten only at DOM render time, so the
 * document (and getMarkdown) keeps the author's original path.
 */
const ImageNode = Node.create({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "img",
      {
        ...HTMLAttributes,
        src: markdownImageSrc(String(node.attrs.src ?? ""), markdownSessionCwd),
      },
    ];
  },
  // marked tokenizes `![alt](src "title")` as an inline "image" token.
  markdownTokenName: "image",
  parseMarkdown(token, helpers) {
    return helpers.createNode("image", {
      src: token.href ?? null,
      alt: token.text ?? null,
      title: token.title ?? null,
    });
  },
  renderMarkdown(node) {
    const attrs = node.attrs ?? {};
    const src = String(attrs.src ?? "");
    const title = attrs.title ? ` "${String(attrs.title).replace(/"/g, "'")}"` : "";
    return `![${String(attrs.alt ?? "")}](${src}${title})`;
  },
});

// One extension set for the composer and the read-only renderers: content
// round-trips through the exact same schema in both directions.
export function piEditorExtensions() {
  // TableKit registers table, tableRow, tableHeader and tableCell together;
  // Table alone leaves the schema without tableRow and the editor throws on
  // creation, which unmounts the whole app.
  return [StarterKit, TiptapMarkdown, TableKit, ImageNode];
}

export function MarkdownRenderer({
  content,
  cwd,
}: {
  content: string;
  cwd?: string;
}) {
  // Render-phase assignment on purpose: useEditor below parses `content` in
  // this same pass and the image node reads the cwd while rendering DOM.
  if (cwd !== undefined) setMarkdownSessionCwd(cwd);
  const doc = useMemo(() => content, [content]);
  const editor = useEditor({
    extensions: piEditorExtensions(),
    content: doc,
    contentType: "markdown",
    editable: false,
    autofocus: false,
  });
  // useEditor only reads `content` at creation; streamed assistant text grows
  // after mount, so push every change into the existing editor.
  useEffect(() => {
    if (!editor) return;
    if (editor.getMarkdown() === doc) return;
    editor.commands.setContent(doc, { contentType: "markdown" });
  }, [editor, doc]);
  if (!editor) return null;
  return (
    <EditorContent
      editor={editor}
      className="[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-accent/60 [&_code]:px-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-semibold [&_li]:ml-3 [&_ol]:list-decimal [&_p]:my-0.5 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-accent/40 [&_pre]:p-2 [&_table]:my-1 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_ul]:list-disc"
    />
  );
}
