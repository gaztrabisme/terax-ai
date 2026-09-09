// @vitest-environment jsdom
import { Editor } from "@tiptap/react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendPendingImage,
  autolinkable,
  base64Bytes,
  composerExtensions,
  imageEncoder,
  imagePathsOf,
  shortModelName,
  MAX_ATTACHMENTS,
  MAX_TOTAL_IMAGE_BYTES,
  type EncodedImage,
  type PendingImage,
} from "./Composer";

const { invokeMock, dialogOpenMock, dragDropHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dialogOpenMock: vi.fn(),
  dragDropHandlers: [] as ((e: unknown) => void)[],
}));

// The composer's draft calls must resolve without Tauri; fs_read_file answers
// with a seedable draft so tests can put text into the editor headlessly.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// jsdom has no webview: hand the drag-drop handler to the tests instead.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (e: unknown) => void) => {
      dragDropHandlers.push(handler);
      return Promise.resolve(() => {
        const at = dragDropHandlers.indexOf(handler);
        if (at !== -1) dragDropHandlers.splice(at, 1);
      });
    },
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }));

import { usePiStore } from "@/modules/pi/lib/piStore";
import type { InsertDraftDetail } from "@/modules/pi/lib/sendToChat";
import { Composer } from "./Composer";

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

/// ---------------------------------------------------------------------------
/// Image attachments
/// ---------------------------------------------------------------------------

let encodeCalls = 0;
const realEncode = imageEncoder.encode;

beforeEach(() => {
  encodeCalls = 0;
  // ProseMirror's own drop/paste handlers probe coordinates; jsdom has no
  // layout, so the probe reports "no element" and the handler bails.
  document.elementFromPoint = () => null;
  dragDropHandlers.length = 0;
  dialogOpenMock.mockReset();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({ kind: "text", content: "" }));
  // jsdom has no canvas: stand in for the downscale and re-encode.
  imageEncoder.encode = async (blob: Blob) => {
    encodeCalls += 1;
    const name = (blob as File).name || `img-${encodeCalls}`;
    return {
      mediaType: "image/png",
      data: btoa(`encoded-${name}`),
      bytes: 1000,
    };
  };
});

afterEach(() => {
  imageEncoder.encode = realEncode;
  cleanup();
});

function imageFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });
}

function pasteFiles(el: Element, files: File[]): void {
  fireEvent.paste(el, {
    clipboardData: {
      // ProseMirror's paste rules read getData even when only image items ride
      // on the clipboard.
      getData: () => "",
      items: files.map((f) => ({
        kind: "file",
        type: f.type,
        getAsFile: () => f,
      })),
    },
  } as unknown as ClipboardEventInit);
}

function renderComposer(
  onSubmit = vi.fn(),
  props: Partial<Parameters<typeof Composer>[0]> = {},
) {
  const utils = render(<Composer tabId={7} onSubmit={onSubmit} {...props} />);
  const pm = utils.container.querySelector(
    "[aria-label='pi composer']",
  ) as Element;
  return { ...utils, onSubmit, pm };
}

