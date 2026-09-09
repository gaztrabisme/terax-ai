// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({ disposeSession: vi.fn() }));
vi.mock("@/modules/editor/lib/vim", () => ({ initVimGlobals: () => {}, vimHandlersExtension: () => [] }));
vi.mock("@/modules/editor/lib/languageResolver", () => ({ resolveLanguage: async () => [] }));
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="Editor input" value={value} readOnly />,
}));

import { EditorStack } from "@/modules/editor/EditorStack";
import { Composer } from "@/modules/pi/components/Composer";
import { emptyChatMeta, sha256Hex } from "@/modules/pi/lib/drafts";
import { defaultUiState, resetUiStateForTests, useUiStateStore } from "@/modules/state/uiState";
import { RecoverableDrafts } from "./RecoverableDrafts";
import { resetStableIdsForTests, stableIdOf } from "./lib/sid";
import { useTabs } from "./lib/useTabs";

const cwd = "/proj";
const chatSid = "chat-saved";
const imagePath = ".pi/drafts/chat-saved-image.png";
const imageData = "iVBORw0KGgo=";
const quote = "Keep this draft.\n\n```text\n$ echo quartz\nquartz\n```\n";
let files: Map<string, string>;
let denied: Set<string>;

function seedChat(sid: string, text: string, images = false) {
  files.set(`${cwd}/.pi/drafts/${sid}.md`, text);
  const meta = {
    ...emptyChatMeta(),
    attachments: images ? [{ id: "image-saved", path: imagePath, sha256: createHash("sha256").update(Buffer.from(imageData, "base64")).digest("hex"), mime: "image/png", state: "draft" }] : [],
    sources: [{ blockId: 3, terminalId: 2, sha256: "terminal-hash", insertedAt: "2026-09-09T00:00:00Z" }],
  };
  files.set(`${cwd}/.pi/drafts/${sid}.json`, JSON.stringify(meta));
  if (images) files.set(`${cwd}/${imagePath}`, imageData);
}

function seedWindow() {
  files.set(`${cwd}/.pi/ui-state.json`, JSON.stringify({
    ...defaultUiState(),
    windows: { main: { tabs: [{ id: chatSid, kind: "pi", cwd, sessionId: "session-saved" }], activeTabId: chatSid } },
  }));
}

function Project() {
  const tabs = useTabs();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void tabs.restoreProjectTabs(cwd).catch((reason) => setError(String(reason))); }, [tabs.restoreProjectTabs]);
  return <>
    <header>Project navigation</header>
    {error && <p role="alert">{error}</p>}
    {tabs.tabs.filter((tab) => tab.kind === "pi").map((tab) => (
      <section key={tab.id} data-sid={tab.sid} data-active={tabs.activeId === tab.id}>
        <RecoverableDrafts cwd={cwd} openDraftIds={tabs.tabs.flatMap((open) => open.sid ? [open.sid] : [])} onRecoverDraft={tabs.recoverDraft} />
        <Composer tabId={tab.id} cwd={cwd} onSubmit={vi.fn()} />
      </section>
    ))}
    <EditorStack tabs={tabs.tabs} activeId={tabs.activeId} registerHandle={() => {}} onDirtyChange={() => {}}
      onCloseTab={tabs.closeTab} onReturnToChat={tabs.returnToChat} />
  </>;
}

beforeEach(() => {
  resetStableIdsForTests();
  resetUiStateForTests();
  vi.stubGlobal("crypto", webcrypto);
  files = new Map();
  denied = new Set();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { path?: string; content?: string }) => {
    const path = args?.path ?? "";
    if (denied.has(path)) throw new Error(`Permission denied: ${path}`);
    if (cmd === "fs_read_file" || cmd === "fs_read_file_bytes") {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return cmd === "fs_read_file" ? { kind: "text", content: files.get(path), size: files.get(path)!.length } : { base64: files.get(path) };
    }
    if (cmd === "fs_stat") {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return { kind: "file", size: 1, mtime: 0 };
    }
    if (cmd === "fs_write_file") { files.set(path, args?.content ?? ""); return; }
    if (cmd === "fs_delete") { files.delete(path); return; }
    if (cmd === "fs_read_dir") return [...files.keys()]
      .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map((file) => ({ name: file.slice(path.length + 1), kind: "file" }));
    if (cmd === "fs_create_dir") return;
    return {};
  });
});

afterEach(() => {
  cleanup();
  resetUiStateForTests();
  resetStableIdsForTests();
  vi.unstubAllGlobals();
});

