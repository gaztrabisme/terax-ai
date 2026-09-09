// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { Editor } from "@tiptap/react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendPendingImage,
  autolinkable,
  base64Bytes,
  bytesToBlob,
  composerExtensions,
  imageEncoder,
  imagePathsOf,
  shortModelName,
  MAX_ATTACHMENTS,
  MAX_TOTAL_IMAGE_BYTES,
  type EncodedImage,
  type PendingImage,
} from "./Composer";

const { invokeMock, dialogOpenMock, windowFocusMock, dragDropHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dialogOpenMock: vi.fn(),
  windowFocusMock: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: windowFocusMock }),
}));

import { initialPiSessionState } from "@/modules/pi/lib/parse";
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
  windowFocusMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "fs_read_file") throw new Error("no such file");
    return { kind: "ok" };
  });
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
    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) =>
      cmd === "fs_read_file" && args?.path?.endsWith(".md")
        ? { kind: "text", content: "what is this" }
        : { kind: "text", content: JSON.stringify({ v: 1, attachments: [], sources: [] }) },
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
        attachmentId: expect.stringMatching(/^att-[a-f0-9-]+$/),
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
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[aria-label="pi composer"]')));
    expect(windowFocusMock).toHaveBeenCalledOnce();
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
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[aria-label="pi composer"]')));
    expect(windowFocusMock).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it.each([null, []])("restores focus and leaves no backdrop or busy attribute when the picker returns %j", async (selection) => {
    dialogOpenMock.mockResolvedValue(selection);
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
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[aria-label="pi composer"]')));
    expect(windowFocusMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-busy="true"], [data-slot="dialog-overlay"], [data-slot="sheet-overlay"], [data-uat="picker-backdrop"]')).toBeNull();
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
    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) =>
      cmd === "fs_read_file" && args?.path?.endsWith(".md")
        ? { kind: "text", content: "typed first" }
        : { kind: "text", content: JSON.stringify({ v: 1, attachments: [], sources: [] }) },
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

  // F3 (UAT k13-07, review UX-05): after a failed submission the composer
  // offers its chips again. Removing one deletes only the chip's own draft
  // file; the failed card's staged copy under .pi/attachments/ is never a
  // composer resource and must stay on disk for the retry.
  it("removing a restored failed chip deletes only its draft file, never the staged copy", async () => {
    const failedDraft = {
      text: "describe the attached image in five words",
      images: [{ mediaType: "image/jpeg", data: btoa("chip") }],
      error: "attachment copy failed: .pi/drafts/2p5ta54a14-att-1.jpg",
      records: [
        {
          attachmentId: "att-1",
          draftPath: ".pi/drafts/2p5ta54a14-att-1.jpg",
          stagedPath: ".pi/attachments/sub-1-att-1.jpg",
          sha256: "cafe",
        },
      ],
    };
    const { container } = renderComposer(undefined, { cwd: "/tmp/proj" });
    usePiStore.setState({
      tabs: { 7: { rejectedDraft: failedDraft } } as never,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("img")).toHaveLength(1);
    });
    fireEvent.click(
      container.querySelector(
        "button[aria-label='Remove 2p5ta54a14-att-1.jpg']",
      )!,
    );
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "fs_delete"),
      ).toBe(true);
    });
    const deletes = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "fs_delete")
      .map(([, args]) => (args as { path: string }).path);
    expect(deletes).toEqual(["/tmp/proj/.pi/drafts/2p5ta54a14-att-1.jpg"]);
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
    const { path = "", content, tabId, attachmentId, mediaType, data, original } = (args ?? {}) as {
      path?: string;
      content?: string;
      tabId?: string;
      attachmentId?: string;
      mediaType?: string;
      data?: string;
      original?: { mediaType: string; data: string };
    };
    if (cmd === "pi_save_draft_attachment") {
      const extension = (mime: string) => mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
      const savedPath = `.pi/drafts/${tabId}-${attachmentId}.${extension(mediaType!)}`;
      files.set(`/tmp/proj/${savedPath}`, data!);
      const savedOriginal = original ? {
        path: `.pi/drafts/${tabId}-${attachmentId}.orig.${extension(original.mediaType)}`,
        mime: original.mediaType,
        bytes: base64Bytes(original.data),
        sha256: createHash("sha256").update(Buffer.from(original.data, "base64")).digest("hex"),
      } : undefined;
      if (savedOriginal) files.set(`/tmp/proj/${savedOriginal.path}`, original!.data);
      return { path: savedPath, sha256: createHash("sha256").update(Buffer.from(data!, "base64")).digest("hex"), original: savedOriginal };
    }
    if (cmd === "fs_read_file_bytes") {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return { base64: files.get(path), mimeType: path.endsWith(".jpg") ? "image/jpeg" : `image/${path.split(".").pop()}`, size: base64Bytes(files.get(path)!) };
    }
    if (cmd === "fs_create_dir") return undefined;
    if (cmd === "fs_write_file") {
      files.set(path, content ?? "");
      return undefined;
    }
    if (cmd === "fs_read_file") {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return { kind: "text", content: files.get(path) };
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

describe("trusted draft attachments (G3)", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAOElEQVR4nO3PsQkAAAzDsPz/dHpFliLwbFCaTBvvu94DAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAQcOkv4asq/aw0AAAAASUVORK5CYII=";
  const pngHash = "fc75966897d50143d883d0f9cc09b6b508989a4a6dcb03650983dba508377741";
  const metaPath = "/tmp/proj/.pi/drafts/7.json";
  const imagePath = ".pi/drafts/7-att-saved.png";
  const saved = { id: "att-saved", name: "sample-a.png", path: imagePath, mime: "image/png", sha256: pngHash, state: "draft" };

  beforeEach(() => {
    imageEncoder.encode = realEncode;
    vi.stubGlobal("crypto", webcrypto);
    usePiStore.setState({ tabs: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function recovered() {
    const view = renderComposer(vi.fn(), { cwd: "/tmp/proj" });
    await waitFor(() => expect((view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    return view;
  }

  function seedMissing(files: Map<string, string>) {
    files.set("/tmp/proj/.pi/drafts/7.md", "Send this text");
    files.set(metaPath, JSON.stringify({ v: 1, submissionId: null, attachments: [saved], sources: [] }));
  }

  it("keeps the exact reviewed PNG bytes, media type and hash through paste, recovery and send", async () => {
    const files = useMemoryFs();
    const view = await recovered();
    pasteFiles(view.pm, [new File([bytesToBlob(png, "image/png")], "sample-a.png", { type: "image/png" })]);
    await waitFor(() => expect(JSON.parse(files.get(metaPath) ?? "{}").attachments).toHaveLength(1));
    const entry = JSON.parse(files.get(metaPath)!).attachments[0];
    expect(entry).toMatchObject({ mime: "image/png", sha256: pngHash, name: "sample-a.png" });
    expect(entry.path).toMatch(/\.png$/);
    expect(files.get(`/tmp/proj/${entry.path}`)).toBe(png);
    expect(base64Bytes(png)).toBe(113);
    expect(entry.original).toBeUndefined();
    view.unmount();
    const restored = await recovered();
    expect(restored.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${png}`);
    fireEvent.click(restored.getByRole("button", { name: "Send" }));
    expect(restored.onSubmit).toHaveBeenCalledWith("", [expect.objectContaining({ mediaType: "image/png", data: png, sha256: pngHash, draftPath: entry.path })]);
  });

  it.each(["png", "jpg", "gif", "webp"])("preserves picked %s file bytes without decoding or conversion", async (ext) => {
    const files = useMemoryFs();
    const data = ext === "png" ? png : btoa(`original ${ext} bytes with metadata`);
    files.set(`/tmp/source.${ext}`, data);
    dialogOpenMock.mockResolvedValue(`/tmp/source.${ext}`);
    const view = await recovered();
    fireEvent.click(view.getByRole("button", { name: "Attach images" }));
    await waitFor(() => expect(JSON.parse(files.get(metaPath) ?? "{}").attachments).toHaveLength(1));
    const entry = JSON.parse(files.get(metaPath)!).attachments[0];
    expect(entry.path).toMatch(new RegExp(`\\.${ext}$`));
    expect(entry.mime).toBe(ext === "jpg" ? "image/jpeg" : `image/${ext}`);
    expect(entry.sha256).toBe(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
    expect(files.get(`/tmp/proj/${entry.path}`)).toBe(data);
    expect(entry.original).toBeUndefined();
  });

  it("finishes an in-flight image write before removing its file and record entry durably", async () => {
    const files = useMemoryFs();
    const fsInvoke = invokeMock.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "pi_save_draft_attachment") await held;
      return fsInvoke(cmd, args);
    });
    const view = await recovered();
    pasteFiles(view.pm, [new File([bytesToBlob(png, "image/png")], "sample-a.png", { type: "image/png" })]);
    await view.findByRole("img");
    fireEvent.click(view.getByRole("button", { name: "Remove sample-a.png" }));
    expect(view.getByRole("img")).toBeTruthy();
    release();
    await waitFor(() => expect(view.queryByRole("img")).toBeNull());
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([]);
    expect([...files.keys()].filter((path) => path.endsWith(".png"))).toEqual([]);
    const calls = invokeMock.mock.calls;
    const deletion = calls.findIndex(([cmd, args]) => cmd === "fs_delete" && args.path.endsWith(".png"));
    const emptyRecord = calls.findIndex(([cmd, args]) => cmd === "fs_write_file" && args.path === metaPath && JSON.parse(args.content).attachments.length === 0);
    expect(emptyRecord).toBeGreaterThan(deletion);
    view.unmount();
    const restored = await recovered();
    expect(restored.container.querySelector('[data-uat="attachment-chip"]')).toBeNull();
    expect(restored.queryByRole("alert")).toBeNull();
  });

  it("keeps a failed removal visible and retries without losing the record", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    files.set(`/tmp/proj/${imagePath}`, png);
    const fsInvoke = invokeMock.getMockImplementation()!;
    let denied = true;
    invokeMock.mockImplementation(async (cmd: string, args: { path?: string }) => {
      if (denied && cmd === "fs_delete" && args.path?.endsWith(".png")) throw new Error("permission denied");
      return fsInvoke(cmd, args);
    });
    const view = await recovered();
    fireEvent.click(view.getByRole("button", { name: "Remove sample-a.png" }));
    await view.findByText(/Could not remove sample-a.png/);
    expect(files.has(`/tmp/proj/${imagePath}`)).toBe(true);
    expect(JSON.parse(files.get(metaPath)!).attachments).toHaveLength(1);
    denied = false;
    fireEvent.click(view.getByRole("button", { name: "Remove sample-a.png" }));
    await waitFor(() => expect(view.queryByRole("img")).toBeNull());
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([]);
  });

  it("offers Remove and Relink for every missing image and clears the recovery error when resolved", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    const second = { ...saved, id: "att-second", name: "second.png", path: ".pi/drafts/7-att-second.png" };
    files.set(metaPath, JSON.stringify({ v: 1, attachments: [saved, second], sources: [] }));
    const view = await recovered();
    expect(view.container.querySelectorAll('[data-state="missing"]')).toHaveLength(2);
    expect(view.getByRole("button", { name: "Relink sample-a.png" })).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain(imagePath);
    fireEvent.click(view.getByRole("button", { name: "Remove sample-a.png" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Remove sample-a.png" })).toBeNull());
    expect(view.getByRole("alert").textContent).toContain(second.path);
    fireEvent.click(view.getByRole("button", { name: "Remove second.png" }));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([]);
  });

  it("sends text without a missing image, shows the omission and clears stale recovery state", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    const view = await recovered();
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(view.onSubmit).toHaveBeenCalledWith("Send this text", []);
    expect(view.getByRole("status").textContent).toContain("Missing attachment omitted from submission: sample-a.png");
    expect(view.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(files.has(metaPath)).toBe(false));
    view.unmount();
    expect((await recovered()).container.querySelector('[data-uat="attachment-chip"]')).toBeNull();
  });

  it("relinks a missing image through the file picker with the same attachment identity", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    files.set("/tmp/replacement.png", png);
    dialogOpenMock.mockResolvedValue("/tmp/replacement.png");
    const view = await recovered();
    fireEvent.click(view.getByRole("button", { name: "Relink sample-a.png" }));
    await waitFor(() => expect(JSON.parse(files.get(metaPath)!).attachments[0].name).toBe("replacement.png"));
    expect(dialogOpenMock).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }));
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([expect.objectContaining({ id: saved.id, sha256: pngHash, path: imagePath, mime: "image/png" })]);
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(files.get(`/tmp/proj/${imagePath}`)).toBe(png);
    expect(view.pm.textContent).toBe("Send this text");
    view.unmount();
    expect((await recovered()).getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${png}`);
  });

  it("preserves the missing chip when Relink is cancelled", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    dialogOpenMock.mockResolvedValue(null);
    const view = await recovered();
    fireEvent.click(view.getByRole("button", { name: "Relink sample-a.png" }));
    await waitFor(() => expect(dialogOpenMock).toHaveBeenCalled());
    expect(view.container.querySelector('[data-state="missing"]')).toBeTruthy();
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([saved]);
    await waitFor(() => expect(windowFocusMock).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(view.pm);
  });

  it("keeps Remove, Relink and text sending available when the relink write fails", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    files.set("/tmp/replacement.png", png);
    dialogOpenMock.mockResolvedValue("/tmp/replacement.png");
    const fsInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "pi_save_draft_attachment") throw new Error("disk full");
      return fsInvoke(cmd, args);
    });
    const view = await recovered();
    fireEvent.click(view.getByRole("button", { name: "Relink sample-a.png" }));
    await view.findByText(/Could not relink sample-a.png: disk full/);
    expect(view.getByRole("button", { name: "Remove sample-a.png" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Relink sample-a.png" })).toBeTruthy();
    expect(view.getByRole("alert")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(view.onSubmit).toHaveBeenCalledWith("Send this text", []);
    await waitFor(() => expect(files.has(metaPath)).toBe(false));
  });

  it("rejects an attachment total over the cap before writing any extra file", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    files.set(`/tmp/proj/${imagePath}`, png);
    const view = await recovered();
    pasteFiles(view.pm, [new File([new Uint8Array(MAX_TOTAL_IMAGE_BYTES)], "at-cap.png", { type: "image/png" })]);
    await view.findByText("Attachments would exceed the 4194304-byte (4 MiB) image budget");
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([saved]);
    expect(view.getAllByRole("img")).toHaveLength(1);
    expect(files.get(`/tmp/proj/${imagePath}`)).toBe(png);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pi_save_draft_attachment")).toBe(false);
  });

  it("treats changed file bytes as unavailable until removed or relinked", async () => {
    const files = useMemoryFs();
    seedMissing(files);
    files.set(`/tmp/proj/${imagePath}`, btoa("different bytes"));
    const view = await recovered();
    expect(view.getByRole("alert").textContent).toContain("no longer matches its saved SHA-256");
    expect(view.container.querySelector('[data-state="missing"]')).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(view.onSubmit).toHaveBeenCalledWith("Send this text", []);
    await waitFor(() => expect(files.has(metaPath)).toBe(false));
  });

  it("keeps a file at the exact 4194304-byte cap unchanged", async () => {
    const encoded = await realEncode(new Blob([new Uint8Array(MAX_TOTAL_IMAGE_BYTES)], { type: "image/gif" }));
    expect(encoded.mediaType).toBe("image/gif");
    expect(base64Bytes(encoded.data)).toBe(MAX_TOTAL_IMAGE_BYTES);
    expect(encoded.original).toBeUndefined();
  });

  it("shows the conversion note and preserves the oversized original across recovery", async () => {
    const files = useMemoryFs();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:test"; }
      static revokeObjectURL() {}
    });
    vi.stubGlobal("Image", class {
      naturalWidth = 3000;
      naturalHeight = 2000;
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(`data:image/jpeg;base64,${btoa("converted jpeg")}`);
    const view = await recovered();
    pasteFiles(view.pm, [new File([new Uint8Array(6_200_000)], "large.png", { type: "image/png" })]);
    await waitFor(() => expect(JSON.parse(files.get(metaPath) ?? "{}").attachments?.[0].original?.bytes).toBe(6_200_000));
    const entry = JSON.parse(files.get(metaPath)!).attachments[0];
    expect(canvas).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(entry.path).toMatch(/\.jpg$/);
    expect(entry.mime).toBe("image/jpeg");
    expect(entry.original.path).toMatch(/\.orig\.png$/);
    expect(entry.original.mime).toBe("image/png");
    expect(entry.original.sha256).toBe(createHash("sha256").update(new Uint8Array(6_200_000)).digest("hex"));
    expect(base64Bytes(files.get(`/tmp/proj/${entry.original.path}`)!)).toBe(6_200_000);
    expect(view.getByText("converted to JPEG, original 6.2 MB")).toBeTruthy();
    view.unmount();
    const restored = await recovered();
    expect(restored.getByText("converted to JPEG, original 6.2 MB")).toBeTruthy();
    fireEvent.click(restored.getByRole("button", { name: "Remove large.png" }));
    await waitFor(() => expect(restored.queryByRole("img")).toBeNull());
    expect(files.has(`/tmp/proj/${entry.path}`)).toBe(false);
    expect(files.has(`/tmp/proj/${entry.original.path}`)).toBe(false);
    expect(JSON.parse(files.get(metaPath)!).attachments).toEqual([]);
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


describe("G1 composer queue handoff", () => {
  afterEach(() => usePiStore.setState({ tabs: {} }));

  function seedBusy() {
    usePiStore.setState({ tabs: { 7: {
      gen: 1, cwd: "/tmp/proj", state: { ...initialPiSessionState(), status: "thinking" },
      session: { id: 1, send: vi.fn(), kill: vi.fn() }, exited: false, exitCode: null, error: null,
      roles: { provider: "local", model: "test", smol: "test" }, queued: [],
    } } });
  }

  it("keeps visible text until the real queue write completes, then clears only the composer", async () => {
    const files = useMemoryFs();
    files.set("/tmp/proj/.pi/drafts/7.md", "second prompt");
    seedBusy();
    let release!: () => void;
    let writing = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fs = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_write_file" && args?.path?.endsWith("7.json")) { writing = true; await held; }
      return fs(cmd, args);
    });
    const view = renderComposer(vi.fn((text, images) => usePiStore.getState().sendPrompt(7, text, images)), { cwd: "/tmp/proj" });
    await waitFor(() => expect(view.pm.textContent).toBe("second prompt"));
    fireEvent.click(view.getByText("Send"));
    await waitFor(() => expect(writing).toBe(true));
    expect(view.pm.textContent).toBe("second prompt");
    expect(files.get("/tmp/proj/.pi/drafts/7.md")).toBe("second prompt");
    release();
    await waitFor(() => expect(view.pm.textContent).toBe(""));
    const record = JSON.parse(files.get("/tmp/proj/.pi/drafts/7.json")!);
    expect(record.queue[0].text).toBe("second prompt");
    expect(usePiStore.getState().tabs[7].queued).toHaveLength(1);
  });

  it("preserves text and chips when the queue record cannot be written", async () => {
    const files = useMemoryFs();
    files.set("/tmp/proj/.pi/drafts/7.md", "with image");
    files.set("/tmp/proj/.pi/drafts/7.json", JSON.stringify({ v: 1, submissionId: null, sources: [], attachments: [
      { id: "att-99", path: ".pi/drafts/7-att-99.png", sha256: createHash("sha256").update("image").digest("hex"), mime: "image/png", state: "draft" },
    ] }));
    const fs = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_read_file_bytes") return { base64: btoa("image") };
      if (cmd === "fs_write_file" && args?.path?.endsWith("7.json")) throw new Error("disk full");
      return fs(cmd, args);
    });
    seedBusy();
    const view = renderComposer(vi.fn((text, images) => usePiStore.getState().sendPrompt(7, text, images)), { cwd: "/tmp/proj" });
    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(1));
    fireEvent.click(view.getByText("Send"));
    await waitFor(() => expect(view.getByText(/disk full/)).toBeTruthy());
    expect(view.pm.textContent).toBe("with image");
    expect(view.container.querySelectorAll("img")).toHaveLength(1);
    expect(usePiStore.getState().tabs[7].queued).toEqual([]);
  });

  it("returns queued text and chips alongside an existing composer draft", async () => {
    const files = useMemoryFs();
    files.set("/tmp/proj/.pi/drafts/7.md", "already typed");
    const view = renderComposer(undefined, { cwd: "/tmp/proj" });
    await waitFor(() => expect(view.pm.textContent).toBe("already typed"));
    usePiStore.setState({ tabs: { 7: { rejectedDraft: {
      text: "queued text", images: [{ mediaType: "image/png", data: btoa("queue") }], error: null, queueReturn: true,
      records: [{ attachmentId: "att-77", draftPath: ".pi/drafts/7-att-77.png", stagedPath: null, sha256: "abc" }],
    } } } as never });
    await waitFor(() => expect(view.pm.textContent).toContain("queued text"));
    expect(view.pm.textContent).toContain("already typed");
    expect(view.container.querySelectorAll("img")).toHaveLength(1);
    await waitFor(() => expect(files.get("/tmp/proj/.pi/drafts/7.md")).toBe("already typed\n\nqueued text"));
    expect(usePiStore.getState().tabs[7].rejectedDraft).toBeNull();
  });

  it("keeps recovered queue images out of the composer and reserves their attachment ids", async () => {
    const files = useMemoryFs();
    files.set("/tmp/proj/.pi/drafts/7.md", "independent draft");
    files.set("/tmp/proj/.pi/drafts/7.json", JSON.stringify({ v: 1, submissionId: null, sources: [], attachments: [
      { id: "att-9999", path: ".pi/drafts/7-att-9999.png", sha256: "abc", mime: "image/png", state: "queued" },
    ], queue: [{ id: "queued-recovered", text: "queued text", attachmentIds: ["att-9999"], submittedAt: "2026-09-09T00:00:00Z" }] }));
    const view = renderComposer(undefined, { cwd: "/tmp/proj" });
    await waitFor(() => expect(view.pm.textContent).toBe("independent draft"));
    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    pasteFiles(view.pm, [imageFile("new.png")]);
    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(1));
    const write = invokeMock.mock.calls.find(([cmd]) => cmd === "pi_save_draft_attachment");
    expect(write?.[1].attachmentId).not.toBe("att-9999");
  });
});
