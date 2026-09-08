import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const { invokeMock, openPiSessionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openPiSessionMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./rpc-client", () => ({ openPiSession: openPiSessionMock }));

openPiSessionMock.mockImplementation(
  async (opts: {
    onEvent: (l: string) => void;
    onExit?: (c: number) => void;
  }) => {
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
  },
);

import { usePiStore } from "./piStore";

// Every patch goes through zustand's set(); a patch that returns the tabs map
// instead of { tabs } silently updates nothing. Assert through the store.
describe("piStore", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return ".pi/attachments/0-0.png";
    });
  });

  it("stores the session handle and applies events into tabs", async () => {
    await usePiStore.getState().openSession(3, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    const entry = usePiStore.getState().tabs[3];
    expect(entry?.session?.id).toBe(7);
    expect(entry?.exited).toBe(false);
    expect(
      (usePiStore.getState() as unknown as Record<string, unknown>)["3"],
    ).toBeUndefined();
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

  it("sendPrompt carries images in pi's prompt shape", async () => {
    await usePiStore.getState().openSession(5, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(5, "look", [
      { mediaType: "image/png", data: "AAAA" },
      { mediaType: "image/jpeg", data: "/9j/4AA" },
    ]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: "prompt",
      message: "look",
      images: [
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "AAAA" },
        },
        {
          type: "image",
          source: { type: "base64", mediaType: "image/jpeg", data: "/9j/4AA" },
        },
      ],
    });
  });

  it("writes images before sending and records paths on the arriving user block", async () => {
    await usePiStore.getState().openSession(9, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(9, "look", [
      { mediaType: "image/png", data: "AAAA" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("pi_save_attachment", {
      cwd: "/tmp/p",
      turn: 0,
      n: 0,
      mediaType: "image/png",
      data: "AAAA",
      workspace: { kind: "local" },
    });

    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"look"}}',
    );
    expect(usePiStore.getState().tabs[9]?.state.blocks[0]).toMatchObject({
      role: "user",
      savedAttachments: [
        { path: ".pi/attachments/0-0.png", error: null },
      ],
    });

    await usePiStore.getState().sendPrompt(9, "next", [
      { mediaType: "image/png", data: "BBBB" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("pi_save_attachment", {
      cwd: "/tmp/p",
      turn: 1,
      n: 0,
      mediaType: "image/png",
      data: "BBBB",
      workspace: { kind: "local" },
    });
  });

  it("sends the prompt and records the write error when the attachment fails", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return { kind: "text", content: "" };
      throw new Error("disk full");
    });
    await usePiStore.getState().openSession(10, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(10, "still send", [
      { mediaType: "image/png", data: "AAAA" },
    ]);
    expect(sent).toHaveLength(1);
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"still send"}}',
    );
    expect(usePiStore.getState().tabs[10]?.state.blocks[0]).toMatchObject({
      savedAttachments: [{ path: null, error: "disk full" }],
    });
    expect(JSON.parse(sent[0])).toMatchObject({
      type: "prompt",
      message: "still send",
    });
  });

  it("accumulates session totals per tab and resets them on New session", async () => {
    await usePiStore.getState().openSession(6, { cwd: "/tmp/p" });
    // The mocked session's onEvent is the store's reduction entry point.
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"turn_end","message":{"role":"assistant","usage":{"input":1204,"output":312,"cacheRead":9700,"cacheWrite":0,"totalTokens":11216,"cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0031}}}}',
    );
    onEvent(
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":4000,"errorMessage":"429"}',
    );
    let entry = usePiStore.getState().tabs[6];
    expect(entry?.state.turnTokens).toBe(11216);
    expect(entry?.state.sessionCost).toBeCloseTo(0.0031, 6);
    expect(entry?.state.retry).toEqual({ attempt: 1, max: 3, delayMs: 4000 });

    // New session: close then open. The fresh entry starts from zero.
    await usePiStore.getState().kill(6);
    await usePiStore.getState().openSession(6, { cwd: "/tmp/p" });
    entry = usePiStore.getState().tabs[6];
    expect(entry?.state.turnTokens).toBe(0);
    expect(entry?.state.sessionCost).toBe(0);
    expect(entry?.state.retry).toBeNull();
  });

  it("keeps tabs isolated: totals stay per entry", async () => {
    await usePiStore.getState().openSession(7, { cwd: "/tmp/p" });
    await usePiStore.getState().openSession(8, { cwd: "/tmp/q" });
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"turn_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0.5}}}}',
    );
    expect(usePiStore.getState().tabs[7]?.state.turnTokens).toBe(0);
    expect(usePiStore.getState().tabs[8]?.state.turnTokens).toBe(2);
    expect(usePiStore.getState().tabs[8]?.state.sessionCost).toBeCloseTo(
      0.5,
      6,
    );
  });
});