it("reuses chat and editor sids from the written window across a simulated relaunch", async () => {
  const first = renderHook(() => useTabs());
  await act(async () => first.result.current.restoreProjectTabs(cwd));
  act(() => first.result.current.openFileTab(`${cwd}/answer.md`));
  const chat = first.result.current.tabs.find((tab) => tab.kind === "pi")!;
  const editor = first.result.current.tabs.find((tab) => tab.kind === "editor")!;
  expect(first.result.current.activeId).toBe(editor.id);
  seedChat(chat.sid!, quote);
  files.set(`${cwd}/answer.md`, "saved\n");
  files.set(`${cwd}/.pi/drafts/${editor.sid}.md`, "unsaved buffer\n");
  files.set(`${cwd}/.pi/drafts/${editor.sid}.json`, JSON.stringify({ v: 1, kind: "editor", path: `${cwd}/answer.md`, baseSha256: await sha256Hex("saved\n") }));
  await act(async () => useUiStateStore.getState().retry());
  first.unmount();
  resetStableIdsForTests();
  resetUiStateForTests();

  const view = render(<Project />);
  await waitFor(() => expect(view.container.querySelector(`[data-sid="${chat.sid}"]`)?.textContent).toContain("Keep this draft."));
  expect(stableIdOf(3)).toBe(chat.sid);
  await waitFor(() => expect((view.container.querySelector("textarea") as HTMLTextAreaElement)?.value).toBe("unsaved buffer\n"));
  expect(view.container.textContent).toContain("Unsaved, recovered");
  expect(files.get(`${cwd}/answer.md`)).toBe("saved\n");
  expect(view.container.querySelector(`[data-sid="${chat.sid}"]`)?.getAttribute("data-active")).toBe("true");
  await act(async () => useUiStateStore.getState().retry());
  const tabs = JSON.parse(files.get(`${cwd}/.pi/ui-state.json`)!).windows.main.tabs;
  expect(tabs).toContainEqual({ id: editor.sid, kind: "editor", cwd, path: `${cwd}/answer.md` });
  expect(tabs.find((tab: { kind: string }) => tab.kind === "pi").id).toBe(chat.sid);
});

it("recovers quotation text and the path-backed image chip together from the saved sid", async () => {
  seedWindow();
  seedChat(chatSid, quote, true);
  const view = render(<Project />);
  const chip = await view.findByRole("img");
  expect(chip.getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);
  expect(view.getByLabelText("pi composer").textContent).toContain("$ echo quartz");
  expect(view.getByLabelText("pi composer").textContent).toContain("Keep this draft.");
  expect(view.container.textContent).toContain(imagePath);
  expect(view.container.querySelector('[data-uat="attachment-chip"]')?.getAttribute("data-uat-key")).toBe("image-saved");
  expect(view.queryByText("Recoverable drafts")).toBeNull();
  await act(async () => useUiStateStore.getState().retry());
  expect(JSON.parse(files.get(`${cwd}/.pi/ui-state.json`)!).windows.main.tabs).toContainEqual({ id: chatSid, kind: "pi", cwd, sessionId: "session-saved" });
  expect(JSON.parse(files.get(`${cwd}/.pi/drafts/${chatSid}.json`)!).sources[0].blockId).toBe(3);
});

it("lists orphan drafts by first line and Recover opens the original sid without replacing current input", async () => {
  seedWindow();
  seedChat(chatSid, "Current unsent text");
  files.set(`${cwd}/.pi/drafts/orphan-text.md`, "Orphan first line\nMore text");
  const view = render(<Project />);
  await view.findByText("Recoverable drafts");
  expect(view.getByText("Orphan first line")).toBeTruthy();
  const recover = view.container.querySelector('[data-uat="draft-recover"][data-uat-key="orphan-text"]')!;
  fireEvent.click(recover);
  await waitFor(() => expect(view.container.querySelector('[data-sid="orphan-text"] [data-uat="composer-input"]')?.textContent).toContain("More text"));
  expect(view.container.querySelector(`[data-sid="${chatSid}"] [data-uat="composer-input"]`)?.textContent).toBe("Current unsent text");
  expect(view.container.querySelector('[data-sid="orphan-text"]')?.getAttribute("data-active")).toBe("true");
  expect(view.container.querySelector('[data-uat="draft-recover"][data-uat-key="orphan-text"]')).toBeNull();
});

