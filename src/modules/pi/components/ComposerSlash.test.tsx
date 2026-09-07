// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

// Draft restore is the headless way to put a slash line into the editor: the
// draft promise is held until the test has focused the editor, because the
// menu only opens from an update on a focused editor.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { PiPromptEntry } from "@/modules/pi/lib/prompts";

const PROMPTS: PiPromptEntry[] = [
  {
    name: "brief",
    description: "Expand a task into a worker brief",
    path: "/agent/prompts/brief.md",
    source: "agent",
  },
  {
    name: "review",
    description: "Review the diff",
    path: "/proj/.pi/prompts/review.md",
    source: "project",
  },
];

let releaseDraft: (content: string) => void = () => {};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "fs_read_file") {
      return new Promise((resolve) => {
        releaseDraft = (content) => resolve({ kind: "text", content });
      });
    }
    if (cmd === "pi_paths") {
      return Promise.resolve({
        runtimeAgentDir: { path: "/tmp/agent", source: "pref", seeded: true },
      });
    }
    if (cmd === "pi_prompts_list") return Promise.resolve(PROMPTS);
    return Promise.resolve({ kind: "ok" });
  });
});

afterEach(cleanup);

function renderWithDraft(draft: string) {
  const onSubmit = vi.fn();
  const utils = render(
    <Composer tabId={3} cwd="/tmp/proj" onSubmit={onSubmit} />,
  );
  const pm = utils.container.querySelector(
    "[aria-label='pi composer']",
  ) as HTMLElement;
  (pm as HTMLElement).focus();
  act(() => releaseDraft(draft));
  return { onSubmit, pm, ...utils };
}

function menu() {
  return screen.queryByRole("listbox", { name: "Prompt templates" });
}

describe("composer slash menu", () => {
  it("opens on a bare slash draft and lists every prompt", async () => {
    renderWithDraft("/");
    await waitFor(() => expect(menu()).toBeTruthy());
    expect(screen.getByText("/brief")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
  });

  it("filters fuzzily on the typed name token", async () => {
    renderWithDraft("/rev");
    await waitFor(() => expect(menu()).toBeTruthy());
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.queryByText("/brief")).toBeNull();
  });

  it("stays closed for plain text drafts", async () => {
    renderWithDraft("hello world");
    await new Promise((r) => setTimeout(r, 20));
    expect(menu()).toBeNull();
    expect(screen.queryByText("/brief")).toBeNull();
  });

  it("sends the completed slash line on select and closes", async () => {
    const { onSubmit } = renderWithDraft("/rev src/main.rs");
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.mouseDown(screen.getByText("/review").closest("button")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("/review src/main.rs", []);
    await waitFor(() => expect(menu()).toBeNull());
  });

  it("closes on Escape without sending", async () => {
    const { onSubmit, pm } = renderWithDraft("/");
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.keyDown(pm, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    // A fresh slash line re-arms the menu.
    expect(pm.textContent).toBe("/");
  });
});
