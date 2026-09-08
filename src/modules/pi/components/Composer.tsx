import { Extension, EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Cancel01Icon, ImageAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { native } from "@/lib/native";
import {
  clearDraft,
  emptyChatMeta,
  loadDraft,
  loadDraftMeta,
  saveDraft,
  saveDraftMeta,
  type ChatDraftMeta,
} from "@/modules/pi/lib/drafts";
import { stableIdOf } from "@/modules/tabs/lib/sid";
import type { PiImageAttachment } from "@/modules/pi/lib/parse";
import { usePiStore } from "@/modules/pi/lib/piStore";
import {
  INSERT_DRAFT_EVENT,
  type InsertDraftDetail,
} from "@/modules/pi/lib/sendToChat";
import {
  completeSlashLine,
  filterPrompts,
  loadPrompts,
  slashDraft,
  type PiPromptEntry,
} from "@/modules/pi/lib/prompts";
import { PromptMenu } from "./PromptMenu";
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
  const keepPng =
    ALPHA_SOURCE_TYPES.has(blob.type) && hasTransparency(ctx, w, h);
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
      {
        ...image,
        id: pendingImageSeq,
        name: name || `image ${pendingImageSeq}`,
      },
    ],
    notice: null,
  };
}

/** Image files among the drag or clipboard payloads, in order. */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  return Array.from(dt?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** Extensions the bytes bridge accepts from dialogs and OS drops. */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
] as const;

/** Dropped or picked paths that name an image type, in order. */
export function imagePathsOf(paths: string[]): string[] {
  const exts = new Set(IMAGE_EXTENSIONS);
  return paths.filter((p) => {
    // lastIndexOf over split: a dotfile like ".png" or "/dir/.png" has no
    // extension, because the last dot directly follows a separator.
    const dot = p.lastIndexOf(".");
    if (dot <= 0 || dot === p.length - 1) return false;
    if (p[dot - 1] === "/" || p[dot - 1] === "\\") return false;
    const ext = p.slice(dot + 1).toLowerCase();
    return exts.has(ext as (typeof IMAGE_EXTENSIONS)[number]);
  });
}

