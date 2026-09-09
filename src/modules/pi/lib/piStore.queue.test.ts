import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/pi/lib/rpc-client", () => ({ openPiSession: open }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));

import { usePiStore, type ComposerImage } from "@/modules/pi/lib/piStore";
import { registerStableId, resetStableIdsForTests } from "@/modules/tabs/lib/sid";
import { clearDraft, emptyChatMeta, saveDraftMeta, type ChatDraftMeta } from "@/modules/pi/lib/drafts";

const cwd = "/project";
const metaPath = `${cwd}/.pi/drafts/stable-tab.json`;
const mdPath = `${cwd}/.pi/drafts/stable-tab.md`;
const files = new Map<string, string>();
const send = vi.fn();
let receive: (line: string) => void;
let exit: (code: number) => void;
let holdWrite: (() => Promise<void>) | null;
const meta = () => JSON.parse(files.get(metaPath)!) as ChatDraftMeta;
const entry = () => usePiStore.getState().tabs[71]!;
const emit = (event: object) => receive(JSON.stringify(event));
const start = () => emit({ type: "agent_start", sessionId: "session-a" });
const fail = () => emit({ type: "agent_end", error: "connection refused" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const chip: ComposerImage = { attachmentId: "att-8", draftPath: ".pi/drafts/stable-tab-att-8.png", sha256: "abcd", mediaType: "image/png", data: "Ynl0ZXM=" };

beforeEach(async () => {
  vi.clearAllMocks();
  usePiStore.setState({ tabs: {} });
  registerStableId(71, "stable-tab");
  files.clear();
  holdWrite = null;
  send.mockResolvedValue(undefined);
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const path = args.path as string;
    if (command === "fs_read_file") {
      if (!files.has(path)) throw new Error("no such file");
      return { kind: "text", content: files.get(path) };
    }
    if (command === "fs_write_file") {
      if (path === metaPath) await holdWrite?.();
      files.set(path, args.content as string);
    }
    if (command === "fs_delete") files.delete(path);
    if (command === "fs_read_file_bytes") {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return { base64: files.get(path) };
    }
    if (command === "pi_stage_submission") return (args.attachments as { attachmentId: string }[]).map((a) => ({
      attachmentId: a.attachmentId, path: `.pi/attachments/${args.submissionId}-${a.attachmentId}.png`, sha256: "abcd",
    }));
    return undefined;
  });
  open.mockImplementation(async (opts: { onEvent: typeof receive; onExit: typeof exit }) => {
    receive = opts.onEvent;
    exit = opts.onExit;
    return { id: 1, send, abort: vi.fn(), kill: vi.fn() };
  });
  await usePiStore.getState().openSession(71, { cwd });
});

afterEach(async () => { await settle(); resetStableIdsForTests(); });

