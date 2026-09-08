// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  UAT_IDS_K4,
  UAT_IDS_K4_ABSENT,
  UAT_IDS_K4_STATEFUL,
} from "./lib/uatIds";

// Entries are repo-root-relative; this test lives in src/.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceOf(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

/** True when the source carries the id in any data-uat attribute form:
 *  a JSX literal, a ternary value, or an imperative setAttribute. */
function carriesUatId(source: string, id: string): boolean {
  return (
    source.includes(`data-uat="${id}"`) ||
    source.includes(`"data-uat", "${id}"`) ||
    (source.includes("data-uat") && source.includes(`"${id}"`))
  );
}

describe("UAT_IDS_K4", () => {
  it("assigns every in-scope id a unique kebab-case name", () => {
    const ids = UAT_IDS_K4.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("marks every id on its owning component's source", () => {
    for (const entry of UAT_IDS_K4) {
      expect(
        carriesUatId(sourceOf(entry.file), entry.id),
        `data-uat="${entry.id}" missing from ${entry.file}`,
      ).toBe(true);
    }
  });
});

describe("UAT_IDS_K4_STATEFUL", () => {
  it("marks every stateful id on its owning component's source", () => {
    for (const entry of UAT_IDS_K4_STATEFUL) {
      expect(
        carriesUatId(sourceOf(entry.file), entry.id),
        `data-uat="${entry.id}" missing from ${entry.file}`,
      ).toBe(true);
      expect(entry.state.length).toBeGreaterThan(0);
    }
  });

  it("records a state for each and never overlaps the reachable list", () => {
    const reachable = new Set(UAT_IDS_K4.map((entry) => entry.id));
    for (const entry of UAT_IDS_K4_STATEFUL) {
      expect(reachable.has(entry.id)).toBe(false);
    }
  });
});

describe("UAT_IDS_K4_ABSENT", () => {
  it("documents K4 rows whose control does not exist in this tree", () => {
    const known = new Set([
      ...UAT_IDS_K4.map((entry) => entry.id),
      ...UAT_IDS_K4_STATEFUL.map((entry) => entry.id),
    ]);
    for (const entry of UAT_IDS_K4_ABSENT) {
      expect(known.has(entry.id)).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
