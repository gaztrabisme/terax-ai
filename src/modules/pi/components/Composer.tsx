import { Extension, EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Cancel01Icon, ImageAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { clearDraft, loadDraft, saveDraft } from "@/modules/pi/lib/drafts";
import type { PiImageAttachment } from "@/modules/pi/lib/parse";
import { piEditorExtensions } from "./renderers/Markdown";

// Tiptap's Link autolinks any dotted word, so typing CLAUDE.md produced
// http://CLAUDE.md. Only a real URL may autolink: an explicit scheme:// or a
// www. host (tiptap prefixes the scheme itself).
export function autolinkable(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^www\./i.test(url);
}

// Same extension set as the read-only renderers, with the link guard applied.
export function composerExtensions() {
  return piEditorExtensions().map((ext) =>
    ext === StarterKit
      ? StarterKit.configure({ link: { shouldAutoLink: autolinkable } })
      : ext,
  );
}

/// ---------------------------------------------------------------------------
/// Image attachments
/// ---------------------------------------------------------------------------

// Caps the composer enforces itself: pi skips oversize or malformed image
// items silently (rpc.rs parse_prompt_images), so a rejected image would
// never surface an error anywhere else.
export const MAX_ATTACHMENTS = 5;
export const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;
/** Longest edge after the canvas downscale. */
export const MAX_IMAGE_EDGE_PX = 1568;
const JPEG_QUALITY = 0.85;
/** Source types whose bytes may keep transparency; everything else becomes jpeg. */
const ALPHA_SOURCE_TYPES = new Set(["image/png", "image/webp", "image/gif"]);

/** An encoded attachment: media type, base64 payload, decoded byte size. */
export type EncodedImage = PiImageAttachment & { bytes: number };

/** A chip in the composer: an encoded image plus display metadata. */
export type PendingImage = EncodedImage & { id: number; name: string };

/** Exact size of a base64 payload once decoded (padding-aware). */
export function base64Bytes(payload: string): number {
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - pad);
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/** True when any pixel in the drawn canvas carries partial transparency. */
function hasTransparency(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): boolean {
  const pixels = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) return true;
  }
  return false;
}

async function encodeImageBlob(blob: Blob): Promise<EncodedImage> {
  const img = await loadImage(blob);
  const srcW = img.naturalWidth || 1;
  const srcH = img.naturalHeight || 1;
  // Never upscale: the cap only shrinks images past 1568 px on their longest edge.
  const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const keepPng = ALPHA_SOURCE_TYPES.has(blob.type) && hasTransparency(ctx, w, h);
  const url = keepPng
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!match) throw new Error("image encode failed");
  return { mediaType: match[1], data: match[2], bytes: base64Bytes(match[2]) };
}

// Injection seam for tests: jsdom has no canvas, so component tests swap this
// encode step instead of decoding real image bytes.
export const imageEncoder: {
  encode: (blob: Blob) => Promise<EncodedImage>;
} = { encode: encodeImageBlob };

export type AddImageResult = {
  images: PendingImage[];
  /** Inline notice text when the image was rejected for a cap, else null. */
  notice: string | null;
};

let pendingImageSeq = 0;

/** Pure append used by every input path (paste, drop, attach): enforces the
 *  image count cap and the total encoded byte cap, naming the cap in the
 *  notice it returns when the image does not fit. */
export function appendPendingImage(
  current: PendingImage[],
  image: EncodedImage,
  name: string,
): AddImageResult {
  if (current.length >= MAX_ATTACHMENTS) {
    return {
      images: current,
      notice: `Attachment limit is ${MAX_ATTACHMENTS} images`,
    };
  }
  const total = current.reduce((sum, img) => sum + img.bytes, 0);
  if (total + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
    return {
      images: current,
      notice: "Attachments would exceed the 4 MB image budget",
    };
  }
  pendingImageSeq += 1;
  return {
    images: [
      ...current,
      { ...image, id: pendingImageSeq, name: name || `image ${pendingImageSeq}` },
    ],
    notice: null,
  };
}

/** Image files among the drag or clipboard payloads, in order. */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  return Array.from(dt?.files ?? []).filter((f) =>
    f.type.startsWith("image/"),
  );
}

type Props = {
  tabId: number;
  cwd?: string;
  disabled?: boolean;
  placeholder?: string;
  /** True when the resolved role model accepts image input; undefined or
   *  false shows the one-line may-not-accept notice. Sending never blocks:
   *  pi decides what to do with the images. */
  modelAcceptsImages?: boolean;
  onSubmit: (markdown: string, images: PiImageAttachment[]) => void;
};

