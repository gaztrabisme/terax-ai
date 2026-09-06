import { EditorContent, Extension, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { clearDraft, loadDraft, saveDraft } from "@/modules/pi/lib/drafts";
import { piEditorExtensions } from "./renderers/Markdown";

type Props = {
  tabId: number;
  cwd?: string;
  disabled?: boolean;
  placeholder?: string;
  onSubmit: (markdown: string) => void;
};

export function Composer({
  tabId,
  cwd,
  disabled = false,
  placeholder = "Message pi (markdown)",
  onSubmit,
}: Props) {
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const editor = useEditor({
    extensions: [
      ...piEditorExtensions(),
      // Enter sends, Shift+Enter inserts a newline. Bold/italic stay on the
      // starter-kit Cmd+B / Cmd+I bindings; the markdown serializer turns
      // them into ** and *.
      Extension.create({
        name: "piSubmit",
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              if (disabledRef.current) return false;
              const md = this.editor.getMarkdown().trim();
              if (!md) return true;
              submitRef.current(md);
              this.editor.commands.clearContent();
              return true;
            },
            "Shift-Enter": () => this.editor.commands.splitBlock(),
          };
        },
      }),
    ],
    content: "",
    contentType: "markdown",
    editable: true,
    autofocus: false,
    editorProps: {
      attributes: {
        class:
          "max-h-40 min-h-16 w-full overflow-y-auto rounded-md border border-border/60 bg-background p-2 text-xs outline-none focus:ring-1 focus:ring-ring",
        "data-placeholder": placeholder,
        "aria-label": "pi composer",
      },
    },
  });

  // Restore the persisted draft once, before the user types.
  useEffect(() => {
    if (!editor || !cwd) return;
    let alive = true;
    void loadDraft(cwd, tabId).then((md) => {
      if (alive && md && editor.isEmpty) {
        editor.commands.setContent(md, { contentType: "markdown" });
      }
    });
    return () => {
      alive = false;
    };
  }, [editor, cwd, tabId]);

  // Debounced autosave; cleared on submit by clearDraft.
  useEffect(() => {
    if (!editor || !cwd) return;
    let timer: number | undefined;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void saveDraft(cwd, tabId, editor.getMarkdown());
      }, 500);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      window.clearTimeout(timer);
    };
  }, [editor, cwd, tabId]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const submit = () => {
    if (!editor || disabled) return;
    const md = editor.getMarkdown().trim();
    if (!md) return;
    onSubmit(md);
    editor.commands.clearContent();
    if (cwd) void clearDraft(cwd, tabId);
  };

  return (
    <div className="shrink-0 border-t border-border/60 p-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <EditorContent editor={editor} />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