describe("composer model chip", () => {
  const MODEL = "opendev/custom-namespace/very-long-model-identifier-x9";

  function renderWithRoles() {
    return render(
      <div
        data-pi-model={MODEL}
        data-pi-provider="openrouter"
        data-pi-smol="omlx/qwen3-small"
      >
        <Composer tabId={7} onSubmit={vi.fn()} />
      </div>,
    );
  }

  it("shortens the model name to the part after the last slash, max 24 characters", () => {
    expect(shortModelName("anthropic/claude-sonnet-4-5")).toBe(
      "claude-sonnet-4-5",
    );
    expect(shortModelName("plain-model")).toBe("plain-model");
    expect(shortModelName(MODEL).length).toBeLessThanOrEqual(24);
    expect(shortModelName(MODEL)).toBe(
      MODEL.slice(MODEL.lastIndexOf("/") + 1).slice(0, 24),
    );
  });

  it("shows the short name, keeps the exact value in the title and lists all three values in the details popover", async () => {
    const { container } = renderWithRoles();
    const chip = await waitFor(() => {
      const el = container.querySelector('[data-uat="model-chip"]')!;
      expect(el.textContent).not.toBe("model unset");
      return el as HTMLElement;
    });
    // Short name on the chip, exact model in the title tooltip.
    expect(chip.textContent).toBe(
      `${shortModelName(MODEL)}, subagent ${shortModelName("omlx/qwen3-small")}`,
    );
    expect(chip.getAttribute("title")).toBe(
      `provider openrouter, model ${MODEL}, smol omlx/qwen3-small`,
    );

    // The one details affordance lists provider, model and role exactly.
    fireEvent.click(
      container.querySelector("button[aria-label='Model details']")!,
    );
    const popover = container.querySelector("[role='dialog']")!;
    expect(popover.textContent).toContain("provider");
    expect(popover.textContent).toContain("openrouter");
    expect(popover.textContent).toContain(MODEL);
    expect(popover.textContent).toContain("smol");
    expect(popover.textContent).toContain("omlx/qwen3-small");

    // The details button keeps Send aligned: both stay shrink-0 siblings.
    const send = container.querySelector("button[data-uat='send-button']")!;
    expect(send).toBeTruthy();
  });

  it("renders model unset without roles and lists unknown values in the popover", async () => {
    const { container } = render(<Composer tabId={8} onSubmit={vi.fn()} />);
    await waitFor(() => {
      const el = container.querySelector('[data-uat="model-chip"]')!;
      expect(el.textContent).toBe("model unset");
    });
    expect(
      container.querySelector('[data-uat="model-chip"]')!.getAttribute("title"),
    ).toBeNull();
    fireEvent.click(
      container.querySelector("button[aria-label='Model details']")!,
    );
    const popover = container.querySelector("[role='dialog']")!;
    expect(popover.textContent).toContain("unknown");
  });
});

