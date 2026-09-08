// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { recordedOutput } from "@/modules/terminal/lib/recordedOutput";

const theme = { foreground: "#ffffff", background: "#000000", red: "#ff0000" };
const text = (lines: Awaited<ReturnType<typeof recordedOutput>>) =>
  lines.map((line) => line.map((span) => span.text).join("")).join("\n");

describe("recorded output uses the live VT parser", () => {
  it("replays colors, carriage returns, erasure and backspace", async () => {
    const lines = await recordedOutput(
      "first\r\x1b[2K\x1b[31mlast\x1b[0m\r\nabc\bZ",
      80,
      theme,
    );
    expect(text(lines)).toBe("last\nabZ");
    expect(lines[0][0].style.color).toBe("#ff0000");
  });

  it("renders terminal HTML as text and never runs OSC commands", async () => {
    const lines = await recordedOutput(
      "<script>alert(1)</script>\x1b]133;C;rm -rf\x07\x1b]52;c;Zm9v\x07",
      80,
      theme,
    );
    expect(text(lines)).toBe("<script>alert(1)</script>");
  });

  it("keeps Unicode and styled output when parser work is queued", async () => {
    const [a, b] = await Promise.all([
      recordedOutput("界\r\nnext", 80, theme),
      recordedOutput("\x1b[1;38;2;1;2;3mRGB", 80, theme),
    ]);
    expect(text(a)).toBe("界\nnext");
    expect(text(b)).toBe("RGB");
    expect(b[0][0].style).toMatchObject({
      color: "#010203",
      fontWeight: "bold",
    });
  });
});