/**
 * Reads the model chip data from the nearest pane root. ChatPane fills
 * data-pi-model and data-pi-smol from the store's resolved session roles;
 * until then the chip renders "model unset".
 */
function useModelChip(ref: React.RefObject<HTMLElement | null>) {
  const [model, setModel] = useState<string | null>(null);
  const [smol, setSmol] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const root =
        ref.current?.closest<HTMLElement>("[data-pi-model]") ??
        ref.current?.closest<HTMLElement>("[data-pi-smol]");
      if (!root) return;
      const value = root.getAttribute("data-pi-model");
      setModel(value && value.trim() ? value : null);
      const smolValue = root.getAttribute("data-pi-smol");
      setSmol(smolValue && smolValue.trim() ? smolValue : null);
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
  modelAcceptsImages,
  onSubmit,
}: Props) {
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const chipRef = useRef<HTMLSpanElement>(null);
  const { model, smol } = useModelChip(chipRef);

  const [images, setImages] = useState<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setChips = (next: PendingImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };

  const removeImage = (id: number) => {
    setChips(imagesRef.current.filter((img) => img.id !== id));
    setNotice(null);
  };

  // Shared by paste, drop and the attach button: encode each image, then let
  // appendPendingImage decide whether it fits under the caps.
  const addFiles = async (files: File[]) => {
    if (disabledRef.current) return;
    setNotice(null);
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      let encoded: EncodedImage;
      try {
        encoded = await imageEncoder.encode(file);
      } catch {
        setNotice(`Could not read ${file.name || "that image"}`);
        continue;
      }
      const result = appendPendingImage(
        imagesRef.current,
        encoded,
        file.name || "",
      );
      setChips(result.images);
      if (result.notice) setNotice(result.notice);
    }
  };

  // Assigned after the editor exists; the Enter shortcut closes over the ref.
  const performSubmitRef = useRef<() => boolean>(() => false);

  const editor = useEditor({
    extensions: [
      ...composerExtensions(),
      // Enter sends, Shift+Enter inserts a newline. Bold/italic stay on the
      // starter-kit Cmd+B / Cmd+I bindings; the markdown serializer turns
      // them into ** and *.
      Extension.create({
        name: "piSubmit",
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              if (disabledRef.current) return false;
              return performSubmitRef.current();
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

  // Send clears the editor, the chips and any cap notice; attachments live
  // only in this component state, so the draft file never carries images.
  const performSubmit = (): boolean => {
    if (!editor || disabledRef.current) return false;
    const md = editor.getMarkdown().trim();
    if (!md) return true;
    const attachments: PiImageAttachment[] = imagesRef.current.map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
    }));
    submitRef.current(md, attachments);
    editor.commands.clearContent();
    setChips([]);
    setNotice(null);
    if (cwd) void clearDraft(cwd, tabId);
    return true;
  };
  performSubmitRef.current = performSubmit;

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

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border/60 p-2",
        dragActive && "rounded-md ring-1 ring-ring",
      )}
      onPaste={(e) => {
        const items = Array.from(e.clipboardData?.items ?? []);
        const files = items
          .filter(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        void addFiles(files);
      }}
      onDragOver={(e) => {
        if (imageFilesOf(e.dataTransfer).length === 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(e) => {
        const files = imageFilesOf(e.dataTransfer);
        setDragActive(false);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        void addFiles(files);
      }}
    >
      {images.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {images.map((img) => (
            <span key={img.id} className="relative inline-flex">
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                className="size-14 rounded-md border border-border/60 object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                onClick={() => removeImage(img.id)}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border/60 bg-background p-0.5 text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-1.5 text-xs text-destructive">{notice}</div>
      ) : null}
      <EditorContent editor={editor} />
      {modelAcceptsImages !== true ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          This model may not accept images; pi decides what to do with them.
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void addFiles(files);
          }}
        />
        <button
          type="button"
          aria-label="Attach images"
          title="Attach images"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <HugeiconsIcon icon={ImageAdd01Icon} size={14} strokeWidth={1.75} />
        </button>
        <span
          ref={chipRef}
          className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
        >
          {model ?? "model unset"}
          {smol ? `, subagent ${smol}` : ""}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => performSubmitRef.current()}
          disabled={disabled}
          className="h-7 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
