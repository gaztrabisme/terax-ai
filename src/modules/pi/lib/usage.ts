import { asUsage, messageSourceKey, type PiFeedItem, type PiUsage } from "./parse";
import { SESSION_LOG, type LedgerSnapshot } from "@/modules/pi/lib/ledgerStore";

/**
 * K10: the provider-neutral qualifier sentence every usage footer carries
 * verbatim (title and aria-label of the cache-qualifier element). It needs
 * no provider cache-block metadata, and a low reported share alone does not
 * establish a prefix change.
 */
export const CACHE_QUALIFIER_TEXT =
  "Cache reporting varies by provider and prompt size; a low reported share alone does not establish a prefix change.";

/**
 * The unstable cache segment: the cached share over input plus cacheRead as
 * "89% cached", or "cache unknown" when the prompt size is 0. Rendered as
 * data-uat="cache-share" with data-uat-unstable="1"; UAT never asserts it.
 */
export function cacheShareLabel(usage: PiUsage): string {
  const prompt = usage.input + usage.cacheRead;
  if (prompt <= 0) return "cache unknown";
  return `${Math.round((usage.cacheRead / prompt) * 100)}% cached`;
}

export function addUsage(a: PiUsage, b: PiUsage): PiUsage {
  return Object.fromEntries(Object.keys(a).map((key) => [
    key, a[key as keyof PiUsage] + b[key as keyof PiUsage],
  ])) as PiUsage;
}

/** "$0.0031" for the small per-turn sums, "$0.92" once a run adds up. Lives
 *  here so the session strip and the turn footer share one format. */
export function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/**
 * S2 session strip values, truthful in both directions (UX-14): before any
 * turn has reported usage the fields say so explicitly instead of being
 * omitted; after turns the sums render, and a session the provider never
 * priced shows "cost unknown", never a blank or a fake $0. Zero here means
 * "not reported" because parse.ts flattens a missing cost to 0 (design.md
 * section 3.5: null means unknown, not 0).
 */
export function stripTurnTokensLabel(
  turnTokens: number,
  hasTurnUsage: boolean,
): string {
  return hasTurnUsage ? `${turnTokens.toLocaleString()} tok` : "no turns yet";
}

export function stripSessionCostLabel(
  sessionCost: number,
  hasTurnUsage: boolean,
): string {
  if (!hasTurnUsage) return "no turns yet";
  return sessionCost > 0 ? formatCost(sessionCost) : "cost unknown";
}

export function turnUsageIssues(blocks: PiFeedItem[], ledger: LedgerSnapshot): Map<number, string> {
  const sources = new Map<string, PiUsage | null>();
  for (const source of Object.values(ledger.sources)) {
    if (source.type !== "turn_end") continue;
    const message = source.event.message as { usage?: unknown } | null;
    sources.set(messageSourceKey(message), asUsage(message?.usage));
  }
  const groups = new Map<number, { displayed: PiUsage | null; source: PiUsage | null; missing: boolean; known: boolean }>();
  let turn = -1;
  for (const block of blocks) {
    if (block.kind === "message" && block.role === "user") { turn += 1; continue; }
    if (block.kind !== "message" || block.role !== "assistant" || block.streaming) continue;
    const index = Math.max(0, turn);
    const group = groups.get(index) ?? { displayed: null, source: null, missing: false, known: true };
    if (block.usage) group.displayed = group.displayed ? addUsage(group.displayed, block.usage) : block.usage;
    const committed = block.sourceKey && sources.has(block.sourceKey);
    const source = committed ? sources.get(block.sourceKey!) : block.eventUsage;
    if (source) group.source = group.source ? addUsage(group.source, source) : source;
    if (source === undefined) group.known = false;
    if (source === null) group.missing = true;
    groups.set(index, group);
  }
  const issues = new Map<number, string>();
  for (const [turn, group] of groups) {
    if (!group.known) continue;
    const equal = group.displayed && group.source && !group.missing &&
      Object.keys(group.displayed).every((key) =>
        Math.abs(group.displayed![key as keyof PiUsage] - group.source![key as keyof PiUsage]) < 1e-9,
      );
    if (!equal) issues.set(turn, `usage-discrepancy: displayed=${JSON.stringify(group.displayed)}; source=${group.missing ? "missing usage " : ""}${JSON.stringify(group.source)} (${SESSION_LOG})`);
  }
  return issues;
}
