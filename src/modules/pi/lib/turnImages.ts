import type { PiFeedItem, PiImageAttachment } from "./parse";

/**
 * Binds queued image sets (pendingImages, FIFO) to user message blocks.
 * Walks blocks in order; every user message block whose id is not yet in
 * `bound` is added to `bound`, even when nothing is queued, so a later
 * send cannot bind to an older imageless block, and the first pending
 * set is shifted, recording it under that block's id when it is
 * non-empty. Returns the additions to merge into turnImages, or null
 * when no image was assigned.
 */
export function bindPendingImages(
  blocks: PiFeedItem[],
  bound: Set<string>,
  pending: PiImageAttachment[][],
): Record<string, PiImageAttachment[]> | null {
  const additions: Record<string, PiImageAttachment[]> = {};
  let assigned = false;
  for (const block of blocks) {
    if (block.kind !== "message" || block.role !== "user") continue;
    if (bound.has(block.id)) continue;
    bound.add(block.id);
    const images = pending.shift();
    if (images && images.length > 0) {
      additions[block.id] = images;
      assigned = true;
    }
  }
  return assigned ? additions : null;
}
