import { describe, expect, it } from "vitest";
import { PI_MODULE_PREFS_DEFAULTS } from "@/modules/pi/lib/settingsSchema";
import { boardListCommand, boardShowCommand } from "./BoardPane";

describe("board command shape", () => {
  it("runs the configured binary with --root and keeps the subcommand", () => {
    expect(boardListCommand("/abs/path/bin/board", "/work/proj")).toBe(
      "'/abs/path/bin/board' --root '/work/proj' board",
    );
  });

  it("quotes the ticket id on show", () => {
    expect(boardShowCommand("/abs/bin/board", "/w", "T-12")).toBe(
      "'/abs/bin/board' --root '/w' show 'T-12'",
    );
  });

  it("defaults the binary to the efficient-pi checkout", () => {
    expect(PI_MODULE_PREFS_DEFAULTS.boardBin).toBe(
      "/Users/GaryT/Documents/Work/Lab/efficient-pi/bin/board",
    );
  });
});
