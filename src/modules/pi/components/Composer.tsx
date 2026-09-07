import { EditorContent, Extension, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { clearDraft, loadDraft, saveDraft } from "@/modules/pi/lib/drafts";
import { piEditorExtensions } from "./renderers/Markdown";

type Props = {
  tabId: number;
  cwd?: string;
  disabled?: boolean;
  placeholder?: string;
  onSubmit: (markdown: string) => void;
};

/**
 * Reads the model chip data from the nearest pane root. The settings worker
 * fills data-pi-model and data-pi-smol on the ChatPane root; until then the
 * chip renders "model unset".
 */
function useModelChip(ref: React.RefObject<HTMLElement | null>) {
  const [model, setModel] = useState<string | null>(null);
  const [smol, setSmol] = useState(false);

  useEffect(() => {
    const read = () => {
      const root =
        ref.current?.closest<HTMLElement>("[data-pi-model]") ??
        ref.current?.closest<HTMLElement>("[data-pi-smol]");
      if (!root) return;
      const value = root.getAttribute("data-pi-model");
      setModel(value && value.trim() ? value : null);
      const smolValue = root.getAttribute("data-pi-smol");
      setSmol(smolValue === "true" || smolValue === "1");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-pi-model", "data-pi-smol"],
    });
    return () => observer.disconnect();
  }, [ref]);

  return { model, smol };
}

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
  const chipRef = useRef<HTMLSpanElement>(null);
  const { model, smol } = useModelChip(chipRef);

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
          "max-h-40 min-h-16 w-full overflow-y-auto rounded-md border border-border/60 bg-background p-2 text-[14px] outline-none focus:ring-1 focus:ring-ring",
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
      <EditorContent editor={editor} />
      <div className="mt-1.5 flex items-center gap-2">
        <span
          ref={chipRef}
          className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
        >
          {model ?? "model unset"}
          {smol ? " smol" : ""}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="h-7 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
