import type { PiTab, Tab } from "@/modules/tabs";

/**
 * Unit K8: the window CustomEvents bridging a terminal block's "Send to chat"
 * button to a pi composer. BlockChrome dispatches `pi:send-to-chat`; App picks
 * the target chat tab and forwards `pi:insert-draft` with the tab id added.
 * Nothing in this chain ever sends: the quotation only lands in the draft.
 */

export const SEND_TO_CHAT_EVENT = "pi:send-to-chat";
export const INSERT_DRAFT_EVENT = "pi:insert-draft";

export type SendToChatSource = {
  blockId: number;
  terminalId: number;
  sha256: string;
};

export type SendToChatDetail = {
  text: string;
  source: SendToChatSource;
};

export type InsertDraftDetail = SendToChatDetail & { tabId: number };

/**
 * Picks the chat tab a block transfer goes to: the active tab if it is a pi
 * tab, else the most recently active pi tab whose cwd matches the terminal's,
 * else the first pi tab, else null (App then opens a new pi session on the
 * terminal's cwd and retries). The tab store keeps creation order and
 * expresses activation recency through activeId alone, so array order stands
 * in for recency among the same-cwd tabs.
 */
export function chooseChatTab(
  tabs: readonly Tab[],
  activeId: number,
  cwd: string | null | undefined,
): number | null {
  const active = tabs.find((t) => t.id === activeId);
  if (active?.kind === "pi") return active.id;
  const piTabs = tabs.filter((t): t is PiTab => t.kind === "pi");
  const sameCwd = cwd ? piTabs.find((t) => t.cwd === cwd) : undefined;
  return sameCwd?.id ?? piTabs[0]?.id ?? null;
}
