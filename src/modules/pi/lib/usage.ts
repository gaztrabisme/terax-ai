import type { PiUsage } from "./parse";

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
