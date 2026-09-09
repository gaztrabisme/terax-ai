// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const { invoke, retain, replace } = vi.hoisted(() => ({ invoke: vi.fn(), retain: vi.fn().mockResolvedValue(undefined), replace: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("@/modules/editor/lib/vim", () => ({ initVimGlobals: () => {}, vimHandlersExtension: () => [] }));
vi.mock("@/modules/editor/lib/languageResolver", () => ({ resolveLanguage: async () => [] }));
vi.mock("@uiw/react-codemirror", () => ({ default: () => <textarea aria-label="Editor input" defaultValue="buffer version" /> }));
vi.mock("@/modules/editor/lib/useDocument", () => ({ useDocument: () => ({
  doc: { status: "ready", content: "buffer version", size: 14 }, onChange: vi.fn(), save: vi.fn(), reload: vi.fn(), replaceFromDisk: replace, getBuffer: () => "buffer version",
}) }));
vi.mock("@/modules/editor/lib/editorDraft", async (original) => ({
  ...await original<typeof import("@/modules/editor/lib/editorDraft")>(),
  createEditorDraftController: ({ onState }: { onState: (state: unknown) => void }) => {
    queueMicrotask(() => onState({ recovered: true, conflict: { path: "/proj/answer.md", draftPath: "/proj/.pi/drafts/kept.md" } }));
    return { stop: vi.fn(), onClean: vi.fn(), retainForReload: retain };
  },
}));
import { EditorPane } from "@/modules/editor/EditorPane";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("compares read-only disk text, writes a copy, and guards reload with the retained draft path", async () => {
  invoke.mockImplementation(async (cmd: string) => cmd === "fs_read_file" ? { kind: "text", content: "disk version" } : undefined);
  const opened = vi.fn();
  window.addEventListener("pi:open-file", opened);
  const view = render(<EditorPane path="/proj/answer.md" sid="editor1" projectCwd="/proj" />);
  fireEvent.click(await view.findByRole("button", { name: "Compare with disk" }));
  await waitFor(() => expect(view.getByRole("region", { name: "Disk version (read only)" }).textContent).toContain("disk version"));
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("buffer version");
  fireEvent.click(view.getByRole("button", { name: "Save a copy" }));
  await waitFor(() => expect(opened).toHaveBeenCalledOnce());
  expect(invoke.mock.calls.find(([cmd]) => cmd === "fs_write_file")?.[1]).toMatchObject({ content: "buffer version" });
  fireEvent.click(view.getByRole("button", { name: "Reload from disk" }));
  expect(view.getByRole("alertdialog").textContent).toContain("/proj/.pi/drafts/kept.md");
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Keep editing" }));
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Reload from disk" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm reload" }));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("disk version"));
  expect(retain).toHaveBeenCalledWith("buffer version", "disk version");
  window.removeEventListener("pi:open-file", opened);
});
