import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const aborts: number[] = [];
const exits: Array<(code: number) => void> = [];
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
    exits.push(opts.onExit ?? (() => {}));
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
      abort: async () => {
        aborts.push(1);
      },
      kill: async () => {
        opts.onExit?.(0);
      },
    };
  },
);

import { usePreferencesStore } from "@/modules/settings/preferences";
import { usePiStore } from "./piStore";

// Every patch goes through zustand's set(); a patch that returns the tabs map
// instead of { tabs } silently updates nothing. Assert through the store.
describe("piStore", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
    aborts.length = 0;
    exits.length = 0;
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
    // The mocked session fires agent_start on open (status "thinking");
    // this test pins the plain idle-path wire shape.
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        5: { ...s.tabs[5]!, state: { ...s.tabs[5]!.state, status: "idle" } },
      },
    }));
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
    await usePiStore
      .getState()
      .sendPrompt(9, "look", [{ mediaType: "image/png", data: "AAAA" }]);
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
      savedAttachments: [{ path: ".pi/attachments/0-0.png", error: null }],
    });

    await usePiStore
      .getState()
      .sendPrompt(9, "next", [{ mediaType: "image/png", data: "BBBB" }]);
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
    await usePiStore
      .getState()
      .sendPrompt(10, "still send", [{ mediaType: "image/png", data: "AAAA" }]);
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

  it("sends streamingBehavior follow-up while busy and queues the prompt", async () => {
    await usePiStore.getState().openSession(11, { cwd: "/tmp/p" });
    // The mocked session fires agent_start on open: status turns thinking.
    await new Promise((r) => setTimeout(r, 0));
    expect(usePiStore.getState().tabs[11]?.state.status).toBe("thinking");

    await usePiStore.getState().sendPrompt(11, "hold this");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: "prompt",
      message: "hold this",
      streamingBehavior: "follow-up",
    });
    const entry = usePiStore.getState().tabs[11];
    expect(entry?.queued).toEqual([
      { id: expect.any(String), text: "hold this", images: [], acked: false },
    ]);

    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    // pi's ack for a queued follow-up is the prompt response itself.
    onEvent('{"type":"response","command":"prompt","success":true}');
    expect(usePiStore.getState().tabs[11]?.queued?.[0]?.acked).toBe(true);

    // The queued text leaves the queue when pi emits its user block.
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"hold this"}}',
    );
    expect(usePiStore.getState().tabs[11]?.queued).toEqual([]);
  });

  it("keeps a queued entry when another user block arrives first", async () => {
    await usePiStore.getState().openSession(14, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(14, "hold this");
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"something else"}}',
    );
    expect(usePiStore.getState().tabs[14]?.queued).toHaveLength(1);
  });

  it("hands the text back when pi answers success:false", async () => {
    await usePiStore.getState().openSession(12, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(12, "queue me");
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"response","command":"prompt","success":false,"error":"Agent is currently streaming; specify streamingBehavior"}',
    );
    const entry = usePiStore.getState().tabs[12];
    // The refused queued entry leaves the queue; the rejection card stays.
    expect(entry?.queued).toEqual([]);
    expect(entry?.rejectedDraft).toEqual({
      text: "queue me",
      images: [],
      error: "Agent is currently streaming; specify streamingBehavior",
      records: [],
    });
    expect(
      entry?.state.blocks.some(
        (block) =>
          block.kind === "error" && block.text.startsWith("prompt rejected"),
      ),
    ).toBe(true);
    // Once handled, clearRejectedDraft resets the field.
    usePiStore.getState().clearRejectedDraft(12);
    expect(usePiStore.getState().tabs[12]?.rejectedDraft).toBeNull();
  });

  it("hands the text back when the write throws", async () => {
    openPiSessionMock.mockImplementationOnce(
      async (opts: { onExit?: (c: number) => void }) => ({
        id: 9,
        send: async () => {
          throw new Error("stdin closed");
        },
        abort: async () => {
          throw new Error("stdin closed");
        },
        kill: async () => {
          opts.onExit?.(0);
        },
      }),
    );
    await usePiStore.getState().openSession(13, { cwd: "/tmp/p" });
    await expect(
      usePiStore.getState().sendPrompt(13, "lost text"),
    ).rejects.toThrow("stdin closed");
    expect(usePiStore.getState().tabs[13]?.rejectedDraft).toEqual({
      text: "lost text",
      images: [],
      error: "stdin closed",
    });
  });

  it("removeQueued recalls the text to the composer path", async () => {
    await usePiStore.getState().openSession(15, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(15, "take me back");
    const id = usePiStore.getState().tabs[15]?.queued?.[0]?.id;
    expect(id).toBeTruthy();
    usePiStore.getState().removeQueued(15, id!);
    const entry = usePiStore.getState().tabs[15];
    expect(entry?.queued).toEqual([]);
    expect(entry?.rejectedDraft).toEqual({
      text: "take me back",
      images: [],
      error: null,
    });
  });

  it("runs the K13 transaction: stages before send, binds on the user block", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "pi_stage_submission") {
        return [
          {
            attachmentId: (args?.attachments as { attachmentId: string }[])[0]!
              .attachmentId,
            path: `.pi/attachments/${args?.submissionId}-att-1.png`,
            sha256: "f00d",
          },
        ];
      }
      if (command === "fs_read_file") return { kind: "text", content: "" };
      if (command === "fs_read_dir") return [];
      return undefined;
    });
    await usePiStore.getState().openSession(20, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(20, "look", [
      {
        mediaType: "image/png",
        data: "AAAA",
        attachmentId: "att-1",
        draftPath: ".pi/drafts/tab-att-1.png",
        sha256: "cafe",
      } as never,
    ]);
    expect(sent).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("pi_stage_submission", {
      cwd: "/tmp/p",
      submissionId: expect.stringMatching(/^sub-\d+$/),
      attachments: [{ attachmentId: "att-1", path: ".pi/drafts/tab-att-1.png" }],
      workspace: { kind: "local" },
    });
    const submissionId = (invokeMock.mock.calls.find(
      ([cmd]) => cmd === "pi_stage_submission",
    )?.[1] as { submissionId: string }).submissionId;

    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"look"}}',
    );
    await new Promise((r) => setTimeout(r, 0));
    // The chip binds to the acknowledged turn with the staged path.
    expect(usePiStore.getState().tabs[20]?.state.blocks[0]).toMatchObject({
      savedAttachments: [
        { path: `.pi/attachments/${submissionId}-att-1.png`, error: null },
      ],
    });
    // The index append rides the acknowledgement, atomically.
    expect(invokeMock).toHaveBeenCalledWith("pi_record_attachment_binding", {
      cwd: "/tmp/p",
      submissionId,
      sessionId: "abcd1234-test",
      turnId: expect.any(String),
      bindings: [
        {
          attachmentId: "att-1",
          path: `.pi/attachments/${submissionId}-att-1.png`,
          sha256: "f00d",
        },
      ],
      workspace: { kind: "local" },
    });
  });

  it("a refused send marks the submission failed and never binds a later turn", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pi_stage_submission")
        return [
          {
            attachmentId: "att-1",
            path: ".pi/attachments/sub-x-att-1.png",
            sha256: "f00d",
          },
        ];
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return undefined;
    });
    await usePiStore.getState().openSession(21, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(21, "hold", [
      {
        mediaType: "image/png",
        data: "AAAA",
        attachmentId: "att-1",
        draftPath: ".pi/drafts/tab-att-1.png",
      } as never,
    ]);
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"response","command":"prompt","success":false,"error":"Agent is currently streaming; specify streamingBehavior"}',
    );
    let entry = usePiStore.getState().tabs[21];
    expect(entry?.failedSubmission).toMatchObject({
      state: "failed",
      error: "Agent is currently streaming; specify streamingBehavior",
      records: [
        { attachmentId: "att-1", stagedPath: ".pi/attachments/sub-x-att-1.png" },
      ],
    });
    // The pending set left the queue with the refusal.
    expect(entry?.pendingAttachments).toEqual([]);

    // A later plain turn must not own the failed submission's chip.
    await usePiStore.getState().sendPrompt(21, "plain text");
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"plain text"}}',
    );
    entry = usePiStore.getState().tabs[21];
    const plain = entry?.state.blocks.find(
      (block) =>
        block.kind === "message" &&
        block.role === "user" &&
        (block as { parts: { text?: string }[] }).parts.some(
          (part) => part.text === "plain text",
        ),
    );
    expect(plain).toBeTruthy();
    expect(
      (plain as { savedAttachments?: unknown[] } | undefined)
        ?.savedAttachments,
    ).toBeUndefined();
  });

  it("retrySubmission resends the same submission id and binds on its own ack", async () => {
    let stageCount = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pi_stage_submission") {
        stageCount += 1;
        return [
          {
            attachmentId: "att-1",
            path: ".pi/attachments/sub-r-att-1.png",
            sha256: "f00d",
          },
        ];
      }
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return undefined;
    });
    await usePiStore.getState().openSession(22, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(22, "hold", [
      {
        mediaType: "image/png",
        data: "AAAA",
        attachmentId: "att-1",
        draftPath: ".pi/drafts/tab-att-1.png",
      } as never,
    ]);
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent(
      '{"type":"response","command":"prompt","success":false,"error":"Agent is currently streaming; specify streamingBehavior"}',
    );
    const submissionId = usePiStore.getState().tabs[22]?.failedSubmission
      ?.submissionId as string;

    sent.length = 0;
    await usePiStore.getState().retrySubmission(22, submissionId);
    // Same id staged and sent; the failure stands until the ack.
    expect(stageCount).toBe(2);
    expect(JSON.parse(sent[0]!)).toMatchObject({ message: "hold" });
    expect(usePiStore.getState().tabs[22]?.failedSubmission).toMatchObject({
      state: "retrying",
    });

    // pi's command ack clears the standing failure; its user block binds.
    onEvent('{"type":"response","command":"prompt","success":true}');
    expect(usePiStore.getState().tabs[22]?.failedSubmission).toBeNull();
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"hold"}}',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith(
      "pi_record_attachment_binding",
      expect.objectContaining({ submissionId }),
    );
    expect(usePiStore.getState().tabs[22]?.failedSubmission).toBeNull();
  });

  // F3 regression (UAT k13-03, review UX-05): the pre-fix backend replied
  // with a snake_case attachment_id the store cannot read, so every staged
  // reply looked unstaged and the send died with "attachment copy failed"
  // although the staged file existed. The mocked invokes run in the order
  // the app uses: stage, then the send that must never happen.
  it("a staged reply with no matching id refuses the send with the exact copy failed error", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pi_stage_submission")
        // Same shape the real wire carried pre-fix: no attachmentId key.
        return [
          { path: ".pi/attachments/sub-x-att-1.png", sha256: "f00d" },
        ] as never;
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return undefined;
    });
    await usePiStore.getState().openSession(23, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await expect(
      usePiStore.getState().sendPrompt(23, "look", [
        {
          mediaType: "image/jpeg",
          data: "AAAA",
          attachmentId: "att-1",
          draftPath: ".pi/drafts/2p5ta54a14-att-1.jpg",
          sha256: "cafe",
        } as never,
      ]),
    ).rejects.toThrow("attachment copy failed: .pi/drafts/2p5ta54a14-att-1.jpg");
    // The refusal happens before the wire: pi never sees the prompt.
    expect(sent).toHaveLength(0);
    const entry = usePiStore.getState().tabs[23];
    expect(entry?.failedSubmission).toMatchObject({
      state: "failed",
      error: "attachment copy failed: .pi/drafts/2p5ta54a14-att-1.jpg",
      records: [
        {
          attachmentId: "att-1",
          draftPath: ".pi/drafts/2p5ta54a14-att-1.jpg",
          stagedPath: null,
        },
      ],
    });
    expect(entry?.rejectedDraft).toMatchObject({
      text: "look",
      error: "attachment copy failed: .pi/drafts/2p5ta54a14-att-1.jpg",
    });
  });

  it("a send that throws after staging retries from the staged copy and binds on its acknowledged turn", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "pi_stage_submission")
        return [
          {
            attachmentId: "att-1",
            path: ".pi/attachments/sub-t-att-1.png",
            sha256: "f00d",
          },
        ];
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return undefined;
    });
    openPiSessionMock.mockImplementationOnce(
      async (opts: { onEvent: (l: string) => void }) => {
        queueMicrotask(() =>
          opts.onEvent(
            JSON.stringify({ type: "agent_start", sessionId: "abcd1234-test" }),
          ),
        );
        let sendCalls = 0;
        return {
          id: 9,
          // The first write fails (the transport died); the retry's write
          // goes through so the acknowledged turn can bind.
          send: async (line: string) => {
            sendCalls += 1;
            if (sendCalls === 1) throw new Error("stdin closed");
            sent.push(line);
          },
          abort: async () => {},
          kill: async () => {},
        };
      },
    );
    await usePiStore.getState().openSession(24, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await expect(
      usePiStore.getState().sendPrompt(24, "hold", [
        {
          mediaType: "image/png",
          data: "AAAA",
          attachmentId: "att-1",
          draftPath: ".pi/drafts/tab-att-1.png",
        } as never,
      ]),
    ).rejects.toThrow("stdin closed");
    const failed = usePiStore.getState().tabs[24]?.failedSubmission;
    const submissionId = failed?.submissionId as string;
    expect(failed).toMatchObject({ state: "failed" });
    expect(submissionId).toMatch(/^sub-\d+$/);
    expect(failed?.records[0]?.stagedPath).toBe(
      ".pi/attachments/sub-t-att-1.png",
    );

    sent.length = 0;
    await usePiStore.getState().retrySubmission(24, submissionId);
    // The retry restages the same submission id from the staged copy.
    const stageCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "pi_stage_submission",
    );
    expect(stageCalls).toHaveLength(2);
    expect(
      (stageCalls[1]![1] as { attachments: { path: string }[] }).attachments[0]
        ?.path,
    ).toBe(".pi/attachments/sub-t-att-1.png");
    expect(JSON.parse(sent[0]!)).toMatchObject({ message: "hold" });

    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent('{"type":"response","command":"prompt","success":true}');
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"hold"}}',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith(
      "pi_record_attachment_binding",
      expect.objectContaining({
        submissionId,
        bindings: [
          {
            attachmentId: "att-1",
            path: ".pi/attachments/sub-t-att-1.png",
            sha256: "f00d",
          },
        ],
      }),
    );
    expect(usePiStore.getState().tabs[24]?.failedSubmission).toBeNull();
  });

  it("removing the composer chips after a failure leaves the card retryable from the staged bytes", async () => {
    // After the failure the user removes the chips: the draft files are
    // deleted on disk while the store's failed card keeps its staged copy.
    // Staging the deleted draft path must fail; only the staged copy reads.
    let stageCount = 0;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "pi_stage_submission") {
        const requests = (args as {
          attachments: { attachmentId: string; path: string }[];
        }).attachments;
        // The draft exists for the first staging; the chip removal that
        // follows the failure deletes it, so later reads of the drafts
        // path (what a retry sourced from pre-fix) find nothing.
        if (
          stageCount > 0 &&
          requests.some((r) => r.path.startsWith(".pi/drafts/"))
        ) {
          throw new Error(
            "cannot read attachment source /tmp/p/.pi/drafts/tab-att-1.png",
          );
        }
        stageCount += 1;
        return [
          {
            attachmentId: requests[0]!.attachmentId,
            path: ".pi/attachments/sub-r-att-1.png",
            sha256: "f00d",
          },
        ];
      }
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return undefined;
    });
    openPiSessionMock.mockImplementationOnce(
      async (opts: { onEvent: (l: string) => void }) => {
        queueMicrotask(() =>
          opts.onEvent(
            JSON.stringify({ type: "agent_start", sessionId: "abcd1234-test" }),
          ),
        );
        let sendCalls = 0;
        return {
          id: 9,
          // The first write fails; the retry's write goes through.
          send: async (line: string) => {
            sendCalls += 1;
            if (sendCalls === 1) throw new Error("stdin closed");
            sent.push(line);
          },
          abort: async () => {},
          kill: async () => {},
        };
      },
    );
    await usePiStore.getState().openSession(25, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await expect(
      usePiStore.getState().sendPrompt(25, "hold", [
        {
          mediaType: "image/png",
          data: "AAAA",
          attachmentId: "att-1",
          draftPath: ".pi/drafts/tab-att-1.png",
        } as never,
      ]),
    ).rejects.toThrow("stdin closed");
    const submissionId = usePiStore.getState().tabs[25]?.failedSubmission
      ?.submissionId as string;
    expect(submissionId).toMatch(/^sub-\d+$/);
    expect(
      usePiStore.getState().tabs[25]?.failedSubmission?.records[0]?.stagedPath,
    ).toBe(".pi/attachments/sub-r-att-1.png");

    sent.length = 0;
    // The chips are gone; the draft file no longer exists. The retry must
    // still send: it reads the staged bytes, never the deleted draft.
    await usePiStore.getState().retrySubmission(25, submissionId);
    const retryStage = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "pi_stage_submission",
    )[1]!;
    expect(
      (retryStage[1] as { attachments: { path: string }[] }).attachments[0]
        ?.path,
    ).toBe(".pi/attachments/sub-r-att-1.png");
    expect(JSON.parse(sent[0]!)).toMatchObject({ message: "hold" });
    // The card stays scoped to the submission while the retry is in flight,
    // then its own acknowledged turn binds and the card clears.
    expect(usePiStore.getState().tabs[25]?.failedSubmission).toMatchObject({
      state: "retrying",
      submissionId,
    });
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    const onEvent = calls[calls.length - 1]![0].onEvent;
    onEvent('{"type":"response","command":"prompt","success":true}');
    onEvent(
      '{"type":"message_start","message":{"role":"user","content":"hold"}}',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith(
      "pi_record_attachment_binding",
      expect.objectContaining({ submissionId }),
    );
    expect(usePiStore.getState().tabs[25]?.failedSubmission).toBeNull();
  });
});

