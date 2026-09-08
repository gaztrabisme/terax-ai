// @vitest-environment jsdom
import type { IMarker } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { BlockStore } from "../lib/blocks";
import {
  buildQuotation,
  makeSendToChatButton,
  SEND_TO_CHAT_MAX_LINES,
  sha256Hex,
} from "./BlockChrome";
import { SEND_TO_CHAT_EVENT, type SendToChatDetail } from "@/modules/pi/lib/sendToChat";

afterEach(cleanup);

let markerSeq = 0;

function fakeMarker(line = 4): IMarker {
  const marker = {
    id: markerSeq++,
    line,
    isDisposed: false,
    dispose: () => {
      marker.isDisposed = true;
      marker.line = -1;
    },
  };
  return marker as unknown as IMarker;
}

function completedBlock(command: string | null) {
  let now = 1000;
  const store = new BlockStore({ now: () => now, createMarker: fakeMarker });
  now += 5;
  store.onCommandStart(command);
  now += 15;
  store.onCommandDone(0);
  return { store, block: store.getBlocks()[0] };
}

describe("buildQuotation", () => {
  it("fences the command line, a blank line and the output, then names the block", () => {
    expect(buildQuotation("ls -la", "file1\nfile2", 12)).toBe(
      "```\nls -la\n\nfile1\nfile2\n```\nFrom terminal block 12",
    );
  });

  it("keeps an empty command line when the block has no command text", () => {
    expect(buildQuotation(null, "done", 7)).toBe(
      "```\n\n\ndone\n```\nFrom terminal block 7",
    );
  });

  it("leaves output up to the cap untruncated", () => {
    const output = Array.from(
      { length: SEND_TO_CHAT_MAX_LINES },
      (_, i) => `line ${i}`,
    ).join("\n");
    const text = buildQuotation("seq", output, 1);
    expect(text).not.toContain("output truncated");
    expect(text).toContain(`line ${SEND_TO_CHAT_MAX_LINES - 1}`);
  });

  it("caps longer output with a trailing line count", () => {
    const total = SEND_TO_CHAT_MAX_LINES + 5;
    const output = Array.from({ length: total }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const text = buildQuotation("seq", output, 2);
    expect(text).toContain("line 0\n");
    expect(text).toContain(`(output truncated, ${total} lines)`);
    expect(text).not.toContain(`line ${SEND_TO_CHAT_MAX_LINES}\n`);
    expect(text).not.toContain(`line ${total - 1}`);
  });
});

describe("sha256Hex", () => {
  it("matches the SHA-256 test vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("makeSendToChatButton", () => {
  it("labels itself for pointer and assistive tech and scopes the uat key", () => {
    const { block } = completedBlock("ls");
    const btn = makeSendToChatButton(3, block, () => "out");
    expect(btn.textContent).toBe("Send to chat");
    expect(btn.getAttribute("aria-label")).toBe("Send to chat");
    expect(btn.getAttribute("data-uat")).toBe("block-send-to-chat");
    expect(btn.getAttribute("data-uat-key")).toBe(String(block.id));
  });

  it("dispatches the quotation and source hash for the block", async () => {
    const { block } = completedBlock("ls -la");
    const raw = "file1\nfile2";
    const btn = makeSendToChatButton(3, block, () => raw);
    const seen = new Promise<SendToChatDetail>((resolve) => {
      const listener = (e: Event) =>
        resolve((e as CustomEvent<SendToChatDetail>).detail);
      window.addEventListener(SEND_TO_CHAT_EVENT, listener);
    });
    btn.click();
    const detail = await seen;
    expect(detail.text).toBe(buildQuotation("ls -la", raw, block.id));
    expect(detail.source).toEqual({
      blockId: block.id,
      terminalId: 3,
      sha256: await sha256Hex(raw),
    });
  });

  it("does nothing when the block's marker is gone", async () => {
    const { block } = completedBlock("ls");
    const marker = block.marker as IMarker;
    marker.dispose();
    const btn = makeSendToChatButton(3, block, () => "out");
    const listener = vi.fn();
    window.addEventListener(SEND_TO_CHAT_EVENT, listener);
    btn.click();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SEND_TO_CHAT_EVENT, listener);
  });
});