describe("composer image chips", () => {
  it("turns a pasted image into a thumbnail chip", async () => {
    const { container, onSubmit } = renderComposer();
    pasteFiles(container.querySelector("[aria-label='pi composer']")!, [
      imageFile("shot.png"),
    ]);
    const chip = await waitFor(() => {
      const img = container.querySelector("img[alt='shot.png']");
      expect(img).toBeTruthy();
      return img as HTMLImageElement;
    });
    expect(chip.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drops image files from a drag onto chips", async () => {
    const { container } = renderComposer();
    const composer = container.querySelector("[aria-label='pi composer']")!;
    fireEvent.drop(composer, {
      dataTransfer: {
        getData: () => "",
        files: [imageFile("dropped.png")],
      },
    } as unknown as DragEventInit);
    await waitFor(() => {
      expect(container.querySelector("img[alt='dropped.png']")).toBeTruthy();
    });
  });

  it("removes a chip from its remove control", async () => {
    const { container } = renderComposer();
    pasteFiles(container.querySelector("[aria-label='pi composer']")!, [
      imageFile("a.png"),
      imageFile("b.png"),
    ]);
    await waitFor(() => {
      expect(container.querySelectorAll("img")).toHaveLength(2);
    });
    fireEvent.click(
      container.querySelector("button[aria-label='Remove a.png']")!,
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img[alt='b.png']")).toBeTruthy();
    expect(
      container.querySelector("button[aria-label='Remove a.png']"),
    ).toBeNull();
  });

  it("shows the cap notice past the fifth image and adds no chip", async () => {
    const { container } = renderComposer();
    pasteFiles(container.querySelector("[aria-label='pi composer']")!, [
      imageFile("i1.png"),
      imageFile("i2.png"),
      imageFile("i3.png"),
      imageFile("i4.png"),
      imageFile("i5.png"),
      imageFile("i6.png"),
    ]);
    await waitFor(() => {
      expect(container.querySelectorAll("img")).toHaveLength(MAX_ATTACHMENTS);
    });
    expect(container.textContent).toContain(
      `Attachment limit is ${MAX_ATTACHMENTS} images`,
    );
    expect(container.querySelectorAll("img")).toHaveLength(MAX_ATTACHMENTS);
  });

  it("warns when the model may not accept images, only once something is attached", async () => {
    const { container } = renderComposer(vi.fn(), {
      modelAcceptsImages: false,
    });
    // The unknown-capability notice is attach-time: an empty composer shows
    // no standing notice (R8.2).
    expect(container.textContent).not.toContain("may not accept images");
    pasteFiles(container.querySelector("[aria-label='pi composer']")!, [
      imageFile("shot.png"),
    ]);
    await waitFor(() => {
      expect(container.textContent).toContain("may not accept images");
    });
    expect(
      container.querySelector("button[aria-label='Attach images']"),
    ).toBeTruthy();
  });

  it("shows no images notice when the model accepts images", () => {
    const { container } = renderComposer(vi.fn(), {
      modelAcceptsImages: true,
    });
    expect(container.textContent).not.toContain("may not accept images");
    expect(
      container.querySelector("button[aria-label='Attach images']"),
    ).toBeTruthy();
  });
});

describe("composer send with images", () => {
  it("passes text and encoded images to onSubmit and clears the chips", async () => {
    // Draft restore is the headless way to put text into the editor.
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "fs_read_file"
        ? { kind: "text", content: "what is this" }
        : { kind: "ok" },
    );
    const { container, onSubmit } = renderComposer(vi.fn(), {
      cwd: "/tmp/proj",
    });
    const composer = container.querySelector("[aria-label='pi composer']")!;
    await waitFor(() => {
      expect(composer.textContent).toContain("what is this");
    });
    pasteFiles(composer, [imageFile("shot.png")]);
    await waitFor(() => {
      expect(container.querySelector("img[alt='shot.png']")).toBeTruthy();
    });

    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Send",
      )!,
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      "what is this",
      [expect.objectContaining({
        mediaType: "image/png",
        data: btoa("encoded-shot.png"),
        attachmentId: expect.stringMatching(/^att-\d+$/),
      })],
    );
    await waitFor(() => {
      expect(container.querySelectorAll("img")).toHaveLength(0);
    });
  });

  it("sends an image-only prompt when the text is empty", async () => {
    const { container, onSubmit } = renderComposer();
    pasteFiles(container.querySelector("[aria-label='pi composer']")!, [
      imageFile("only.png"),
    ]);
    await waitFor(() => {
      expect(container.querySelector("img[alt='only.png']")).toBeTruthy();
    });

    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Send",
      )!,
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      "",
      [expect.objectContaining({
        mediaType: "image/png",
        data: btoa("encoded-only.png"),
      })],
    );
    await waitFor(() => {
      expect(container.querySelectorAll("img")).toHaveLength(0);
    });
  });

  it("sends nothing when the composer is empty", () => {
    const { onSubmit } = renderComposer();
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Send",
      )!,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("appendPendingImage caps", () => {
  const encoded: EncodedImage = {
    mediaType: "image/png",
    data: "AAAA",
    bytes: 10,
  };

  it("rejects the sixth image with the count notice", () => {
    let chips: PendingImage[] = [];
    for (let i = 0; i < MAX_ATTACHMENTS; i++) {
      const result = appendPendingImage(chips, encoded, `i${i}.png`);
      expect(result.notice).toBeNull();
      chips = result.images;
    }
    expect(chips).toHaveLength(MAX_ATTACHMENTS);
    const over = appendPendingImage(chips, encoded, "i6.png");
    expect(over.images).toBe(chips);
    expect(over.notice).toBe(`Attachment limit is ${MAX_ATTACHMENTS} images`);
  });

  it("rejects images past the 4 MB encoded budget with a notice", () => {
    const first = appendPendingImage(
      [],
      { ...encoded, bytes: MAX_TOTAL_IMAGE_BYTES },
      "big.png",
    );
    expect(first.notice).toBeNull();
    expect(first.images).toHaveLength(1);
    const second = appendPendingImage(
      first.images,
      { ...encoded, bytes: 1 },
      "one.png",
    );
    expect(second.images).toBe(first.images);
    expect(second.notice).toBe(
      "Attachments would exceed the 4194304-byte (4 MiB) image budget",
    );
  });
});

describe("base64Bytes", () => {
  it("counts decoded bytes including padding", () => {
    expect(base64Bytes("QQ==")).toBe(1);
    expect(base64Bytes("QQ=")).toBe(1);
    expect(base64Bytes("QQ")).toBe(1);
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("")).toBe(0);
  });
});

