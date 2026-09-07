import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
vi.mock("./rpc-client", () => ({
  openPiSession: vi.fn(async (opts: { onEvent: (l: string) => void; onExit?: (c: number) => void }) => {
    queueMicrotask(() =>
      opts.onEvent(
        JSON.stringify({ type: "agent_start", sessionId: "abcd1234-test" }),
      ),
    );
    return {
      id: 7,
      send: async (line: string) => {
        sent.push(line);
      },
      kill: async () => {
        opts.onExit?.(0);
      },
    };
  }),
}));

import { usePiStore } from "./piStore";

// Every patch goes through zustand's set(); a patch that returns the tabs map
// instead of { tabs } silently updates nothing. Assert through the store.
describe("piStore", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
  });

  it("stores the session handle and applies events into tabs", async () => {
    await usePiStore.getState().openSession(3, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    const entry = usePiStore.getState().tabs[3];
    expect(entry?.session?.id).toBe(7);
    expect(entry?.exited).toBe(false);
    expect((usePiStore.getState() as unknown as Record<string, unknown>)["3"]).toBeUndefined();
  });

  it("sends prompts through the live session and records exit", async () => {
    await usePiStore.getState().openSession(4, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(4, "hello");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("hello");
    await usePiStore.getState().kill(4);
    expect(usePiStore.getState().tabs[4]?.exited).toBe(true);
    expect(usePiStore.getState().tabs[4]?.session).toBeNull();
  });
});
