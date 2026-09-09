import { Extension, EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Cancel01Icon, ImageAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { native } from "@/lib/native";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  clearDraft,
  emptyChatMeta,
  draftPath,
  loadDraftRecord,
  removeDraftAttachment,
  saveDraft,
  updateDraftMeta,
  type ChatDraftMeta,
  type DraftAttachmentMeta,
  type DraftOriginalMeta,
} from "@/modules/pi/lib/drafts";
import { stableIdOf } from "@/modules/tabs/lib/sid";
import type { PiImageAttachment } from "@/modules/pi/lib/parse";
import { usePiStore, type ComposerImage } from "@/modules/pi/lib/piStore";
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

/**
 * UX-21: the chip shows the model's short name, the part after the last
 * slash capped at 24 characters, so long provider paths never push Send;
 * the title and the details popover carry the exact value.
 */
export function shortModelName(model: string): string {
  const tail = model.slice(model.lastIndexOf("/") + 1);
  return tail.length > 24 ? tail.slice(0, 24) : tail;
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
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** An encoded attachment: media type, base64 payload, decoded byte size. */
export type EncodedImage = PiImageAttachment & {
  bytes: number;
  original?: PiImageAttachment & { bytes: number };
};

/** A chip in the composer: an encoded image plus display metadata. K13: the
 *  chip is path-backed - the draft file under .pi/drafts carries the bytes
 *  the moment the chip appears. */
export type PendingImage = EncodedImage & {
  id: number;
  name: string;
  attachmentId: string;
  /** Project-relative draft file path; null until the write resolves. */
  draftPath: string | null;
  sha256: string | null;
  state: "draft" | "failed" | "missing" | "removing";
  error: string | null;
  originalFile?: DraftOriginalMeta;
};

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

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image bytes"));
    reader.readAsDataURL(blob);
  });
}

