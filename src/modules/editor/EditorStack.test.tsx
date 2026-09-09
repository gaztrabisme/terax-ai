// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));

import { sha256Hex } from "@/modules/pi/lib/drafts";
import { EditorStack } from "./EditorStack";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("mounts real CodeMirror at the selected answer path, restores its buffer, and saves that file", async () => {
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
  const path = "/proj/.pi/answers/answer.md";
  const files = new Map([
    [path, "# Saved answer\n"],
    ["/proj/.pi/drafts/editor-saved.md", "# Unsaved answer\n"],
    ["/proj/.pi/drafts/editor-saved.json", JSON.stringify({
      v: 1, kind: "editor", path, baseSha256: await sha256Hex("# Saved answer\n"),
    })],
  ]);
  invoke.mockImplementation(async (cmd: string, args: { path: string; content?: string }) => {
    if (cmd === "fs_read_file") {
      if (!files.has(args.path)) throw new Error(`no such file: ${args.path}`);
      return { kind: "text", content: files.get(args.path), size: files.get(args.path)!.length };
    }
    if (cmd === "fs_write_file") files.set(args.path, args.content!);
    if (cmd === "fs_delete") files.delete(args.path);
  });
  const view = render(<EditorStack tabs={[
    { id: 1, sid: "chat-saved", kind: "pi", cwd: "/proj", title: "pi" },
    { id: 2, sid: "editor-saved", kind: "editor", cwd: "/proj", title: "answer.md", path, dirty: false, preview: false },
  ]} activeId={2} registerHandle={() => {}} onDirtyChange={() => {}}
    onCloseTab={() => {}} onReturnToChat={() => {}} />);
  const input = await view.findByLabelText("Editor input");
  expect(input.textContent).toBe("# Unsaved answer");
  expect(view.getByText("Unsaved, recovered")).toBeTruthy();
  const editor = EditorView.findFromDOM(input)!;
  act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "More text\n" } }));
  fireEvent.keyDown(input, { key: "s", code: "KeyS", ctrlKey: true });
  await waitFor(() => expect(files.get(path)).toBe("# Unsaved answer\nMore text\n"));
  expect(view.queryByRole("alert")).toBeNull();
});
