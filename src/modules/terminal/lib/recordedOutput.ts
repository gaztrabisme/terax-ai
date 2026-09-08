import { Terminal, type IBufferCell, type ITheme } from "@xterm/xterm";
import type { CSSProperties } from "react";

export type OutputSpan = { text: string; style: CSSProperties };
let pending: Promise<unknown> = Promise.resolve();

function palette(index: number, theme: ITheme): string | undefined {
  const names = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ] as const;
  if (index < 16) return theme[names[index]];
  if (index >= 232)
    return `rgb(${[1, 2, 3].map(() => 8 + (index - 232) * 10).join(",")})`;
  const n = index - 16;
  const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return `rgb(${[level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)].join(",")})`;
}

function cellStyle(cell: IBufferCell, theme: ITheme): CSSProperties {
  const color = (foreground: boolean) => {
    const n = foreground ? cell.getFgColor() : cell.getBgColor();
    if (foreground ? cell.isFgRGB() : cell.isBgRGB())
      return `#${n.toString(16).padStart(6, "0")}`;
    return (foreground ? cell.isFgPalette() : cell.isBgPalette())
      ? palette(n, theme)
      : undefined;
  };
  let fg = color(true);
  let bg = color(false);
  if (cell.isInverse())
    [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: cell.isBold() ? "bold" : undefined,
    fontStyle: cell.isItalic() ? "italic" : undefined,
    opacity: cell.isDim() ? 0.5 : undefined,
    visibility: cell.isInvisible() ? "hidden" : undefined,
    textDecoration:
      [
        cell.isUnderline() ? "underline" : "",
        cell.isStrikethrough() ? "line-through" : "",
        cell.isOverline() ? "overline" : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

/** Use the same VT parser as the live shell, with no input or OSC side effects. */
export function recordedOutput(
  raw: string,
  cols: number,
  theme: ITheme,
): Promise<OutputSpan[][]> {
  const render = async () => {
    const term = new Terminal({
      cols,
      rows: 24,
      scrollback: Math.max(1, raw.length),
      allowProposedApi: true,
      disableStdin: true,
    });
    try {
      await new Promise<void>((resolve) => term.write(raw, resolve));
      const buffer = term.buffer.active;
      const lines: OutputSpan[][] = [];
      let lastContent = -1;
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y)!;
        const spans: OutputSpan[] = [];
        let previousStyle = "";
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x)!;
          if (cell.getWidth() === 0) continue;
          const style = cellStyle(cell, theme);
          const key = JSON.stringify(style);
          const text = cell.getChars() || " ";
          if (cell.getChars()) lastContent = y;
          if (spans.length && previousStyle === key)
            spans[spans.length - 1].text += text;
          else spans.push({ text, style });
          previousStyle = key;
        }
        if (spans.length)
          spans[spans.length - 1].text = spans[spans.length - 1].text.trimEnd();
        lines.push(spans);
      }
      return lines.slice(0, Math.max(0, lastContent + 1));
    } finally {
      term.dispose();
    }
  };
  const result = pending.then(render, render);
  pending = result.catch(() => {});
  return result;
}
