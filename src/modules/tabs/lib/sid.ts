/**
 * Unit K11c: stable opaque tab ids. Every tab the store creates carries a
 * short random string beside its numeric id (docs/design.md section 3.4:
 * "IDs in filenames are stable opaque strings, never list positions"). The
 * numeric id is a render-time handle; the stable id names the tab across
 * restarts in ui-state.json and names draft files under .pi/drafts/.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SID_LENGTH = 10;

/** Mint one short opaque id (lowercase base36, crypto-random when available). */
export function mintSid(): string {
  const bytes = new Uint8Array(SID_LENGTH);
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < SID_LENGTH; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
  } catch {
    for (let i = 0; i < SID_LENGTH; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < SID_LENGTH; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Numeric id -> stable id for the running session. The tab store fills it at
 * every creation; consumers that only receive the numeric id (the composer,
 * reached through props that predate the stable ids) read it back here. The
 * map only grows: numeric ids are never reused within a session.
 */
const stableIds = new Map<number, string>();

export function registerStableId(numericId: number, sid: string): void {
  stableIds.set(numericId, sid);
}

export function stableIdOf(numericId: number): string | null {
  return stableIds.get(numericId) ?? null;
}

/** Test seam: drop every registration. */
export function resetStableIdsForTests(): void {
  stableIds.clear();
}