describe("imagePathsOf", () => {
  it("keeps only paths with an image extension", () => {
    expect(
      imagePathsOf(["/a/shot.PNG", "/a/notes.txt", "/b/face.jpeg", "/c/.png"]),
    ).toEqual(["/a/shot.PNG", "/b/face.jpeg"]);
  });
});

describe("composer attach dialog", () => {
  it("reads picked paths through the bytes bridge into chips", async () => {
    dialogOpenMock.mockResolvedValue(["/tmp/art/one.png", "/tmp/art/two.jpg"]);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "fs_read_file_bytes"
        ? { base64: btoa("rawbytes"), mimeType: "image/png", size: 8 }
        : { kind: "text", content: "" },
    );
    const { container } = renderComposer();
    fireEvent.click(
      container.querySelector("button[aria-label='Attach images']")!,
    );
    await waitFor(() => {
      expect(container.querySelector("img[alt='one.png']")).toBeTruthy();
    });
    expect(container.querySelector("img[alt='two.jpg']")).toBeTruthy();
  });

  it("falls back to the hidden input when the dialog is unavailable", async () => {
    dialogOpenMock.mockRejectedValue(new Error("dialog plugin missing"));
    const { container } = renderComposer();
    const input = container.querySelector(
      "input[type='file']",
    ) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(
      container.querySelector("button[aria-label='Attach images']")!,
    );
    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("does nothing when the dialog is cancelled", async () => {
    dialogOpenMock.mockResolvedValue(null);
    const { container } = renderComposer();
    const input = container.querySelector(
      "input[type='file']",
    ) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(
      container.querySelector("button[aria-label='Attach images']")!,
    );
    await waitFor(() => {
      expect(dialogOpenMock).toHaveBeenCalled();
    });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("composer OS drag and drop", () => {
  function dropAt(
    container: HTMLElement,
    paths: string[],
    inside: boolean,
  ): void {
    const composer = container.querySelector("[aria-label='pi composer']");
    const anchor = composer?.parentElement ?? document.body;
    document.elementFromPoint = inside
      ? () => anchor
      : () => document.body.parentElement; // outside the composer root
    const handler = dragDropHandlers[dragDropHandlers.length - 1];
    expect(handler).toBeTruthy();
    handler!({
      payload: { type: "drop", paths, position: { x: 6, y: 6 } },
    });
  }

  it("turns drops inside the composer into chips via the bridge", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "fs_read_file_bytes"
        ? { base64: btoa("rawbytes"), mimeType: "image/png", size: 8 }
        : { kind: "text", content: "" },
    );
    const { container } = renderComposer();
    await waitFor(() => {
      expect(dragDropHandlers.length).toBeGreaterThan(0);
    });
    dropAt(container, ["/tmp/dropped.png", "/tmp/skip.txt"], true);
    await waitFor(() => {
      expect(container.querySelector("img[alt='dropped.png']")).toBeTruthy();
    });
    expect(container.querySelector("img[alt='skip.txt']")).toBeNull();
  });

  it("ignores drops outside the composer so the terminal handler keeps them", async () => {
    const { container } = renderComposer();
    await waitFor(() => {
      expect(dragDropHandlers.length).toBeGreaterThan(0);
    });
    dropAt(container, ["/tmp/dropped.png"], false);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalledWith("fs_read_file_bytes", {
      path: "/tmp/dropped.png",
      workspace: expect.anything(),
    });
  });
});

// A send pi refused (or a queued Remove) lands in the store as
// rejectedDraft; the composer restores it into the empty editor once.
describe("composer rejected draft restore", () => {
  const draft = {
    text: "second look",
    images: [{ mediaType: "image/png", data: btoa("chip") }],
    error: "Agent is currently streaming; specify streamingBehavior",
  };

  afterEach(() => {
    usePiStore.setState({ tabs: {} });
  });

  it("restores the rejected text and chips once and clears the store", async () => {
    const { container } = renderComposer();
    usePiStore.setState({
      tabs: { 7: { rejectedDraft: draft } } as never,
    });
    const composer = container.querySelector("[aria-label='pi composer']")!;
    await waitFor(() => {
      expect(composer.textContent).toContain("second look");
    });
    await waitFor(() => {
      expect(container.querySelectorAll("img")).toHaveLength(1);
    });
    expect(usePiStore.getState().tabs[7]?.rejectedDraft ?? null).toBeNull();
  });

  it("waits when the editor already holds typed text", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "fs_read_file"
        ? { kind: "text", content: "typed first" }
        : { kind: "ok" },
    );
    const { container } = renderComposer(undefined, { cwd: "/tmp/proj" });
    const composer = container.querySelector("[aria-label='pi composer']")!;
    await waitFor(() => {
      expect(composer.textContent).toContain("typed first");
    });
    usePiStore.setState({
      tabs: { 7: { rejectedDraft: draft } } as never,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(composer.textContent).not.toContain("second look");
    expect(usePiStore.getState().tabs[7]?.rejectedDraft?.text).toBe(
      "second look",
    );
  });
});

/// ---------------------------------------------------------------------------
/// Send to chat (K8): pi:insert-draft appends to the draft, saves at once
/// (never debounced, never sent), and records the source sidecar.
/// ---------------------------------------------------------------------------

const QUOTE = "```\nls -la\n\nfile1\nfile2\n```\nFrom terminal block 3";

function insertDraft(detail: Partial<InsertDraftDetail>): void {
  window.dispatchEvent(
    new CustomEvent<InsertDraftDetail>("pi:insert-draft", {
      detail: {
        text: QUOTE,
        tabId: 7,
        source: { blockId: 3, terminalId: 2, sha256: "deadbeef" },
        ...detail,
      },
    }),
  );
}

function writeCalls(): { path: string; content: string }[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "fs_write_file")
    .map(([, args]) => args as { path: string; content: string });
}

/** Backs the fs bridge with an in-memory map so load-then-save round trips
 *  (the sidecar read before each append) behave like the real bridge. */
function useMemoryFs(): Map<string, string> {
  const files = new Map<string, string>();
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const { path = "", content } = (args ?? {}) as {
      path?: string;
      content?: string;
    };
    if (cmd === "fs_create_dir") return undefined;
    if (cmd === "fs_write_file") {
      files.set(path, content ?? "");
      return undefined;
    }
    if (cmd === "fs_read_file") {
      return { kind: "text", content: files.get(path) ?? "" };
    }
    if (cmd === "fs_delete") {
      files.delete(path);
      return undefined;
    }
    return { kind: "ok" };
  });
  return files;
}

