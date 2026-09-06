import { Markdown as TiptapMarkdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { useMemo } from "react";

// One extension set for the composer and the read-only renderers: content
// round-trips through the exact same schema in both directions.
export function piEditorExtensions() {
  return [StarterKit, TiptapMarkdown, Table];
}

export function MarkdownRenderer({ content }: { content: string }) {
  const doc = useMemo(() => content, [content]);
  const editor = useEditor({
    extensions: piEditorExtensions(),
    content: doc,
    contentType: "markdown",
    editable: false,
    autofocus: false,
  });
  if (!editor) return null;
  return (
    <EditorContent
      editor={editor}
      className="[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-accent/60 [&_code]:px-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-semibold [&_li]:ml-3 [&_ol]:list-decimal [&_p]:my-0.5 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-accent/40 [&_pre]:p-2 [&_table]:my-1 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_ul]:list-disc"
    />
  );
}