/** Decode base64 (the bytes bridge payload) into an image Blob. */
export function bytesToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
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
  onStop?: () => void;
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
  onStop,
}: Props) {
  // K11c draft key: the tab's stable opaque id from the tab store. The
  // numeric id is only the fallback for renders outside the store (tests);
  // in-app every tab registers its stable id at creation.
  const draftKey = stableIdOf(tabId) ?? String(tabId);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
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
  const rootRef = useRef<HTMLDivElement>(null);

  /// Slash menu (prompt library). pi expands "/name args" lines itself on the
  /// rpc prompt path (vendor rpc.rs calls ResourceLoader::expand_input), so a
  /// selection completes the typed name in the draft. On send, pi echoes
  /// the expanded body back as the user message.
  const [prompts, setPrompts] = useState<PiPromptEntry[]>([]);
  const promptsLoadedRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const [filterQuery, setFilterQuery] = useState("");
  const filterQueryRef = useRef("");
  const [highlight, setHighlight] = useState(0);
  const highlightRef = useRef(0);
  const filteredRef = useRef<PiPromptEntry[]>([]);
  // Escape keeps the menu closed until a fresh line starts with "/" again.
  const menuDismissedRef = useRef(false);
  const ensurePromptsRef = useRef<() => void>(() => {});

  const setMenu = (open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
  };

  // One fetch per mount: templates change between sessions, not keystrokes.
  const ensurePrompts = () => {
    if (promptsLoadedRef.current) return;
    promptsLoadedRef.current = true;
    void loadPrompts(cwd).then((list) => setPrompts(list));
  };
  ensurePromptsRef.current = ensurePrompts;

  const selectPrompt = (prompt: PiPromptEntry) => {
    if (!editor) return;
    const line = completeSlashLine(editor.getMarkdown(), prompt.name);
    menuDismissedRef.current = true;
    setMenu(false);
    editor.commands.setContent(line, { contentType: "markdown" });
    editor.commands.focus("end");
  };

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

  // File-path input paths (attach dialog, OS drag and drop): read bytes
  // through the bridge, then run the same encode/cap pipeline as paste.
  const addImagePaths = async (paths: string[]) => {
    if (disabledRef.current) return;
    setNotice(null);
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p;
      try {
        const bytes = await native.readFileBytes(p);
        const encoded = await imageEncoder.encode(
          bytesToBlob(bytes.base64, bytes.mimeType),
        );
        const result = appendPendingImage(imagesRef.current, encoded, name);
        setChips(result.images);
        if (result.notice) setNotice(result.notice);
      } catch {
        setNotice(`Could not read ${name}`);
      }
    }
  };
  const addImagePathsRef = useRef(addImagePaths);
  addImagePathsRef.current = addImagePaths;

  // Attach button: the Tauri file dialog (image filter, multiple) plus the
  // bytes bridge. The hidden input stays as the fallback when the dialog is
  // unavailable; a cancelled dialog does nothing.
  const pickImages = async () => {
    let picked: string | string[] | null;
    try {
      picked = await open({
        multiple: true,
        filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS] }],
      });
    } catch {
      fileInputRef.current?.click();
      return;
    }
    if (picked == null) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length > 0) await addImagePaths(paths);
  };

  // The window keeps dragDropEnabled (the terminal pane's handler depends on
  // it), so OS drops only surface through Tauri's drag-drop event. While this
  // composer is mounted, a drop landing inside it becomes attachment chips;
  // drops anywhere else are ignored here so the terminal keeps its handler.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop" || p.paths.length === 0) return;
        const root = rootRef.current;
        if (!root) return;
        let x = p.position.x;
        let y = p.position.y;
        // Tauri reports physical pixels on some platforms; same guard as the
        // terminal pane's handler.
        if (x > window.innerWidth || y > window.innerHeight) {
          const dpr = window.devicePixelRatio || 1;
          x /= dpr;
          y /= dpr;
        }
        const el = document.elementFromPoint(x, y);
        if (!el || !root.contains(el)) return;
        const paths = imagePathsOf(p.paths);
        if (paths.length > 0) void addImagePathsRef.current(paths);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No Tauri runtime (tests, plain browser): the HTML drop handlers
        // below stay as the fallback.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Assigned after the editor exists; the Enter shortcut closes over the ref.
  const performSubmitRef = useRef<() => boolean>(() => false);
  const selectPromptRef = useRef<(prompt: PiPromptEntry) => void>(() => {});
  // Enter and the arrows reach the editor as keyboard shortcuts; both go
  // through refs so the handlers always see this render's state.
  const performSelectRef = useRef<() => boolean>(() => false);
  const moveHighlightRef = useRef<(delta: number) => boolean>(() => false);
  const dismissMenuRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions: [
      ...composerExtensions(),
      // Enter sends, Shift+Enter inserts a newline. Bold/italic stay on the
      // starter-kit Cmd+B / Cmd+I bindings; the markdown serializer turns
      // them into ** and *. With the prompt menu open, Enter selects the
      // highlighted template, Escape closes (until a fresh line starts with
      // "/"), and the arrows move the highlight.
      Extension.create({
        name: "piSubmit",
        addKeyboardShortcuts() {
          return {
            Enter: () => performSelectRef.current(),
            "Shift-Enter": () => this.editor.commands.splitBlock(),
            Escape: () => {
              if (menuOpenRef.current) {
                dismissMenuRef.current();
                return true;
              }
              // During a turn, Escape in the focused composer interrupts just
              // like Stop. The partial answer stays in the transcript.
              if (stopRef.current) {
                stopRef.current();
                return true;
              }
              return false;
            },
            ArrowDown: () => moveHighlightRef.current(1),
            ArrowUp: () => moveHighlightRef.current(-1),
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
        "data-uat": "composer-input",
      },
    },
  });

  // Send clears the editor, the chips and any cap notice; attachments live
  // only in this component state, so the draft file never carries images.
  // An empty message with attached images still sends (image-only prompt).
  const performSubmit = (): boolean => {
    if (!editor || disabledRef.current) return false;
    const md = editor.getMarkdown().trim();
    const attachments: PiImageAttachment[] = imagesRef.current.map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
    }));
    if (!md && attachments.length === 0) return true;
    submitRef.current(md, attachments);
    editor.commands.clearContent();
    setChips([]);
    setNotice(null);
    if (cwd) void clearDraft(cwd, draftKey);
    return true;
  };
  performSubmitRef.current = performSubmit;

  // The filtered menu list, mirrored into a ref for the key shortcuts, which
  // fire outside the render cycle. filterPrompts is deterministic, so this
  // list matches what PromptMenu renders from the same inputs.
  const filtered = filterPrompts(prompts, filterQuery);
  filteredRef.current = filtered;
  selectPromptRef.current = selectPrompt;
  highlightRef.current = highlight;

  performSelectRef.current = () => {
    if (menuOpenRef.current) {
      const list = filteredRef.current;
      if (list.length > 0 && !disabledRef.current) {
        selectPromptRef.current(
          list[Math.min(highlightRef.current, list.length - 1)],
        );
      }
      return true;
    }
    if (disabledRef.current) return false;
    return performSubmitRef.current();
  };

  moveHighlightRef.current = (delta) => {
    if (!menuOpenRef.current) return false;
    const count = filteredRef.current.length;
    if (count > 0) {
      setHighlight((h) => (h + delta + count) % count);
    }
    return true;
  };

  dismissMenuRef.current = () => {
    menuDismissedRef.current = true;
    setMenu(false);
  };

  // Tracks the editor text: the menu opens when "/" turns an empty composer
  // into a one-line slash command (editor focused, so a restored draft never
  // opens it), stays open while the line stays one, and closes on anything
  // else. Escape keeps it closed until a fresh "/" line starts.
  useEffect(() => {
    if (!editor) return;
    let wasEmpty = editor.isEmpty;
    const update = () => {
      const md = editor.getMarkdown();
      if (md === "/") menuDismissedRef.current = false;
      const draft = slashDraft(md);
      const open =
        !!draft &&
        editor.view.hasFocus() &&
        !menuDismissedRef.current &&
        (wasEmpty || menuOpenRef.current);
      if (open) {
        ensurePromptsRef.current();
        setMenu(true);
        if (draft && draft.nameToken !== filterQueryRef.current) {
          filterQueryRef.current = draft.nameToken;
          setFilterQuery(draft.nameToken);
          setHighlight(0);
          highlightRef.current = 0;
        }
      } else if (menuOpenRef.current) {
        setMenu(false);
      }
      wasEmpty = editor.isEmpty;
    };
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);

  // Restore the persisted draft once, before the user types.
  useEffect(() => {
    if (!editor || !cwd) return;
    let alive = true;
    void loadDraft(cwd, draftKey, { migrateFrom: tabId }).then((md) => {
      if (alive && md && editor.isEmpty) {
        editor.commands.setContent(md, { contentType: "markdown" });
      }
    });
    return () => {
      alive = false;
    };
  }, [editor, cwd, draftKey, tabId]);

  // Debounced autosave; cleared on submit by clearDraft.
  useEffect(() => {
    if (!editor || !cwd) return;
    let timer: number | undefined;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void saveDraft(cwd, draftKey, editor.getMarkdown());
      }, 500);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      window.clearTimeout(timer);
    };
  }, [editor, cwd, draftKey]);

  // Send to chat (K8): App forwards a terminal block's quotation to this tab
  // through pi:insert-draft. The text appends after the existing content with
  // a blank line between; inserting at the document end keeps the existing
  // text and its trailing whitespace untouched (no re-parse). The draft and
  // its source sidecar save at once, never debounced, and nothing sends.
  useEffect(() => {
    if (!editor || !cwd) return;
    let alive = true;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<InsertDraftDetail>).detail;
      if (!detail || detail.tabId !== tabId) return;
      if (typeof detail.text !== "string" || detail.text.length === 0) return;
      const existing = editor.getMarkdown();
      if (existing.length === 0) {
        editor.commands.setContent(detail.text, { contentType: "markdown" });
        editor.commands.focus("end");
      } else {
        // Appending as a sibling block (no separator in the payload) is what
        // keeps the serialized draft at one blank line between the existing
        // text and the quotation; the serializer adds it between blocks.
        const atEnd = editor.state.doc.content.size;
        editor
          .chain()
          .focus("end")
          .insertContentAt(atEnd, detail.text, { contentType: "markdown" })
          .run();
      }
      if (!alive) return;
      void saveDraft(cwd, draftKey, editor.getMarkdown());
      void loadDraftMeta(cwd, draftKey)
        .then((meta): ChatDraftMeta => meta ?? emptyChatMeta())
        .then((meta) => {
          meta.sources.push({
            blockId: detail.source.blockId,
            terminalId: detail.source.terminalId,
            sha256: detail.source.sha256,
            insertedAt: new Date().toISOString(),
          });
          return saveDraftMeta(cwd, draftKey, meta);
        })
        .catch(() => {
          // The sidecar is evidence, not load-bearing: a failed write still
          // leaves the quotation in the draft.
        });
    };
    window.addEventListener(INSERT_DRAFT_EVENT, handler);
    return () => {
      alive = false;
      window.removeEventListener(INSERT_DRAFT_EVENT, handler);
    };
  }, [editor, cwd, draftKey, tabId]);

  // A send pi refused (success:false response, or the write threw) and a
  // queued Remove hand their text back through the store: put it and its
  // image chips into the empty editor once, then clear the field so it
  // cannot rebind a later draft. The rejection reason itself stays on the
  // transcript's error card; while the editor holds typed text the restore
  // waits for it to empty again.
  const rejectedDraft = usePiStore((s) => s.tabs[tabId]?.rejectedDraft ?? null);
  const clearRejectedDraft = usePiStore((s) => s.clearRejectedDraft);
  useEffect(() => {
    if (!editor || !rejectedDraft) return;
    if (!editor.isEmpty) return;
    if (rejectedDraft.text) {
      editor.commands.setContent(rejectedDraft.text, {
        contentType: "markdown",
      });
    }
    let next = pendingImageSeq;
    setChips(
      rejectedDraft.images.map((img) => {
        next += 1;
        return {
          ...img,
          bytes: base64Bytes(img.data),
          id: next,
          name: `image ${next}`,
        };
      }),
    );
    pendingImageSeq = next;
    clearRejectedDraft(tabId);
  }, [editor, rejectedDraft, clearRejectedDraft, tabId]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      ref={rootRef}
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
      <div className="relative">
        {menuOpen && !disabled ? (
          <PromptMenu
            prompts={prompts}
            query={filterQuery}
            highlighted={Math.min(highlight, Math.max(0, filtered.length - 1))}
            onHighlight={setHighlight}
            onSelect={selectPrompt}
            onDismiss={() => {
              dismissMenuRef.current();
              editor?.commands.focus();
            }}
          />
        ) : null}
        <EditorContent editor={editor} />
      </div>
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
          data-uat="attach-images"
          disabled={disabled}
          onClick={() => void pickImages()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <HugeiconsIcon icon={ImageAdd01Icon} size={14} strokeWidth={1.75} />
        </button>
        <span
          ref={chipRef}
          data-uat="model-chip"
          className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
        >
          {model ?? "model unset"}
          {smol ? `, subagent ${smol}` : ""}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-uat="send-button"
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