// ProseMirror scrolls the focused selection into view after the insert; the
// scroll-parent walk ends at window, which has no layout in jsdom. Zero rects
// keep that math finite. Installed for the whole file because the focus
// command defers to a requestAnimationFrame that can land after a test ends.
const zeroRect = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
} as DOMRect;
const rectsOf = () => [zeroRect] as unknown as DOMRectList;
const win = window as unknown as Record<string, unknown>;
Element.prototype.getClientRects = rectsOf;
win.getClientRects = rectsOf;
win.getBoundingClientRect = () => zeroRect;
// The coords walk also measures DOM Ranges, which jsdom leaves without rects.
const rangeProto = Object.getPrototypeOf(
  document.createRange(),
) as unknown as Record<string, unknown>;
rangeProto.getClientRects = rectsOf;
rangeProto.getBoundingClientRect = () => zeroRect;

describe("composer pi:insert-draft", () => {
  it("appends the quotation into an empty draft, focuses and saves at once", async () => {
    const { container } = renderComposer(vi.fn(), { cwd: "/tmp/proj" });
    const pm = container.querySelector("[aria-label='pi composer']")!;
    insertDraft({});
    await waitFor(() => {
      expect(pm.textContent).toContain("From terminal block 3");
    });
    // tiptap defers the DOM focus to a requestAnimationFrame.
    await waitFor(() => {
      expect(document.activeElement).toBe(pm);
    });

    const draft = writeCalls().find((w) => w.path === "/tmp/proj/.pi/drafts/7.md");
    expect(draft).toBeTruthy();
    expect(draft!.content).toContain("From terminal block 3");

    const sidecar = writeCalls().find(
      (w) => w.path === "/tmp/proj/.pi/drafts/7.json",
    );
    expect(sidecar).toBeTruthy();
    const meta = JSON.parse(sidecar!.content) as {
      v: number;
      sources: {
        blockId: number;
        terminalId: number;
        sha256: string;
        insertedAt: string;
      }[];
    };
    expect(meta.v).toBe(1);
    expect(meta.sources).toEqual([
      {
        blockId: 3,
        terminalId: 2,
        sha256: "deadbeef",
        insertedAt: expect.any(String),
      },
    ]);
  });

  it("keeps existing text and its trailing whitespace, one blank line between", async () => {
    const files = useMemoryFs();
    files.set("/tmp/proj/.pi/drafts/7.md", "hello  ");
    const { container } = renderComposer(vi.fn(), { cwd: "/tmp/proj" });
    const pm = container.querySelector("[aria-label='pi composer']")!;
    await waitFor(() => {
      expect(pm.textContent).toContain("hello");
    });
    insertDraft({});
    await waitFor(() => {
      expect(pm.textContent).toContain("From terminal block 3");
    });
    const drafts = writeCalls().filter(
      (w) => w.path === "/tmp/proj/.pi/drafts/7.md",
    );
    const draft = drafts[drafts.length - 1];
    expect(draft!.content).toMatch(/^hello  \n\n```/);
    expect(draft!.content).toContain("From terminal block 3");
  });

  it("appends a second quotation without dropping the first", async () => {
    useMemoryFs();
    renderComposer(vi.fn(), { cwd: "/tmp/proj" });
    insertDraft({});
    await waitFor(() => {
      expect(writeCalls().some((w) => w.path.endsWith("7.md"))).toBe(true);
    });
    insertDraft({
      text: "```\nsecond\n```\nFrom terminal block 4",
      source: { blockId: 4, terminalId: 2, sha256: "feedface" },
    });
    await waitFor(() => {
      expect(
        writeCalls().some((w) => w.content.includes("From terminal block 4")),
      ).toBe(true);
    });
    const drafts = writeCalls().filter((w) => w.path.endsWith("7.md"));
    const draft = drafts[drafts.length - 1];
    expect(draft.content).toContain("From terminal block 3");
    expect(draft.content).toContain("From terminal block 4");
    const sidecars = writeCalls().filter((w) => w.path.endsWith("7.json"));
    const sidecar = sidecars[sidecars.length - 1];
    const meta = JSON.parse(sidecar.content) as {
      sources: { blockId: number }[];
    };
    expect(meta.sources.map((s) => s.blockId)).toEqual([3, 4]);
  });

  it("ignores transfers addressed to another tab", () => {
    renderComposer(vi.fn(), { cwd: "/tmp/proj" });
    insertDraft({ tabId: 8 });
    expect(writeCalls()).toHaveLength(0);
  });
});

describe("composer Escape stop binding", () => {
  afterEach(() => {
    cleanup();
    usePiStore.setState({ tabs: {} });
  });

  it("Escape in the focused composer triggers the same stop action as the button", () => {
    const onStop = vi.fn();
    const { container } = renderComposer(vi.fn(), { onStop });
    const composer = container.querySelector("[aria-label='pi composer']")!;
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("Escape without a stop action falls through to the editor", () => {
    const onStop = vi.fn();
    const { container } = renderComposer(vi.fn(), {});
    const composer = container.querySelector("[aria-label='pi composer']")!;
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });
});
