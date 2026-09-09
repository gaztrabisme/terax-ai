import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const aborts: number[] = [];
const exits: Array<(code: number) => void> = [];
const files = new Map<string, string>();
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
import { initialPiSessionState, type PiFeedItem } from "./parse";
import { usePiStore, type PendingSwitch } from "./piStore";

async function openIdle(tabId: number, opts: { cwd: string }) {
  await usePiStore.getState().openSession(tabId, opts);
  usePiStore.setState((s) => ({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId]!, state: { ...s.tabs[tabId]!.state, status: "idle" } } } }));
}
function events() { return openPiSessionMock.mock.calls[openPiSessionMock.mock.calls.length - 1]![0].onEvent as (line: string) => void; }
function startTurn() { events()('{"type":"agent_start","sessionId":"abcd1234-test"}'); }

// Every patch goes through zustand's set(); a patch that returns the tabs map
// instead of { tabs } silently updates nothing. Assert through the store.
describe("piStore", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
    aborts.length = 0;
    exits.length = 0;
    invokeMock.mockReset();
    files.clear();
    invokeMock.mockImplementation(async (command: string, args?: { path?: string; content?: string }) => {
      if (command === "fs_read_file") {
        if (!files.has(args!.path!)) throw new Error("no such file");
        return { kind: "text", content: files.get(args!.path!) };
      }
      if (command === "fs_write_file") files.set(args!.path!, args!.content!);
      if (command === "fs_delete") files.delete(args!.path!);
      return ".pi/attachments/0-0.png";
    });
  });

  it("stores the session handle and applies events into tabs", async () => {
    await openIdle(3, { cwd: "/tmp/p" });
    await new Promise((r) => setTimeout(r, 0));
    const entry = usePiStore.getState().tabs[3];
    expect(entry?.session?.id).toBe(7);
    expect(entry?.exited).toBe(false);
    expect(
      (usePiStore.getState() as unknown as Record<string, unknown>)["3"],
    ).toBeUndefined();
  });

  it("sends prompts through the live session and records exit", async () => {
    await openIdle(4, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(4, "hello");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("hello");
    await usePiStore.getState().kill(4);
    expect(usePiStore.getState().tabs[4]?.exited).toBe(true);
    expect(usePiStore.getState().tabs[4]?.session).toBeNull();
  });

  it("omits missing image payloads without blocking a text prompt", async () => {
    await openIdle(4, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(4, "text survives", [{
      mediaType: "image/png", data: "", attachmentId: "missing", draftPath: ".pi/drafts/missing.png", sha256: "saved-hash",
    }]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({ type: "prompt", message: "text survives" });
    expect(JSON.parse(sent[0]).images).toBeUndefined();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pi_stage_submission")).toBe(false);
    expect(usePiStore.getState().tabs[4]?.failedSubmission).toBeNull();
  });

  it("queues text without missing payloads while a turn is busy", async () => {
    await usePiStore.getState().openSession(4, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(4, "text survives", [{ mediaType: "image/png", data: "", attachmentId: "missing" }]);
    expect(sent).toEqual([]);
    expect(usePiStore.getState().tabs[4]?.queued).toMatchObject([{ text: "text survives", images: [], attachmentIds: [] }]);
    expect(JSON.parse(files.get("/tmp/p/.pi/drafts/4.json")!).queue).toMatchObject([{ text: "text survives", attachmentIds: [] }]);
  });

  it("preserves original bytes and metadata across queueing, clearing and Edit", async () => {
    await usePiStore.getState().openSession(4, { cwd: "/tmp/p" });
    const original = { path: ".pi/drafts/image.orig.png", sha256: "original-hash", mime: "image/png", bytes: 10 };
    files.set(`/tmp/p/${original.path}`, "original bytes");
    files.set("/tmp/p/.pi/drafts/4.json", JSON.stringify({ v: 1, submissionId: null, sources: [], attachments: [
      { id: "image", path: ".pi/drafts/image.png", sha256: "hash", mime: "image/png", state: "draft", original },
    ] }));
    await usePiStore.getState().sendPrompt(4, "image queued", [{ mediaType: "image/png", data: "aW1hZ2U=", attachmentId: "image", draftPath: ".pi/drafts/image.png", sha256: "hash" }]);
    const { clearDraft } = await import("./drafts");
    await clearDraft("/tmp/p", "4");
    const record = () => JSON.parse(files.get("/tmp/p/.pi/drafts/4.json")!);
    expect(record().attachments[0]).toMatchObject({ state: "queued", original });
    expect(record().queue).toHaveLength(1);
    await usePiStore.getState().editQueued(4, record().queue[0].id);
    expect(record().attachments[0]).toMatchObject({ state: "draft", original });
    expect(record().queue).toEqual([]);
    expect(files.get(`/tmp/p/${original.path}`)).toBe("original bytes");
  });

  it("does not send an empty prompt with only missing images", async () => {
    await usePiStore.getState().openSession(4, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(4, "", [{ mediaType: "image/png", data: "", attachmentId: "missing" }]);
    expect(sent).toEqual([]);
  });

  it("sendPrompt carries images in pi's prompt shape", async () => {
    await openIdle(5, { cwd: "/tmp/p" });
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
    await openIdle(9, { cwd: "/tmp/p" });
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

    events()('{"type":"agent_end"}');
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
      throw new Error("disk full");
    });
    await openIdle(10, { cwd: "/tmp/p" });
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
    await openIdle(6, { cwd: "/tmp/p" });
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
    await openIdle(6, { cwd: "/tmp/p" });
    entry = usePiStore.getState().tabs[6];
    expect(entry?.state.turnTokens).toBe(0);
    expect(entry?.state.sessionCost).toBe(0);
    expect(entry?.state.retry).toBeNull();
  });

  it("keeps tabs isolated: totals stay per entry", async () => {
    await openIdle(7, { cwd: "/tmp/p" });
    await openIdle(8, { cwd: "/tmp/q" });
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

  it("persists a busy prompt locally and sends it normally after success", async () => {
    await openIdle(11, { cwd: "/tmp/p" });
    startTurn();
    await usePiStore.getState().sendPrompt(11, "hold this");
    expect(sent).toHaveLength(0);
    const queued = usePiStore.getState().tabs[11]!.queued![0];
    expect(queued).toMatchObject({ text: "hold this", state: "queued" });
    expect(JSON.parse(files.get("/tmp/p/.pi/drafts/11.json")!).queue[0]).toMatchObject({ id: queued.id, text: "hold this", attachmentIds: [], submittedAt: expect.any(String) });
    events()('{"type":"agent_end"}');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.parse(sent[0])).toEqual({ type: "prompt", message: "hold this" });
    events()('{"type":"response","command":"prompt","success":true}');
    events()('{"type":"message_start","message":{"role":"user","content":"hold this"}}');
    expect(usePiStore.getState().tabs[11]!.queued).toEqual([]);
    await vi.waitFor(() => expect(JSON.parse(files.get("/tmp/p/.pi/drafts/11.json")!).queue).toEqual([]));
  });

  it("keeps a queued entry when another user block arrives first", async () => {
    await openIdle(14, { cwd: "/tmp/p" });
    startTurn();
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
    await openIdle(12, { cwd: "/tmp/p" });
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
    await openIdle(13, { cwd: "/tmp/p" });
    await expect(
      usePiStore.getState().sendPrompt(13, "lost text"),
    ).rejects.toThrow("stdin closed");
    expect(usePiStore.getState().tabs[13]?.rejectedDraft).toEqual({
      text: "lost text",
      images: [],
      error: "stdin closed",
    });
  });

  it("Edit recalls the text to the composer path", async () => {
    await openIdle(15, { cwd: "/tmp/p" });
    startTurn();
    await new Promise((r) => setTimeout(r, 0));
    await usePiStore.getState().sendPrompt(15, "take me back");
    const id = usePiStore.getState().tabs[15]?.queued?.[0]?.id;
    expect(id).toBeTruthy();
    await usePiStore.getState().editQueued(15, id!);
    const entry = usePiStore.getState().tabs[15];
    expect(entry?.queued).toEqual([]);
    expect(entry?.rejectedDraft).toMatchObject({
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
      if (command === "fs_read_dir") return [];
      return undefined;
    });
    await openIdle(20, { cwd: "/tmp/p" });
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
      submissionId: expect.stringMatching(/^sub-[a-f0-9-]+$/),
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
      return undefined;
    });
    await openIdle(21, { cwd: "/tmp/p" });
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
      return undefined;
    });
    await openIdle(22, { cwd: "/tmp/p" });
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
      return undefined;
    });
    await openIdle(23, { cwd: "/tmp/p" });
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
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
    await openIdle(24, { cwd: "/tmp/p" });
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
    expect(submissionId).toMatch(/^sub-[a-f0-9-]+$/);
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
      if (command === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
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
    await openIdle(25, { cwd: "/tmp/p" });
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
    expect(submissionId).toMatch(/^sub-[a-f0-9-]+$/);
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
    files.clear();
    invokeMock.mockImplementation(async (command: string, args?: { path?: string; content?: string }) => {
      if (command === "fs_read_file") {
        if (!files.has(args!.path!)) throw new Error("no such file");
        return { kind: "text", content: files.get(args!.path!) };
      }
      if (command === "fs_write_file") files.set(args!.path!, args!.content!);
      if (command === "fs_delete") files.delete(args!.path!);
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

  it("fast sends queue distinct records and dispatch in order", async () => {
    await usePiStore.getState().openSession(35, { cwd: "/tmp/p" });
    await Promise.all([
      usePiStore.getState().sendPrompt(35, "Reply FAST_A."),
      usePiStore.getState().sendPrompt(35, "Reply FAST_B."),
    ]);
    expect(sent).toHaveLength(0);
    expect(usePiStore.getState().tabs[35]!.queued?.map((q) => q.text)).toEqual(["Reply FAST_A.", "Reply FAST_B."]);
    lastEvents()('{"type":"agent_end"}');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    lastEvents()('{"type":"response","command":"prompt","success":true}');
    lastEvents()('{"type":"message_start","message":{"role":"user","content":"Reply FAST_A."}}');
    lastEvents()('{"type":"agent_end"}');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(JSON.parse(sent[1])).toEqual({ type: "prompt", message: "Reply FAST_B." });
  });

  it("a refused queued retry stays recoverable and leaves the prompt FIFO", async () => {
    await usePiStore.getState().openSession(36, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(36, "Reply FAST_A.");
    lastEvents()('{"type":"agent_end"}');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    lastEvents()('{"type":"response","command":"prompt","success":false,"error":"refused"}');
    const entry = usePiStore.getState().tabs[36]!;
    expect(entry.queued?.[0]).toMatchObject({ text: "Reply FAST_A.", state: "not-sent" });
    expect(entry.pendingPrompts).toEqual([]);
    expect(entry.rejectedDraft).toBeNull();
    expect(JSON.parse(files.get("/tmp/p/.pi/drafts/36.json")!).queue).toHaveLength(1);
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

/** F1b wire shape: the switch ack carries success and no session id; the
 *  new id arrives on the session file's header, which the store stages. */
const SWITCH_ACK =
  '{"command":"switch_session","data":{"cancelled":false},"id":"9","success":true,"type":"response"}';
const REFUSED_ACK =
  '{"command":"switch_session","error":"a turn is streaming","id":"9","success":false,"type":"response"}';
const CANCELLED_ACK =
  '{"command":"switch_session","data":{"cancelled":true},"id":"9","success":true,"type":"response"}';
const RESTORED_ID = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const RESTORED_PATH =
  "/tmp/p/.pi/sessions/--tmp-p--/2026-06-08T15-07-02-400Z_bbbbbbbb.jsonl";

function historyBlock(
  id: string,
  role: "user" | "assistant",
  text: string,
): PiFeedItem {
  return {
    kind: "message",
    id,
    role,
    parts: [{ type: "text", text }],
    model: role === "assistant" ? "q" : null,
    usage: null,
    streaming: false,
    at: 1000,
  };
}

function stagedSwitch(): PendingSwitch {
  return {
    sessionId: RESTORED_ID,
    blocks: [historyBlock("h-1", "user", "saved prompt"), historyBlock("h-2", "assistant", "saved answer")],
    path: RESTORED_PATH,
    snippet: "...saved prompt...",
  };
}

/** The onEvent of the most recent openSession mock. */
function lastOnEvent(): (line: string) => void {
  const calls = openPiSessionMock.mock.calls;
  const call = calls[calls.length - 1]!;
  return call[0].onEvent as (line: string) => void;
}

describe("piStore session switch (F1b)", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
    aborts.length = 0;
    exits.length = 0;
    invokeMock.mockReset();
    files.clear();
    invokeMock.mockImplementation(async (command: string, args?: { path?: string; content?: string }) => {
      if (command === "fs_read_file") {
        if (!files.has(args!.path!)) throw new Error("no such file");
        return { kind: "text", content: files.get(args!.path!) };
      }
      if (command === "fs_write_file") files.set(args!.path!, args!.content!);
      if (command === "fs_delete") files.delete(args!.path!);
      return ".pi/attachments/0-0.png";
    });
  });

  it("stages the parsed history, keeps the transcript, then commits both on the ack", async () => {
    await usePiStore.getState().openSession(40, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(40, "hello");
    const before = usePiStore.getState().tabs[40]!.state;
    await usePiStore.getState().switchToSession(40, stagedSwitch());
    // pi has the command, the old transcript is still on screen.
    expect(sent[sent.length - 1]).toBe(
      JSON.stringify({ type: "switch_session", sessionPath: RESTORED_PATH }),
    );
    expect(usePiStore.getState().tabs[40]!.state.sessionId).toBe(
      before.sessionId,
    );
    expect(usePiStore.getState().tabs[40]!.pendingSwitch?.path).toBe(
      RESTORED_PATH,
    );
    lastOnEvent()(SWITCH_ACK);
    const entry = usePiStore.getState().tabs[40]!;
    expect(entry.state.sessionId).toBe(RESTORED_ID);
    expect(entry.state.blocks).toHaveLength(2);
    expect(entry.state.switching).toBe(false);
    expect(entry.sessionPath).toBe(RESTORED_PATH);
    expect(entry.pendingSwitch).toBeNull();
    expect(entry.scrollRequest).toMatchObject({ snippet: "...saved prompt..." });
    expect(entry.switchError).toBeNull();
  });

  it("a committed switch totals the restored usage for the strip", async () => {
    await usePiStore.getState().openSession(41, { cwd: "/tmp/p" });
    const request = stagedSwitch();
    const usageBlock: PiFeedItem = {
      kind: "message",
      id: "h-3",
      role: "assistant",
      parts: [{ type: "text", text: "second answer" }],
      model: "q",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        costTotal: 0.004,
      },
      streaming: false,
      at: 1000,
    };
    request.blocks = [...request.blocks, usageBlock];
    await usePiStore.getState().switchToSession(41, request);
    lastOnEvent()(SWITCH_ACK);
    const state = usePiStore.getState().tabs[41]!.state;
    expect(state.turnTokens).toBe(12);
    expect(state.sessionCost).toBeCloseTo(0.004, 6);
    expect(state.turnUsage?.totalTokens).toBe(12);
  });

  it("a refused switch keeps the conversation and names the file", async () => {
    await usePiStore.getState().openSession(42, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(42, "hello");
    const before = usePiStore.getState().tabs[42]!.state;
    await usePiStore.getState().switchToSession(42, stagedSwitch());
    lastOnEvent()(REFUSED_ACK);
    const entry = usePiStore.getState().tabs[42]!;
    expect(entry.state.sessionId).toBe("abcd1234-test");
    expect(entry.state.blocks).toEqual(before.blocks);
    expect(entry.pendingSwitch).toBeNull();
    expect(entry.scrollRequest).toBeNull();
    expect(entry.switchError).toBe(`${RESTORED_PATH}: a turn is streaming`);
  });

  it("a vetoed switch (extension cancelled) keeps the conversation too", async () => {
    await usePiStore.getState().openSession(43, { cwd: "/tmp/p" });
    await usePiStore.getState().switchToSession(43, stagedSwitch());
    lastOnEvent()(CANCELLED_ACK);
    const entry = usePiStore.getState().tabs[43]!;
    expect(entry.state.sessionId).toBe("abcd1234-test");
    expect(entry.switchError).toBe(`${RESTORED_PATH}: switch cancelled`);
  });

  it("a failed switch write unstages and reports the file", async () => {
    usePiStore.setState({
      tabs: {
        44: {
          gen: 1,
          state: { ...initialPiSessionState(), sessionId: "abcd1234-test" },
          session: {
            id: 9,
            send: vi.fn().mockRejectedValue(new Error("pipe gone")),
            kill: vi.fn().mockResolvedValue(undefined),
          },
          exited: false,
          exitCode: null,
          error: null,
          roles: { provider: "omlx", model: "q", smol: "" },
        },
      },
    });
    await expect(
      usePiStore.getState().switchToSession(44, stagedSwitch()),
    ).rejects.toThrow("pipe gone");
    const entry = usePiStore.getState().tabs[44]!;
    expect(entry.pendingSwitch).toBeNull();
    expect(entry.switchError).toBe(`${RESTORED_PATH}: pipe gone`);
    expect(entry.state.blocks).toHaveLength(0);
  });

  it("a second switch while one is staged is refused", async () => {
    await usePiStore.getState().openSession(45, { cwd: "/tmp/p" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    openPiSessionMock.mockImplementationOnce(async (opts: { onEvent: (l: string) => void; onExit?: (c: number) => void }) => {
      exits.push(opts.onExit ?? (() => {}));
      return {
        id: 8,
        send: () => gate,
        abort: async () => {},
        kill: async () => opts.onExit?.(0),
      };
    });
    await usePiStore.getState().openSession(45, { cwd: "/tmp/p" });
    const pending = usePiStore.getState().switchToSession(45, stagedSwitch());
    await expect(
      usePiStore.getState().switchToSession(45, stagedSwitch()),
    ).rejects.toThrow("switch_session already in progress");
    release();
    await pending;
    lastOnEvent()(SWITCH_ACK);
    expect(usePiStore.getState().tabs[45]!.state.sessionId).toBe(RESTORED_ID);
  });

  it("an ack with nothing staged never clears the conversation", async () => {
    await usePiStore.getState().openSession(46, { cwd: "/tmp/p" });
    await usePiStore.getState().sendPrompt(46, "hello");
    const before = usePiStore.getState().tabs[46]!.state;
    lastOnEvent()(SWITCH_ACK);
    const entry = usePiStore.getState().tabs[46]!;
    expect(entry.state.sessionId).toBe(before.sessionId);
    expect(entry.state.blocks).toEqual(before.blocks);
    expect(entry.switchError).toBeNull();
    expect(entry.scrollRequest).toBeNull();
  });

  it("clearScrollRequest clears only its own seq", async () => {
    await usePiStore.getState().openSession(47, { cwd: "/tmp/p" });
    await usePiStore.getState().switchToSession(47, stagedSwitch());
    lastOnEvent()(SWITCH_ACK);
    const entry = usePiStore.getState().tabs[47]!;
    const seq = entry.scrollRequest!.seq;
    usePiStore.getState().clearScrollRequest(47, seq + 1);
    expect(usePiStore.getState().tabs[47]!.scrollRequest?.seq).toBe(seq);
    usePiStore.getState().clearScrollRequest(47, seq);
    expect(usePiStore.getState().tabs[47]!.scrollRequest).toBeNull();
  });
});


describe("G2 launch and locator commit", () => {
  beforeEach(() => {
    usePiStore.setState({ tabs: {} });
    sent.length = 0;
    invokeMock.mockReset();
  });
  it("paints saved history and identity before pi opens, then switches and records the locator", async () => {
    const file = [JSON.stringify({ type: "session", id: RESTORED_ID }), JSON.stringify({ type: "message", message: { role: "user", content: "saved prompt" } })].join("\n");
    const queued = { id: "saved-queue", text: "pending prompt", attachmentIds: [], submittedAt: "2026-09-09T00:00:00Z" };
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== "fs_read_file") return;
      if (args.path.endsWith("/71.md")) throw new Error("no such file");
      if (args.path.endsWith("/71.json")) return { kind: "text", content: JSON.stringify({ v: 1, submissionId: null, sources: [], attachments: [], queue: [queued] }) };
      return { kind: "text", content: args.path.endsWith("session-manifest.json") ? JSON.stringify({ v: 1, lastSessionId: RESTORED_ID, sessions: [{ id: RESTORED_ID, path: RESTORED_PATH.slice("/tmp/p/".length) }] }) : file };
    });
    let release!: (handle: { id: number; send: (line: string) => Promise<void>; kill: () => Promise<void> }) => void;
    openPiSessionMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const opening = usePiStore.getState().openSession(71, { cwd: "/tmp/p" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(usePiStore.getState().tabs[71]!.session).toBeNull();
    expect(usePiStore.getState().tabs[71]!.state.sessionId).toBe(RESTORED_ID);
    expect(usePiStore.getState().tabs[71]!.state.blocks).toHaveLength(1);
    expect(usePiStore.getState().tabs[71]!.queued).toMatchObject([{ ...queued, state: "not-sent" }]);
    expect(usePiStore.getState().tabs[71]!.queued![0].autoSend).toBeFalsy();
    lastOnEvent()('{"type":"agent_start","sessionId":"new-unwanted-id"}');
    expect(usePiStore.getState().tabs[71]!.state.sessionId).toBe(RESTORED_ID);
    release({ id: 71, send: async (line) => { sent.push(line); }, kill: async () => {} });
    await opening;
    expect(JSON.parse(sent[0]!)).toEqual({ type: "switch_session", sessionPath: RESTORED_PATH });
    lastOnEvent()(SWITCH_ACK);
    await vi.waitFor(() => expect(usePiStore.getState().tabs[71]!.locatorPending).toBe(false));
    expect(invokeMock).toHaveBeenCalledWith("pi_record_session_switch", expect.objectContaining({ cwd: "/tmp/p", sessionId: RESTORED_ID, path: RESTORED_PATH }));
    expect(usePiStore.getState().tabs[71]!.queued).toMatchObject([{ ...queued, state: "not-sent" }]);
    expect(usePiStore.getState().tabs[71]!.queued![0].autoSend).toBeFalsy();
    expect(sent).toHaveLength(1);
  });
  it("keeps a named recovery error and session list instead of opening an empty pi session", async () => {
    const previousCalls = openPiSessionMock.mock.calls.length;
    invokeMock.mockImplementation(async (_cmd, args) => {
      if (args.path.endsWith("session-manifest.json")) return { kind: "text", content: JSON.stringify({ v: 1, lastSessionId: "lost", sessions: [{ id: "lost", path: ".pi/sessions/missing.jsonl" }, { id: "saved", path: ".pi/sessions/other.jsonl" }] }) };
      throw new Error("Permission denied");
    });
    await usePiStore.getState().openSession(72, { cwd: "/tmp/p" });
    expect(usePiStore.getState().tabs[72]!.error).toContain("Session recovery failed: /tmp/p/.pi/sessions/missing.jsonl");
    expect(usePiStore.getState().tabs[72]!.error).toContain("saved (.pi/sessions/other.jsonl)");
    expect(openPiSessionMock.mock.calls.length).toBe(previousCalls);
  });
  it("reports a failed locator write after pi accepts the switch", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "fs_read_file") return { kind: "text", content: '{"v":1,"lastSessionId":null,"sessions":[]}' };
      if (cmd === "pi_record_session_switch") throw new Error("read-only file system");
    });
    await usePiStore.getState().openSession(73, { cwd: "/tmp/p" });
    await usePiStore.getState().switchToSession(73, stagedSwitch());
    expect(invokeMock.mock.calls.some((call) => call[0] === "pi_record_session_switch")).toBe(false);
    lastOnEvent()(SWITCH_ACK);
    await vi.waitFor(() => expect(usePiStore.getState().tabs[73]!.switchError).toContain("/tmp/p/.pi/session-manifest.json"));
    expect(usePiStore.getState().tabs[73]!.state.sessionId).toBe(RESTORED_ID);
  });
});