async function encodeImageBlob(blob: Blob): Promise<EncodedImage> {
  if (!IMAGE_MEDIA_TYPES.has(blob.type)) {
    throw new Error("Choose a PNG, JPEG, GIF or WebP image");
  }
  const source = { mediaType: blob.type, data: await blobBase64(blob), bytes: blob.size };
  if (blob.size <= MAX_TOTAL_IMAGE_BYTES) return source;
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
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!match) throw new Error("image encode failed");
  if (match[1] !== "image/jpeg") throw new Error("JPEG conversion is unavailable");
  return { mediaType: match[1], data: match[2], bytes: base64Bytes(match[2]), original: source };
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
 *  notice it returns when the image does not fit. A fitting image mints its
 *  stable attachment id here; the caller writes the draft file (K13). */
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
      notice:
        "Attachments would exceed the 4194304-byte (4 MiB) image budget",
    };
  }
  pendingImageSeq += 1;
  return {
    images: [
      ...current,
      {
        ...image,
        id: pendingImageSeq,
        attachmentId: `att-${crypto.randomUUID()}`,
        draftPath: null,
        sha256: null,
        state: "draft",
        error: null,
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
   *  false shows the one-line may-not-accept notice while attachments are
   *  queued. Sending never blocks: pi decides what to do with the images. */
  modelAcceptsImages?: boolean;
  onSubmit: (markdown: string, images: ComposerImage[]) => void | Promise<void>;
  onStop?: () => void;
};

/**
 * Reads the model chip data from the nearest pane root. ChatPane fills
 * data-pi-model, data-pi-smol and data-pi-provider from the store's resolved
 * session roles; until then the chip renders "model unset".
 */
function useModelChip(ref: React.RefObject<HTMLElement | null>) {
  const [model, setModel] = useState<string | null>(null);
  const [smol, setSmol] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const root =
        ref.current?.closest<HTMLElement>("[data-pi-model]") ??
        ref.current?.closest<HTMLElement>("[data-pi-smol]") ??
        ref.current?.closest<HTMLElement>("[data-pi-provider]");
      if (!root) return;
      const value = root.getAttribute("data-pi-model");
      setModel(value && value.trim() ? value : null);
      const smolValue = root.getAttribute("data-pi-smol");
      setSmol(smolValue && smolValue.trim() ? smolValue : null);
      const providerValue = root.getAttribute("data-pi-provider");
      setProvider(providerValue && providerValue.trim() ? providerValue : null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-pi-model", "data-pi-smol", "data-pi-provider"],
    });
    return () => observer.disconnect();
  }, [ref]);

  return { model, smol, provider };
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
  const recoveryKey = cwd ? `${cwd}/${draftKey}` : null;
  const [recoveredKey, setRecoveredKey] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const recovering = recoveredKey !== recoveryKey;
  const recoveryReadyRef = useRef(!recovering);
  recoveryReadyRef.current = !recovering;
  const pendingInsertions = useRef<InsertDraftDetail[]>([]);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const submittingRef = useRef(false);
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled || recovering;
  const chipRef = useRef<HTMLSpanElement>(null);
  const { model, smol, provider } = useModelChip(chipRef);
  // UX-21: one details affordance for the exact provider/model/role values.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);

  // Outside click and Escape close the popover; no focus trap, it is a read-only listing.
  useEffect(() => {
    if (!detailsOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!detailsRef.current?.contains(e.target as Node)) {
        setDetailsOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [detailsOpen]);

  const [images, setImages] = useState<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const relinkIdRef = useRef<number | null>(null);
  const chipWrites = useRef(new Map<number, Promise<PendingImage>>());
  const removingIds = useRef(new Set<number>());
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

  const metaRef = useRef<ChatDraftMeta | null>(null);
  const attachmentMeta = (chip: PendingImage): DraftAttachmentMeta => ({
    id: chip.attachmentId,
    path: chip.draftPath ?? "",
    sha256: chip.sha256 ?? "",
    mime: chip.mediaType,
    state: "draft",
    name: chip.name,
    ...(chip.originalFile ? { original: chip.originalFile } : {}),
  });

  const removeImage = async (id: number) => {
    const chip = imagesRef.current.find((img) => img.id === id);
    if (!chip || removingIds.current.has(id)) return;
    setNotice(null);
    if (!cwd) {
      setChips(imagesRef.current.filter((img) => img.id !== id));
      return;
    }
    removingIds.current.add(id);
    setChips(imagesRef.current.map((img) => img.id === id ? { ...img, state: "removing" } : img));
    try {
      const saved = (await chipWrites.current.get(id)) ?? chip;
      metaRef.current = await removeDraftAttachment(cwd, draftKey, attachmentMeta(saved));
      setChips(imagesRef.current.filter((img) => img.id !== id));
    } catch (error) {
      setChips(imagesRef.current.map((img) => img.id === id ? { ...img, state: chip.state } : img));
      setNotice(`Could not remove ${chip.name}: ${String(error)}. Try Remove again.`);
    } finally {
      removingIds.current.delete(id);
    }
  };

  // Writes the chip's bytes to the draft file at once (K13): the chip is
  // path-backed before anything can be sent. Failures stand on the chip.
  const writeChipDraft = async (chip: PendingImage): Promise<PendingImage> => {
    if (!cwd) return chip;
    try {
      const res = await invoke<{ path: string; sha256: string; original?: DraftOriginalMeta }>(
        "pi_save_draft_attachment",
        {
          cwd,
          tabId: draftKey,
          attachmentId: chip.attachmentId,
          mediaType: chip.mediaType,
          data: chip.data,
          ...(chip.original ? { original: chip.original } : {}),
          workspace: currentWorkspaceEnv(),
        },
      );
      return {
        ...chip,
        draftPath: res.path,
        sha256: res.sha256,
        state: "draft",
        error: null,
        original: undefined,
        originalFile: res.original ?? chip.originalFile,
      };
    } catch (e) {
      return {
        ...chip,
        state: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  const persistChip = (chip: PendingImage) => {
    const job = (async () => {
      const updated = await writeChipDraft(chip);
      if (cwd && updated.draftPath && updated.state === "draft") {
        try {
          const entry = attachmentMeta(updated);
          metaRef.current = await updateDraftMeta(cwd, draftKey, (meta) => ({
            ...meta,
            attachments: [...meta.attachments.filter((att) => att.id !== entry.id), entry],
          }));
        } catch (error) {
          updated.state = "failed";
          updated.error = `Could not save the draft record: ${String(error)}`;
        }
      }
      if (!removingIds.current.has(chip.id)) {
        setChips(imagesRef.current.map((img) => img.id === chip.id ? updated : img));
      }
      return updated;
    })();
    chipWrites.current.set(chip.id, job);
    void job.finally(() => {
      if (chipWrites.current.get(chip.id) === job) chipWrites.current.delete(chip.id);
    });
    return job;
  };

  // Shared by paste, drop and the attach button: encode each image, then let
  // appendPendingImage decide whether it fits under the caps. A rejected
  // image writes no draft file: existing chips and their files stand.
  const addFiles = async (files: File[]) => {
    if (disabledRef.current) return;
    setNotice(null);
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      let encoded: EncodedImage;
      try {
        encoded = await imageEncoder.encode(file);
      } catch (error) {
        setNotice(`Could not read ${file.name || "that image"}: ${String(error)}`);
        continue;
      }
      const result = appendPendingImage(
        imagesRef.current,
        encoded,
        file.name || "",
      );
      setChips(result.images);
      if (result.notice) {
        setNotice(result.notice);
        continue;
      }
      const added = result.images[result.images.length - 1];
      if (added) void persistChip(added);
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
        if (result.notice) {
          setNotice(result.notice);
          continue;
        }
        const added = result.images[result.images.length - 1];
        if (added) void persistChip(added);
      } catch (error) {
        setNotice(`Could not read ${name}: ${String(error)}`);
      }
    }
  };
  const addImagePathsRef = useRef(addImagePaths);
  addImagePathsRef.current = addImagePaths;

  const relinkImage = async (id: number, blob: Blob, name: string) => {
    const chip = imagesRef.current.find((img) => img.id === id);
    if (!chip || chip.state !== "missing") return;
    try {
      const encoded = await imageEncoder.encode(blob);
      if (!imagesRef.current.some((img) => img.id === id && img.state === "missing")) return;
      const result = appendPendingImage(imagesRef.current.filter((img) => img.id !== id), encoded, name);
      if (result.notice) {
        setNotice(result.notice);
        return;
      }
      const replacement: PendingImage = {
        ...chip, ...encoded, name, originalFile: undefined, error: null,
        draftPath: null, sha256: null, state: "draft",
      };
      setChips(imagesRef.current.map((img) => img.id === id ? replacement : img));
      const saved = await persistChip(replacement);
      if (saved.state === "draft") {
        setNotice(null);
      } else if (!removingIds.current.has(id)) {
        setChips(imagesRef.current.map((img) => img.id === id ? chip : img));
        setNotice(`Could not relink ${chip.name}: ${saved.error}. Choose the file again.`);
      }
    } catch (error) {
      setNotice(`Could not relink ${chip.name}: ${String(error)}. Choose the file again.`);
    }
  };

  const restorePickerFocus = async () => {
    // Return native window focus as well as editor focus after dismissal.
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFocus();
    } catch {
      // Browser fallback has no native window.
    }
    if (editor && !editor.isDestroyed && editor.view.dom.isConnected) {
      editor.view.dom.focus({ preventScroll: true });
    }
  };

  const pickRelink = async (id: number) => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const bytes = await native.readFileBytes(path);
      await relinkImage(id, bytesToBlob(bytes.base64, bytes.mimeType), path.split(/[\\/]/).pop() || path);
    } catch (error) {
      relinkIdRef.current = id;
      relinkInputRef.current?.click();
      setNotice(`Relink file picker: ${String(error)}. Choose an image file.`);
    } finally {
      await restorePickerFocus();
    }
  };

  // Attach button: the Tauri file dialog (image filter, multiple) plus the
  // bytes bridge. The hidden input stays as the fallback when the dialog is
  // unavailable; every return path restores the composer focus.
  const pickImages = async () => {
    try {
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
    } finally {
      await restorePickerFocus();
    }
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
        tabindex: "0",
      },
    },
  });

  // Send clears the editor, the chips and any cap notice. K13: with
  // attachments the draft record survives the send - the store runs the
  // transaction (stage, index on ack, or state "failed" on refusal), so
  // clearing here would drop the record a failed send must leave behind.
  // An empty message with attached images still sends (image-only prompt).
  const performSubmit = (): boolean => {
    if (!editor || disabledRef.current || submittingRef.current) return false;
    const md = editor.getMarkdown().trim();
    if (chipWrites.current.size > 0 || imagesRef.current.some((img) => img.state === "removing" && img.data)) {
      setNotice("Saving attachment changes. Send again when the draft is ready.");
      return true;
    }
    const missing = imagesRef.current.filter((img) => !img.data);
    const attachments: ComposerImage[] = imagesRef.current.filter((img) => img.data).map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
      attachmentId: img.attachmentId,
      draftPath: img.draftPath,
      sha256: img.sha256,
    }));
    if (!md && attachments.length === 0) {
      if (missing.length > 0) setNotice("Add text to send, or Remove or Relink the missing attachment.");
      return true;
    }
    const omission = missing.length
      ? `Missing attachment${missing.length === 1 ? "" : "s"} omitted from submission: ${missing.map((img) => img.name).join(", ")}.`
      : null;
    const clearSubmitted = () => {
      if (editor.getMarkdown().trim() === md) editor.commands.clearContent();
      for (const chip of missing) {
        if (cwd) void removeDraftAttachment(cwd, draftKey, attachmentMeta(chip)).catch((error) => {
          setNotice(`Missing attachment omitted from submission. Could not update the draft: ${String(error)}`);
        });
      }
      const submitted = new Set([...attachments.map((a) => a.attachmentId), ...missing.map((a) => a.attachmentId)]);
      setChips(imagesRef.current.filter((a) => !submitted.has(a.attachmentId)));
      if (metaRef.current) metaRef.current = { ...metaRef.current, attachments: metaRef.current.attachments.filter((a) => !submitted.has(a.id)) };
      setNotice(omission);
      if (cwd && attachments.length === 0 && editor.isEmpty) void clearDraft(cwd, draftKey).catch((error) => setNotice(String(error)));
    };
    try {
      const pending = submitRef.current(md, attachments);
      if (pending) {
        submittingRef.current = true;
        void pending.then(clearSubmitted).catch((error) => {
          const rejected = usePiStore.getState().tabs[tabId]?.rejectedDraft;
          if (editor.getMarkdown().trim() === md && rejected?.text === md) usePiStore.getState().clearRejectedDraft(tabId);
          setNotice(String(error));
        }).finally(() => { submittingRef.current = false; });
      } else clearSubmitted();
    } catch (error) { setNotice(String(error)); }
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

  useEffect(() => {
    if (!editor || !cwd) return;
    let alive = true;
    setRecoveryError(null);
    void loadDraftRecord(cwd, draftKey).then(async (record) => {
      if (!alive) return;
      if (record?.kind === "editor") throw new Error("This draft belongs to an editor tab");
      const meta = record?.meta ?? emptyChatMeta();
      const base = cwd.replace(/[\\/]+$/, "");
      const restored: PendingImage[] = [];
      const queuedIds = new Set(meta.queue?.flatMap((q) => q.attachmentIds));
      for (const id of queuedIds) {
        const sequence = /^att-(\d+)$/.exec(id);
        if (sequence) pendingImageSeq = Math.max(pendingImageSeq, Number(sequence[1]));
      }
      for (const att of meta.attachments.filter((a) => !queuedIds.has(a.id))) {
        let data = "";
        let error: string | null = null;
        try {
          const bytes = await invoke<{ base64: string }>(
            "fs_read_file_bytes",
            { path: `${base}/${att.path}`, workspace: currentWorkspaceEnv() },
          );
          if (!bytes.base64) throw new Error("Image file is empty");
          const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(atob(bytes.base64), (c) => c.charCodeAt(0)));
          const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
          if (sha256 !== att.sha256) throw new Error("Image file no longer matches its saved SHA-256");
          data = bytes.base64;
        } catch (reason) {
          error = `Could not recover attachment ${att.path}: ${String(reason)}`;
        }
        pendingImageSeq += 1;
        restored.push({
          mediaType: att.mime,
          data,
          bytes: base64Bytes(data),
          id: pendingImageSeq,
          attachmentId: att.id,
          draftPath: att.path,
          sha256: att.sha256,
          state: error ? "missing" : "draft",
          error,
          name: att.name || att.path.split(/[\\/]/).pop() || att.id,
          originalFile: att.original,
        });
      }
      if (!alive) return;
      metaRef.current = {
        ...meta,
        submissionId: null,
        attachments: meta.attachments.filter((a) => !queuedIds.has(a.id)).map((a) => ({ ...a, state: "draft" })),
      };
      if (record?.markdown) editor.commands.setContent(record.markdown, { contentType: "markdown" });
      setChips(restored);
      setRecoveredKey(recoveryKey);
    }).catch((reason) => {
      if (alive) setRecoveryError(`${draftPath(cwd, draftKey)}: ${String(reason)}`);
    });
    return () => {
      alive = false;
    };
  }, [editor, cwd, draftKey, recoveryKey, recoveryAttempt]);

  // Debounced autosave; cleared on submit by clearDraft.
  useEffect(() => {
    if (!editor || !cwd) return;
    let timer: number | undefined;
    const onUpdate = () => {
      if (!recoveryReadyRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void saveDraft(cwd, draftKey, editor.getMarkdown()).catch((reason) => {
          setNotice(`Could not save ${draftPath(cwd, draftKey)}: ${String(reason)}`);
        });
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
      if (!recoveryReadyRef.current) {
        pendingInsertions.current.push(detail);
        return;
      }
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
      void updateDraftMeta(cwd, draftKey, (meta) => ({
        ...meta,
        sources: [...meta.sources, {
            blockId: detail.source.blockId,
            terminalId: detail.source.terminalId,
            sha256: detail.source.sha256,
            insertedAt: new Date().toISOString(),
        }],
      }))
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

  useEffect(() => {
    if (recovering) return;
    for (const detail of pendingInsertions.current.splice(0)) {
      window.dispatchEvent(new CustomEvent(INSERT_DRAFT_EVENT, { detail }));
    }
  }, [recovering]);

  // A send pi refused (success:false response, or the write threw) and a
  // queue Edit hand their text back through the store: put it and its
  // image chips into the empty editor once, then clear the field so it
  // cannot rebind a later draft. The rejection reason itself stays on the
  // transcript's error card; while the editor holds typed text the restore
  // waits for it to empty again. K13: chips adopt their failed records'
  // stable ids and draft paths (the record keeps state "failed" until the
  // submission is retried or resent); images without a record get a draft
  // file written at once.
  const rejectedDraft = usePiStore((s) => s.tabs[tabId]?.rejectedDraft ?? null);
  const clearRejectedDraft = usePiStore((s) => s.clearRejectedDraft);
  useEffect(() => {
    if (!editor || !rejectedDraft || recovering) return;
    if (!rejectedDraft.queueReturn && !editor.isEmpty) return;
    if (rejectedDraft.text) {
      const text = rejectedDraft.queueReturn && !editor.isEmpty
        ? `${editor.getMarkdown()}\n\n${rejectedDraft.text}` : rejectedDraft.text;
      editor.commands.setContent(text, {
        contentType: "markdown",
      });
    }
    let next = pendingImageSeq;
    const restored: PendingImage[] = rejectedDraft.images.map((img, i) => {
      const record = rejectedDraft.records?.[i];
      next += 1;
      const draftPath = record?.draftPath ?? null;
      return {
        ...img,
        bytes: base64Bytes(img.data),
        id: next,
        attachmentId: record?.attachmentId ?? `att-${crypto.randomUUID()}`,
        draftPath,
        sha256: record?.sha256 ?? null,
        state: "draft",
        error: null,
        originalFile: metaRef.current?.attachments.find((att) => att.id === record?.attachmentId)?.original,
        name: draftPath
          ? draftPath.split(/[\\/]/).pop() || `image ${next}`
          : `image ${next}`,
      };
    });
    pendingImageSeq = next;
    setChips(rejectedDraft.queueReturn ? [...imagesRef.current, ...restored] : restored);
    if (rejectedDraft.queueReturn) {
      editor.commands.focus("end");
      if (cwd) void saveDraft(cwd, draftKey, editor.getMarkdown()).catch((error) => setNotice(String(error)));
      for (const chip of restored) {
        if (cwd && chip.draftPath) void updateDraftMeta(cwd, draftKey, (meta) => ({
          ...meta, attachments: [...meta.attachments.filter((att) => att.id !== chip.attachmentId), { ...meta.attachments.find((att) => att.id === chip.attachmentId), ...attachmentMeta(chip) }],
        })).catch((error) => setNotice(String(error)));
      }
    }
    clearRejectedDraft(tabId);
    for (const chip of restored) {
      if (!chip.draftPath) void persistChip(chip);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, rejectedDraft, clearRejectedDraft, tabId, recovering]);

  useEffect(() => {
    editor?.setEditable(!disabled && !recovering);
  }, [editor, disabled, recovering]);

  const missingImages = images.filter((img) => !img.data);
  const recoveryMessage = recoveryError ?? (missingImages.length
    ? `${missingImages.map((img) => img.error ?? img.draftPath ?? img.name).join("; ")}. Remove or Relink the missing attachment. Text can still be sent.`
    : null);

  return (
    <div
      ref={rootRef}
      className={cn(
        "shrink-0 border-t border-border/60 p-2",
        dragActive && "rounded-md ring-1 ring-ring",
      )}
      onKeyDownCapture={(event) => {
        if (recovering && event.key === "Escape" && stopRef.current) {
          event.preventDefault();
          event.stopPropagation();
          stopRef.current();
        }
      }}
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
      {recovering && !recoveryError && <p aria-live="polite" className="mb-1.5 text-xs text-muted-foreground">Recovering draft...</p>}
      {recoveryMessage && (
        <div role="alert" className="mb-1.5 text-xs text-destructive">
          Draft recovery failed: {recoveryMessage}
          {recovering && <button type="button" className="ml-2 underline" onClick={() => setRecoveryAttempt((attempt) => attempt + 1)}>Retry recovery</button>}
        </div>
      )}
      {images.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap items-start gap-2">
          {images.map((img) => (
            <span
              key={img.id}
              data-uat="attachment-chip"
              data-uat-key={img.attachmentId}
              data-state={img.state}
              className="relative inline-flex max-w-48 flex-col gap-0.5"
            >
              <span className="relative inline-flex">
                {img.data ? (
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                    className="size-14 rounded-md border border-border/60 object-cover"
                  />
                ) : (
                  <span
                    aria-label={img.name}
                    className="grid size-14 place-items-center rounded-md border border-destructive/40 bg-destructive/10 text-[10px] text-destructive"
                  >
                    missing
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${img.name}`}
                  data-uat="attachment-remove"
                  data-uat-key={img.attachmentId}
                  disabled={img.state === "removing"}
                  onClick={() => void removeImage(img.id)}
                  // Padding, not a bigger glyph: the hit area clears 24 px.
                  className="absolute -right-2 -top-2 rounded-full border border-border/60 bg-background p-2 text-muted-foreground hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={10}
                    strokeWidth={2}
                  />
                </button>
              </span>
              {img.state === "missing" && (
                <button type="button" aria-label={`Relink ${img.name}`} data-uat="attachment-relink" data-uat-key={img.attachmentId}
                  className="self-start rounded px-1 py-1 text-xs underline" onClick={() => void pickRelink(img.id)}>Relink</button>
              )}
              {img.state === "failed" && img.data && (
                <button type="button" aria-label={`Retry save ${img.name}`} className="self-start rounded px-1 py-1 text-xs underline"
                  onClick={() => void persistChip(img)}>Retry save</button>
              )}
              {(img.originalFile || img.original) && (
                <span data-uat="attachment-conversion" data-uat-key={img.attachmentId} title={img.originalFile?.path} className="max-w-48 text-xs text-muted-foreground">
                  converted to JPEG, original {((img.originalFile?.bytes ?? img.original?.bytes ?? 0) / 1_000_000).toFixed(1)} MB
                </span>
              )}
              {/* The draft file the chip is backed by (K13); a failed write
                  or a missing file stands visible in place of the path. */}
              <span
                title={img.error ?? img.draftPath ?? undefined}
                className={cn(
                  "max-w-48 truncate font-mono text-[10px]",
                  img.error ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {img.error ?? img.draftPath ?? "writing..."}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {notice ? (
        <div role="status" data-uat="attachment-notice" className="mb-1.5 text-xs text-destructive">{notice}</div>
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
      {/* The "vision unknown" notice is attach-time: it appears only while
          attachments are queued, never as empty-composer text (R8.2). */}
      {images.length > 0 && modelAcceptsImages !== true ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          This model may not accept images; pi decides what to do with them.
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(",")}
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
        <input ref={relinkInputRef} type="file" accept={IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(",")} className="hidden" tabIndex={-1} aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            const id = relinkIdRef.current;
            event.target.value = "";
            relinkIdRef.current = null;
            if (file && id !== null) void relinkImage(id, file, file.name);
          }} />
        <button
          type="button"
          aria-label="Attach images"
          title="Attach images"
          data-uat="attach-images"
          disabled={disabled || recovering}
          onClick={() => void pickImages()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <HugeiconsIcon icon={ImageAdd01Icon} size={14} strokeWidth={1.75} />
        </button>
        {/* Short model name only (UX-21): the exact provider/model/role
            values live in the title and the details popover, so a long
            identifier cannot push Send around at narrow widths. */}
        <span
          ref={chipRef}
          data-uat="model-chip"
          title={
            model
              ? `provider ${provider ?? "unknown"}, model ${model}${smol ? `, smol ${smol}` : ""}`
              : undefined
          }
          className="min-w-0 max-w-48 truncate rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
        >
          {model ? shortModelName(model) : "model unset"}
          {smol ? `, subagent ${shortModelName(smol)}` : ""}
        </span>
        <div ref={detailsRef} className="relative shrink-0">
          <button
            type="button"
            aria-label="Model details"
            title="Model details"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
            className="rounded-md border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            details
          </button>
          {detailsOpen ? (
            <div
              role="dialog"
              aria-label="Model details"
              className="absolute bottom-7 left-0 z-20 w-72 rounded-md border border-border/60 bg-popover p-2 text-xs shadow-md"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-muted-foreground">provider</span>
                <span className="truncate">{provider ?? "unknown"}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-muted-foreground">model</span>
                <span className="truncate">{model ?? "unknown"}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-muted-foreground">smol</span>
                <span className="truncate">{smol ?? "unknown"}</span>
              </div>
            </div>
          ) : null}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          data-uat="send-button"
          onClick={() => performSubmitRef.current()}
          disabled={disabled || recovering}
          className="h-7 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