describe("piStore cancellation and queue acknowledgement", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
    aborts.length = 0;
    exits.length = 0;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return { kind: "text", content: "" };
      return ".pi/attachments/0-0.png";
    });
  });

  function lastEvents() {
    const calls = vi.mocked(openPiSessionMock).mock.calls;
    return calls[calls.length - 1]![0].onEvent;
  }

  it("Stop sends the rpc abort, flips to cancelling, then idle on the abort response", async () => {
    await usePiStore.getState().openSession(30, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    expect(usePiStore.getState().tabs[30]?.state.status).toBe("thinking");

    await usePiStore.getState().cancelTurn(30);
    expect(aborts).toHaveLength(1);
    expect(usePiStore.getState().tabs[30]?.state.status).toBe("cancelling");
    expect(usePiStore.getState().tabs[30]?.state.cancelRequested).toBe(true);

    // pi answers abort with response_ok: Cancelling resolves at once while
    // the run drains; the flag stays so the closing agent_end cannot turn
    // pi's own "Aborted" error into a failure card.
    lastEvents()('{"type":"response","command":"abort","success":true}');
    expect(usePiStore.getState().tabs[30]?.state.status).toBe("idle");
    expect(usePiStore.getState().tabs[30]?.state.cancelRequested).toBe(true);

    lastEvents()(
      '{"type":"agent_end","messages":[],"error":"Aborted"}',
    );
    const entry = usePiStore.getState().tabs[30]!;
    expect(entry.state.status).toBe("idle");
    expect(entry.state.cancelRequested).toBe(false);
    expect(
      entry.state.blocks.filter((block) => block.kind === "error"),
    ).toHaveLength(0);
  });

  it("cancelTurn is a no-op when idle and never kills the session", async () => {
    await usePiStore.getState().openSession(31, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    usePiStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        31: { ...s.tabs[31]!, state: { ...s.tabs[31]!.state, status: "idle" } },
      },
    }));
    await usePiStore.getState().cancelTurn(31);
    expect(aborts).toHaveLength(0);
    expect(usePiStore.getState().tabs[31]?.state.status).toBe("idle");
  });

  it("cancelTurn during an auto-retry also withdraws the retry", async () => {
    await usePiStore.getState().openSession(32, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    lastEvents()(
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":4000,"errorMessage":"boom"}',
    );
    await usePiStore.getState().cancelTurn(32);
    expect(aborts).toHaveLength(1);
    expect(JSON.parse(sent[sent.length - 1]!)).toEqual({ type: "abort_retry" });
    expect(usePiStore.getState().tabs[32]?.state.retry).toBeNull();
  });

  it("a failed abort write surfaces the error instead of staying silent", async () => {
    openPiSessionMock.mockImplementationOnce(
      async (opts: { onEvent: (l: string) => void }) => {
        queueMicrotask(() =>
          opts.onEvent(
            JSON.stringify({ type: "agent_start", sessionId: "abcd1234-test" }),
          ),
        );
        return {
          id: 8,
          send: async () => {},
          abort: async () => {
            throw new Error("stdin closed");
          },
          kill: async () => {},
        };
      },
    );
    await usePiStore.getState().openSession(33, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().cancelTurn(33);
    expect(usePiStore.getState().tabs[33]?.error).toBe("stdin closed");
  });

  it("process exit while thinking sets idle with the exited marker", async () => {
    await usePiStore.getState().openSession(34, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    expect(usePiStore.getState().tabs[34]?.state.status).toBe("thinking");
    exits[exits.length - 1]!(0);
    const entry = usePiStore.getState().tabs[34]!;
    expect(entry.exited).toBe(true);
    expect(entry.exitCode).toBe(0);
    expect(entry.session).toBeNull();
    expect(entry.state.status).toBe("idle");
    expect(entry.state.cancelRequested).toBe(false);
  });

  it("a second send while one is queued joins the queue and both acks land", async () => {
    await usePiStore.getState().openSession(35, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(35, "Reply FAST_A.");
    await usePiStore.getState().sendPrompt(35, "Reply FAST_B.");
    const entry = usePiStore.getState().tabs[35]!;
    expect(entry.queued?.map((q) => q.text)).toEqual([
      "Reply FAST_A.",
      "Reply FAST_B.",
    ]);
    expect(entry.pendingPrompts).toHaveLength(2);
    expect(JSON.parse(sent[1]!)).toMatchObject({
      streamingBehavior: "follow-up",
    });

    // Both responses arrive after both sends: acks land FIFO, once each.
    lastEvents()('{"type":"response","command":"prompt","success":true}');
    lastEvents()('{"type":"response","command":"prompt","success":true}');
    const after = usePiStore.getState().tabs[35]!;
    expect(after.queued?.every((q) => q.acked)).toBe(true);
    expect(after.pendingPrompts).toHaveLength(0);
  });

  it("a refusal of the second send removes its queue entry and keeps its text", async () => {
    await usePiStore.getState().openSession(36, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(36, "Reply FAST_A.");
    lastEvents()('{"type":"response","command":"prompt","success":true}');
    await usePiStore.getState().sendPrompt(36, "Reply FAST_B.");
    lastEvents()(
      '{"type":"response","command":"prompt","success":false,"error":"Follow-up queue is full"}',
    );
    const entry = usePiStore.getState().tabs[36]!;
    expect(entry.queued?.map((q) => q.text)).toEqual(["Reply FAST_A."]);
    expect(entry.pendingPrompts).toHaveLength(0);
    expect(entry.rejectedDraft).toMatchObject({
      text: "Reply FAST_B.",
      error: "Follow-up queue is full",
    });
    expect(
      entry.state.blocks.some(
        (block) =>
          block.kind === "error" && block.text.startsWith("prompt rejected"),
      ),
    ).toBe(true);
  });

  it("a send during a cancel is refused visibly with the text kept", async () => {
    await usePiStore.getState().openSession(37, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().cancelTurn(37);
    await expect(
      usePiStore.getState().sendPrompt(37, "too late"),
    ).rejects.toThrow("cancellation in progress");
    const entry = usePiStore.getState().tabs[37]!;
    expect(entry.rejectedDraft).toMatchObject({
      text: "too late",
      error: "cancellation in progress; send again once the strip is idle",
    });
    expect(sent).toHaveLength(0);
  });

  it("openSession passes the global piAgentBin pref to the launch (F7b)", async () => {
    usePreferencesStore.setState({ piAgentBin: "$HOME/bin/pi-agent" });
    try {
      await usePiStore.getState().openSession(38, { cwd: "/tmp/p" });
      expect(openPiSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ agentBin: "$HOME/bin/pi-agent" }),
      );
    } finally {
      usePreferencesStore.setState({ piAgentBin: "" });
    }
  });
});
