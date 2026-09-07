import { describe, expect, it } from "vitest";
import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import {
  DEFAULT_AGENT_BIN,
  RAIL_STATES,
  stateLabel,
} from "../lib/board";
import { POLL_MS } from "./BoardPane";

// Pane-level expectations: the compact rail lists the four active states, and
// the binary defaults stay empty so the resolver decides per machine.
describe("BoardView rail configuration", () => {
  it("lists exactly the four active states on the rail", () => {
    expect(RAIL_STATES).toEqual(["align", "in_progress", "verify", "review"]);
  });

  it("labels every rail state without underscores", () => {
    for (const state of RAIL_STATES) {
      expect(stateLabel(state)).not.toContain("_");
      expect(stateLabel(state).length).toBeGreaterThan(0);
    }
  });

  it("defaults the action binary to empty so the resolver decides", () => {
    expect(DEFAULT_AGENT_BIN).toBe("");
  });

  it("keeps the board CLI default empty from module settings", () => {
    expect(PI_MODULE_PREFS_DEFAULTS.boardBin).toBe("");
  });

  // Rail and full mode share BoardView, so both re-poll on the same
  // visibility-gated 10s cadence; refreshKey bumps stay the fast path.
  it("polls every 10 seconds in both modes", () => {
    expect(POLL_MS).toBe(10000);
  });
});
