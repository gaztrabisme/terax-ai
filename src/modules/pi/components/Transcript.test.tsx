import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  initialPiSessionState,
  messageBlocks,
  type PiFeedItem,
} from "../lib/parse";
import { groupTurns } from "../lib/turns";
import {
  formatCost,
  openArtifactEvent,
  Transcript,
  usageByTurn,
  usageLabel,
  workedLabel,
} from "./Transcript";

const here = path.dirname(fileURLToPath(import.meta.url));

// Same driver-log shape as parse.test.ts reads; the stdout entries are what
// the reducer sees. A fixed `now` pins every block timestamp so the footer's
// "Worked N s" is deterministic.
function replayFixture(fixture: string, now = 1000): PiFeedItem[] {
  const text = readFileSync(
    path.join(here, "../lib/__fixtures__", fixture),
    "utf8",
  );
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { dir: string; raw: string })
    .filter((entry) => entry.dir === "stdout")
    .map((entry) => entry.raw)
    .reduce((state, raw) => {
      const next = applyEvent(state, raw, now);
      return { ...state, ...next };
    }, initialPiSessionState()).blocks;
}

describe("turn footer usage", () => {
  const blocks = replayFixture("q8-rpc-retry-success.jsonl");
  const turn = groupTurns(messageBlocks(blocks))[0];
  const usage = usageByTurn(blocks).get(0) ?? null;

  it("sums the turn's assistant message usage", () => {
    expect(usage).toEqual({
      input: 1204,
      output: 312,
      cacheRead: 9700,
      cacheWrite: 0,
      totalTokens: 11216,
      costTotal: 0.0031,
    });
  });

  it("appends tokens and cached share after the worked label", () => {
    expect(usageLabel(usage!)).toBe("1,204 in, 312 out, 89% cached");
    expect(workedLabel(turn, usage)).toBe(
      "Worked 1 s, 1,204 in, 312 out, 89% cached, $0.0031",
    );
  });

  it("renders the footer and the retry cards on the turn", () => {
    const html = renderToStaticMarkup(
      <Transcript blocks={blocks} onAnswer={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain(
      "Worked 1 s, 1,204 in, 312 out, 89% cached, $0.0031",
    );
    expect(html).toContain("retrying 1/3 in 4 s");
    expect(html).toContain("retry 1 succeeded");
  });

  it("shows no cost for a zero-cost turn and no usage for a failed one", () => {
    const localBlocks: PiFeedItem[] = [
      {
        kind: "message",
        id: "m0",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        model: null,
        usage: null,
        streaming: false,
        at: 1000,
      },
      {
        kind: "message",
        id: "m1",
        role: "assistant",
        // The thinking part gives the turn an activity fold, which carries
        // the footer.
        parts: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hello" },
        ],
        model: "Qwen3.6-35B-A3B-OptiQ-4bit",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          costTotal: 0,
        },
        streaming: false,
        at: 2000,
      },
    ];
    const localTurn = groupTurns(messageBlocks(localBlocks))[0];
    const localUsage = usageByTurn(localBlocks).get(0) ?? null;
    expect(workedLabel(localTurn, localUsage)).toBe(
      "Worked 1 s, 100 in, 20 out, 0% cached",
    );
    const html = renderToStaticMarkup(
      <Transcript
        blocks={localBlocks}
        onAnswer={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("100 in, 20 out");
    expect(html).not.toContain("$");
  });
});

describe("formatCost", () => {
  it("keeps four decimals for per-turn sums and two once a run adds up", () => {
    expect(formatCost(0.0031)).toBe("$0.0031");
    expect(formatCost(0.0099)).toBe("$0.0099");
    expect(formatCost(0.92)).toBe("$0.92");
    expect(formatCost(0)).toBe("$0.0000");
  });
});

describe("artifact chip", () => {
  const base = {
    kind: "message",
    model: null,
    usage: null,
    streaming: false,
    at: 1000,
  } as const;

  const blocksWithHtml: PiFeedItem[] = [
    {
      ...base,
      id: "u0",
      role: "user",
      parts: [{ type: "text", text: "draw a page" }],
    },
    {
      ...base,
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Here you go.\n\n```html\n<html><head><title>P</title></head><body></body></html>\n```",
        },
      ],
    },
  ];

  it("offers Open artifact on answers that carry one and stays quiet otherwise", () => {
    const withHtml = renderToStaticMarkup(
      <Transcript
        blocks={blocksWithHtml}
        onAnswer={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(withHtml).toContain("Open artifact");

    const plain: PiFeedItem[] = [
      {
        ...base,
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "just talk" }],
      },
      {
        ...base,
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "```js\nx();\n``` no page here" }],
      },
    ];
    const withoutHtml = renderToStaticMarkup(
      <Transcript blocks={plain} onAnswer={() => {}} onDismiss={() => {}} />,
    );
    expect(withoutHtml).not.toContain("Open artifact");
  });

  it("builds the pane event with the turn and artifact index", () => {
    const event = openArtifactEvent(3, 1);
    expect(event.type).toBe("pi:open-artifact");
    expect(event.detail).toEqual({ turn: 3, n: 1 });
  });
});
