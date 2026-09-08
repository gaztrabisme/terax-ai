import { describe, expect, it } from "vitest";
import type { PiFeedItem, PiImageAttachment } from "./parse";
import { bindPendingImages } from "./turnImages";

const img = (data: string): PiImageAttachment => ({
  mediaType: "image/png",
  data,
});

function userBlock(id: string): PiFeedItem {
  return {
    kind: "message",
    id,
    role: "user",
    parts: [],
    model: null,
    usage: null,
    streaming: false,
    at: 0,
  };
}

describe("bindPendingImages", () => {
  it("binds a later send's images to its own block, not older imageless ones", () => {
    const bound = new Set<string>();
    const pending: PiImageAttachment[][] = [];

    // First pass: two user blocks arrive with nothing queued.
    expect(
      bindPendingImages([userBlock("msg-1"), userBlock("msg-2")], bound, pending),
    ).toBeNull();
    expect(bound.has("msg-1")).toBe(true);
    expect(bound.has("msg-2")).toBe(true);

    // Second pass: one set is queued; a third user block arrives.
    const image = [img("aaa")];
    const additions = bindPendingImages(
      [userBlock("msg-1"), userBlock("msg-2"), userBlock("msg-3")],
      bound,
      [image],
    );
    expect(additions).toEqual({ "msg-3": image });
  });

  it("binds two queued sets FIFO across two new user blocks in one pass", () => {
    const bound = new Set<string>();
    const first = [img("aaa")];
    const second = [img("bbb")];
    const additions = bindPendingImages(
      [userBlock("msg-1"), userBlock("msg-2")],
      bound,
      [first, second],
    );
    expect(additions).toEqual({ "msg-1": first, "msg-2": second });
    expect(bound.has("msg-1")).toBe(true);
    expect(bound.has("msg-2")).toBe(true);
  });

  it("returns null when nothing is pending and no user block is unbound", () => {
    const bound = new Set(["msg-1"]);
    expect(bindPendingImages([userBlock("msg-1")], bound, [])).toBeNull();
    expect(bound.has("msg-1")).toBe(true);
  });

  it("consumes an empty queued set without assigning anything", () => {
    const bound = new Set<string>();
    expect(bindPendingImages([userBlock("msg-1")], bound, [[]])).toBeNull();
    expect(bound.has("msg-1")).toBe(true);
  });
});