it("offers image-only and editor orphan records under their own sids", async () => {
  seedWindow();
  seedChat("orphan-image", "", true);
  files.delete(`${cwd}/.pi/drafts/orphan-image.md`);
  files.set(`${cwd}/orphan.md`, "saved");
  files.set(`${cwd}/.pi/drafts/orphan-editor.md`, "Recovered editor line");
  files.set(`${cwd}/.pi/drafts/orphan-editor.json`, JSON.stringify({ v: 1, kind: "editor", path: `${cwd}/orphan.md`, baseSha256: await sha256Hex("saved") }));
  const view = render(<Project />);
  await view.findByText("1 queued image");
  fireEvent.click(view.container.querySelector('[data-uat-key="orphan-image"]')!);
  await view.findByRole("img");
  const active = view.container.querySelector('[data-sid="orphan-image"]')!;
  fireEvent.click(active.querySelector('[data-uat-key="orphan-editor"]')!);
  await waitFor(() => expect((view.container.querySelector("textarea") as HTMLTextAreaElement)?.value).toBe("Recovered editor line"));
  expect(view.getByText("Unsaved, recovered")).toBeTruthy();
});

it("drops empty orphan drafts and deletes both of their files at listing time", async () => {
  seedWindow();
  files.set(`${cwd}/.pi/drafts/orphan-empty.md`, "");
  files.set(`${cwd}/.pi/drafts/orphan-empty.json`, JSON.stringify(emptyChatMeta()));
  files.set(`${cwd}/.pi/drafts/orphan-blank.md`, "\n  \n");
  files.set(`${cwd}/.pi/drafts/orphan-blank.json`, JSON.stringify(emptyChatMeta()));
  const view = render(<Project />);
  await waitFor(() => expect(files.has(`${cwd}/.pi/drafts/orphan-empty.md`)).toBe(false));
  expect(files.has(`${cwd}/.pi/drafts/orphan-empty.json`)).toBe(false);
  expect(files.has(`${cwd}/.pi/drafts/orphan-blank.md`)).toBe(false);
  expect(files.has(`${cwd}/.pi/drafts/orphan-blank.json`)).toBe(false);
  expect(view.queryByText("Recoverable drafts")).toBeNull();
});

it("caps the strip at eight rows with an and-N-more line", async () => {
  seedWindow();
  for (let i = 1; i <= 10; i += 1) {
    const sid = `orphan-${String(i).padStart(2, "0")}`;
    files.set(`${cwd}/.pi/drafts/${sid}.md`, `Orphan row ${i}\n`);
    files.set(`${cwd}/.pi/drafts/${sid}.json`, JSON.stringify(emptyChatMeta()));
  }
  const view = render(<Project />);
  await view.findByText("Recoverable drafts");
  expect(view.container.querySelectorAll('[data-uat="draft-recover"]')).toHaveLength(8);
  expect(view.getByText("and 2 more")).toBeTruthy();
  expect(view.getByText("Orphan row 1")).toBeTruthy();
  expect(view.container.querySelector('[data-uat-key="orphan-09"]')).toBeNull();
  expect(view.container.querySelector('[data-uat-key="orphan-10"]')).toBeNull();
});

it("keeps an orphan row and names the file when Recover cannot bind it", async () => {
  seedWindow();
  seedChat("unreadable", "Kept orphan");
  const view = render(<Project />);
  await view.findByText("Kept orphan");
  denied.add(`${cwd}/.pi/drafts/unreadable.json`);
  fireEvent.click(view.container.querySelector('[data-uat-key="unreadable"]')!);
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain(`${cwd}/.pi/drafts/unreadable.json`));
  expect(view.getByRole("banner")).toBeTruthy();
  expect(view.container.querySelector('[data-sid="unreadable"]')).toBeNull();
  expect(view.container.querySelector('[data-uat-key="unreadable"]')).toBeTruthy();
});

it("shows a recovery error and retries a corrupt bound record without overwriting its text", async () => {
  seedWindow();
  seedChat(chatSid, "Draft survives a bad record");
  files.set(`${cwd}/.pi/drafts/${chatSid}.json`, "{broken");
  const view = render(<Project />);
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain(`${chatSid}.json`));
  expect((view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  expect(files.get(`${cwd}/.pi/drafts/${chatSid}.md`)).toBe("Draft survives a bad record");
  files.set(`${cwd}/.pi/drafts/${chatSid}.json`, JSON.stringify(emptyChatMeta()));
  fireEvent.click(view.getByRole("button", { name: "Retry recovery" }));
  await waitFor(() => expect(view.getByLabelText("pi composer").textContent).toBe("Draft survives a bad record"));
  expect(view.queryByRole("alert")).toBeNull();
});

it("keeps a missing recovered image chip with a visible path-bearing error", async () => {
  seedWindow();
  seedChat(chatSid, quote, true);
  files.delete(`${cwd}/${imagePath}`);
  const view = render(<Project />);
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain(imagePath));
  const chip = view.container.querySelector('[data-uat="attachment-chip"]') as HTMLElement;
  expect(within(chip).getByText("missing")).toBeTruthy();
  expect(view.getByLabelText("pi composer").textContent).toContain("$ echo quartz");
});