describe("G1 durable queue", () => {
  it("does not acknowledge submission or clear the draft before its queue write finishes", async () => {
    files.set(mdPath, "second prompt");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    holdWrite = () => held;
    start();
    let cleared = false;
    const pending = usePiStore.getState().sendPrompt(71, "second prompt").then(() => { cleared = true; });
    await settle();
    expect(cleared).toBe(false);
    expect(entry().queued).toEqual([]);
    expect(files.get(mdPath)).toBe("second prompt");
    release();
    await pending;
    expect(meta().queue).toEqual([{ id: entry().queued![0].id, text: "second prompt", attachmentIds: [], submittedAt: expect.any(String) }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a failed queue write with its path and preserves the composer draft", async () => {
    files.set(mdPath, "keep this");
    holdWrite = async () => { throw new Error("disk full"); };
    start();
    await expect(usePiStore.getState().sendPrompt(71, "keep this")).rejects.toThrow(metaPath);
    expect(entry().queueError).toContain("disk full");
    expect(entry().queued).toEqual([]);
    expect(files.get(mdPath)).toBe("keep this");
    expect(send).not.toHaveBeenCalled();
  });

  it("Cancel removes only its record, even when two prompts have identical text", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "same");
    await usePiStore.getState().sendPrompt(71, "same");
    const [a, b] = entry().queued!;
    files.set(mdPath, "new draft");
    await usePiStore.getState().cancelQueued(71, a.id);
    expect(a.id).not.toBe(b.id);
    expect(entry().queued?.map((q) => q.id)).toEqual([b.id]);
    expect(meta().queue?.map((q) => q.id)).toEqual([b.id]);
    expect(files.get(mdPath)).toBe("new draft");
    expect(send).not.toHaveBeenCalled();
  });

  it("Edit persists text and chips as a composer draft before removing the queue entry", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "with image", [chip]);
    files.set(mdPath, "typed meanwhile");
    await usePiStore.getState().editQueued(71, entry().queued![0].id);
    expect(files.get(mdPath)).toBe("typed meanwhile\n\nwith image");
    expect(meta().queue).toEqual([]);
    expect(meta().attachments[0]).toMatchObject({ id: "att-8", state: "draft", path: chip.draftPath });
    expect(entry().rejectedDraft).toMatchObject({ text: "with image", images: [chip], queueReturn: true, records: [{ attachmentId: "att-8", draftPath: chip.draftPath }] });
    expect(entry().queued).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a queue entry actionable when its Cancel write fails", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "keep");
    const original = files.get(metaPath);
    holdWrite = async () => { throw new Error("read-only"); };
    await expect(usePiStore.getState().cancelQueued(71, entry().queued![0].id)).rejects.toThrow(metaPath);
    expect(entry().queued).toHaveLength(1);
    expect(entry().queueBusy).toBeNull();
    expect(files.get(metaPath)).toBe(original);
  });

  it("Retry waits for idle, sends a normal prompt, and removes only its acknowledged record", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "/expanded", [chip]);
    await usePiStore.getState().sendPrompt(71, "another");
    const id = entry().queued![0].id;
    await usePiStore.getState().retryQueued(71, id);
    expect(send).not.toHaveBeenCalled();
    fail();
    await usePiStore.getState().retryQueued(71, id);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ type: "prompt", message: "/expanded" });
    expect(JSON.parse(send.mock.calls[0][0]).streamingBehavior).toBeUndefined();
    expect(meta().queue).toHaveLength(2);
    emit({ type: "response", command: "prompt", success: true });
    expect(meta().queue).toHaveLength(2);
    emit({ type: "message_start", message: { role: "user", content: "expanded template text" } });
    await settle();
    expect(meta().queue?.map((q) => q.text)).toEqual(["another"]);
    expect(entry().queued?.map((q) => q.text)).toEqual(["another"]);
    expect(invoke).toHaveBeenCalledWith("pi_record_attachment_binding", expect.objectContaining({ turnId: expect.any(String) }));
  });

  it("keeps a failed Retry on disk without returning or rebinding it to another prompt", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "retry me", [chip]);
    fail();
    send.mockRejectedValueOnce(new Error("stdin closed"));
    await expect(usePiStore.getState().retryQueued(71, entry().queued![0].id)).rejects.toThrow("stdin closed");
    expect(entry().queued?.[0].state).toBe("not-sent");
    expect(entry().pendingPrompts).toEqual([]);
    expect(entry().pendingAttachments).toEqual([]);
    expect(entry().rejectedDraft).toBeNull();
    expect(meta().queue).toHaveLength(1);
  });

  it.each(["abort", "exit", "failure"])("retains queued work after %s and restores the same ids after a restart", async (ending) => {
    files.set(`${cwd}/${chip.draftPath}`, chip.data);
    start();
    await usePiStore.getState().sendPrompt(71, "survive", [chip]);
    const id = entry().queued![0].id;
    if (ending === "abort") {
      await usePiStore.getState().cancelTurn(71);
      emit({ type: "response", command: "abort", success: true });
      emit({ type: "agent_end", error: "Aborted" });
    } else if (ending === "exit") exit(9);
    else fail();
    expect(entry().queued?.[0]).toMatchObject({ id, state: "not-sent" });
    expect(send).not.toHaveBeenCalled();
    usePiStore.getState().close(71);
    await usePiStore.getState().openSession(71, { cwd });
    expect(entry().queued?.[0]).toMatchObject({ id, text: "survive", state: "not-sent", images: [chip] });
    expect(send).not.toHaveBeenCalled();
  });

  it("finishes retries successfully before dispatching the pending prompt", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "next");
    fail();
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "temporary" });
    expect(send).not.toHaveBeenCalled();
    emit({ type: "auto_retry_end", attempt: 1, success: true });
    emit({ type: "agent_end" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send a failed turn's leftovers when an unrelated new turn finishes", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "old queue");
    fail();
    emit({ type: "auto_retry_end", attempt: 3, success: false, finalError: "offline" });
    await usePiStore.getState().sendPrompt(71, "new normal prompt");
    emit({ type: "message_start", message: { role: "user", content: "new normal prompt" } });
    emit({ type: "agent_end" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(entry().queued?.[0]).toMatchObject({ text: "old queue", state: "not-sent" });
  });

  it("preserves queued attachments against composer metadata and clear writes", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "keep image", [chip]);
    await Promise.all([saveDraftMeta(cwd, "stable-tab", emptyChatMeta()), clearDraft(cwd, "stable-tab")]);
    expect(meta().queue).toHaveLength(1);
    expect(meta().attachments[0].id).toBe("att-8");
    expect(entry().queued).toHaveLength(1);
  });

  it("reserves a fast first send before transport completion so the next send persists in the queue", async () => {
    let release!: () => void;
    send.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = usePiStore.getState().sendPrompt(71, "first");
    await usePiStore.getState().sendPrompt(71, "second");
    expect(send).toHaveBeenCalledTimes(1);
    expect(entry().pendingPrompts).toHaveLength(1);
    expect(meta().queue?.[0].text).toBe("second");
    emit({ type: "response", command: "prompt", success: true });
    expect(entry().pendingPrompts).toEqual([]);
    expect(entry().queued).toHaveLength(1);
    release();
    await first;
  });

  it("retains missing image references on recovery for Edit or Cancel", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "missing", [chip]);
    await usePiStore.getState().openSession(71, { cwd });
    expect(entry().queued?.[0].images[0].data).toBe("");
    await expect(usePiStore.getState().retryQueued(71, entry().queued![0].id)).rejects.toThrow("Attachment file is missing");
    expect(meta().queue).toHaveLength(1);
    await usePiStore.getState().editQueued(71, entry().queued![0].id);
    expect(entry().rejectedDraft?.records?.[0].draftPath).toBe(chip.draftPath);
  });

  it("ignores a superseded process's events and does not erase recovered entries", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "survive switch");
    const oldReceive = receive;
    await usePiStore.getState().openSession(71, { cwd });
    oldReceive('{"type":"message_start","message":{"role":"user","content":"wrong session"}}');
    expect(entry().state.blocks).toEqual([]);
    expect(entry().queued?.[0].state).toBe("not-sent");
  });

  it("does not dispatch a queue write that completes after Stop has settled", async () => {
    start();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    holdWrite = () => held;
    const writing = usePiStore.getState().sendPrompt(71, "pending disk write");
    await settle();
    await usePiStore.getState().cancelTurn(71);
    emit({ type: "response", command: "abort", success: true });
    emit({ type: "agent_end" });
    release();
    await writing;
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(entry().queued?.[0]).toMatchObject({ state: "not-sent", autoSend: false });
    expect(meta().queue?.[0].text).toBe("pending disk write");
  });

  it("discards the queue on disk while preserving unrelated composer text and images", async () => {
    start();
    await usePiStore.getState().sendPrompt(71, "queued", [chip]);
    files.set(mdPath, "typed meanwhile");
    await saveDraftMeta(cwd, "stable-tab", { ...emptyChatMeta(), attachments: [{
      id: "composer-image", path: ".pi/drafts/composer-image.png", sha256: "efgh", mime: "image/png", state: "draft",
    }] });
    await usePiStore.getState().discardQueued(71);
    expect(meta().queue).toEqual([]);
    expect(meta().attachments.map((a) => a.id)).toEqual(["composer-image"]);
    expect(files.get(mdPath)).toBe("typed meanwhile");
    await usePiStore.getState().openSession(71, { cwd });
    expect(entry().queued).toEqual([]);
  });


  it("keeps FIFO order when the earlier queued prompt has a slow image write", async () => {
    start();
    const fs = invoke.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "pi_save_draft_attachment") {
        await held;
        return { path: ".pi/drafts/slow.png", sha256: "abc" };
      }
      return fs(command, args);
    });
    const first = usePiStore.getState().sendPrompt(71, "image first", [{ mediaType: "image/png", data: "YQ==" }]);
    const second = usePiStore.getState().sendPrompt(71, "text second");
    await settle();
    expect(entry().queued).toHaveLength(0);
    release();
    await Promise.all([first, second]);
    expect(meta().queue?.map((q) => q.text)).toEqual(["image first", "text second"]);
    expect(entry().queued?.map((q) => q.text)).toEqual(["image first", "text second"]);
  });

  it("propagates a refusal received before transport completion so the composer keeps its text", async () => {
    send.mockImplementationOnce(async () => emit({ type: "response", command: "prompt", success: false, error: "refused now" }));
    await expect(usePiStore.getState().sendPrompt(71, "keep draft")).rejects.toThrow("refused now");
    expect(entry().rejectedDraft?.text).toBe("keep draft");
    expect(entry().pendingPrompts).toEqual([]);
    expect(entry().pendingAttachments).toEqual([]);
  });

});
