// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";

const invoke = vi.hoisted(() => vi.fn());
const fault = vi.hoisted(() => ({ mount: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("@/modules/editor/lib/vim", () => ({
  initVimGlobals: () => {},
  vimHandlersExtension: () => [],
}));
vi.mock("@/modules/editor/lib/languageResolver", () => ({ resolveLanguage: async () => [] }));
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value }: { value: string }) => {
    if (fault.mount) throw new Error("Editor initialization failed");
    return <textarea aria-label="Editor input" value={value} readOnly />;
  },
}));

import { EditorPane } from "./EditorPane";
import { EditorStack } from "./EditorStack";

afterEach(() => {
  cleanup();
  fault.mount = false;
  vi.restoreAllMocks();
});

it("mounts the editor after the asynchronous file load without changing hook order", async () => {
  invoke.mockResolvedValue({ kind: "text", content: "# Answer\n", size: 9 });
  const view = render(<EditorPane path="/proj/.pi/answers/answer.md" />);
  await waitFor(() => expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("# Answer\n"));
});

it("contains an editor mount failure while shell navigation and Return to chat remain usable", async () => {
  fault.mount = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  invoke.mockResolvedValue({ kind: "text", content: "answer", size: 6 });
  function Shell() {
    const [activeId, setActiveId] = useState(2);
    return <>
      <header><button onClick={() => setActiveId(1)}>Chat tab</button></header>
      {activeId === 1 && <main>Chat composer</main>}
      <EditorStack tabs={[
        { id: 1, kind: "pi", title: "pi", cwd: "/proj" },
        { id: 2, kind: "editor", title: "answer.md", path: "/proj/answer.md", dirty: false, preview: false },
      ]} activeId={activeId} onDirtyChange={() => {}} registerHandle={() => {}}
        onCloseTab={() => {}} onReturnToChat={() => setActiveId(1)} />
    </>;
  }
  const view = render(<Shell />);
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("/proj/answer.md"));
  expect(view.getByRole("banner")).toBeTruthy();
  expect(view.getByRole("button", { name: "Chat tab" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Return to chat" }));
  expect(view.getByRole("main").textContent).toBe("Chat composer");
});
