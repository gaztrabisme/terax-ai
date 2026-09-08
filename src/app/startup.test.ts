// K14 dock recovery: the pure decision behind a no-argument launch (design.md
// row R1.3 and the TUESDAY T1 row). A recorded last project reopens only when
// it both exists and is authorized; anything else shows the folder picker.

import { describe, expect, it } from "vitest";

import { chooseStartupProject } from "./startup";

const exists = (paths: string[]) => (path: string) => paths.includes(path);
const yes = () => true;
const no = () => false;

describe("chooseStartupProject", () => {
  it("opens the last project when it exists and is authorized", () => {
    const decision = chooseStartupProject(
      { lastProject: "/proj/a" },
      exists(["/proj/a"]),
      yes,
    );
    expect(decision).toEqual({ action: "open", path: "/proj/a" });
  });

  it("shows the picker with the recorded path when the project is missing", () => {
    const decision = chooseStartupProject(
      { lastProject: "/proj/gone" },
      exists([]),
      yes,
    );
    expect(decision).toEqual({ action: "picker", missingPath: "/proj/gone" });
  });

  it("shows the picker when the recorded project is not authorized", () => {
    const decision = chooseStartupProject(
      { lastProject: "/proj/b" },
      exists(["/proj/b"]),
      no,
    );
    // Existing but unauthorized never reopens it, and the picker still names
    // the refused path so the owner knows what needed consent.
    expect(decision).toEqual({ action: "picker", missingPath: "/proj/b" });
  });

  it("shows the picker without a missing path when no project was recorded", () => {
    expect(chooseStartupProject({ lastProject: null }, exists([]), yes)).toEqual(
      { action: "picker", missingPath: null },
    );
  });

  it("treats a blank lastProject as absent", () => {
    expect(chooseStartupProject({ lastProject: "   " }, yes, yes)).toEqual({
      action: "picker",
      missingPath: null,
    });
  });
});
