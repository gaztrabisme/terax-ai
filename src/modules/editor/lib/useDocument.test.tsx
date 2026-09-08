// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { sha256Hex } from "@/modules/pi/lib/drafts";
import { useDocument } from "./useDocument";

const PATH = "/w/src/a.ts";
const DISK = "saved content\n";
const BUFFER = "saved content\nplus an unsaved line\n";

function memoryFs() {
  const files = new Map<string, string>([[PATH, DISK]]);
  invoke.mockImplementation(
    async (cmd: string, args?: { path?: string; content?: string }) => {
      const path = args?.path ?? "";
      if (cmd === "fs_read_file") {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return { kind: "text", content: files.get(path), size: 12 };
      }
      if (cmd === "fs_write_file") {
        files.set(path, args?.content ?? "");
        return undefined;
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  );
  return files;
}

function writesTo(path: string) {
  return invoke.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "fs_write_file" && (args as { path?: string })?.path === path,
  );
}

beforeEach(() => {
  invoke.mockReset();
});

describe("useDocument without drafts", () => {
  it("loads the file and saves edits straight through", async () => {
    const files = memoryFs();
    const { result } = renderHook(() => useDocument({ path: PATH }));
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    expect(
      result.current.doc.status === "ready" && result.current.doc.content,
    ).toBe(DISK);
    expect(result.current.dirty).toBe(false);

    act(() => result.current.onChange(BUFFER));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(writesTo(PATH)).toHaveLength(1);
    expect(files.get(PATH)).toBe(BUFFER);
    expect(result.current.dirty).toBe(false);
  });
});

describe("useDocument with the K11c draft hooks", () => {
  it("opens with the recovered buffer, marked dirty and recovered", async () => {
    memoryFs();
    const recover = vi.fn(async (disk: string) =>
      disk === DISK
        ? { content: BUFFER, baseSha256: await sha256Hex(DISK), draftId: "old" }
        : null,
    );
    const { result } = renderHook(() =>
      useDocument({ path: PATH, recover }),
    );
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    expect(recover).toHaveBeenCalledWith(DISK);
    expect(
      result.current.doc.status === "ready" && result.current.doc.recovered,
    ).toBe(true);
    expect(
      result.current.doc.status === "ready" && result.current.doc.content,
    ).toBe(BUFFER);
    // The buffer differs from the disk text: it is unsaved.
    expect(result.current.dirty).toBe(true);
    // Refusal-free write gate never fired; the file still holds the disk text.
    expect(writesTo(PATH)).toHaveLength(0);
  });

  it("beforeWrite refusing keeps the buffer dirty and writes nothing", async () => {
    memoryFs();
    const beforeWrite = vi.fn(async () => false);
    const onWritten = vi.fn();
    const { result } = renderHook(() =>
      useDocument({ path: PATH, beforeWrite, onWritten }),
    );
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    act(() => result.current.onChange(BUFFER));

    let saved = false;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe(false);
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(writesTo(PATH)).toHaveLength(0);
    expect(onWritten).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(true);
  });

  it("beforeWrite passing writes the buffer and fires onWritten", async () => {
    const files = memoryFs();
    const beforeWrite = vi.fn(async () => true);
    const onWritten = vi.fn();
    const { result } = renderHook(() =>
      useDocument({ path: PATH, beforeWrite, onWritten }),
    );
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    act(() => result.current.onChange(BUFFER));

    let saved = false;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe(true);
    expect(writesTo(PATH)).toHaveLength(1);
    expect(files.get(PATH)).toBe(BUFFER);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(result.current.dirty).toBe(false);
  });

  it("reload skips while dirty and refreshes when clean", async () => {
    const files = memoryFs();
    const { result } = renderHook(() =>
      useDocument({ path: PATH, beforeWrite: async () => true }),
    );
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    act(() => result.current.onChange(BUFFER));
    expect(result.current.reload()).toBe(false);

    await act(async () => {
      await result.current.save();
    });
    files.set(PATH, "changed externally\n");
    expect(result.current.reload()).toBe(true);
    await waitFor(() => {
      expect(
        result.current.doc.status === "ready" && result.current.doc.content,
      ).toBe("changed externally\n");
    });
  });
});
