// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_CSP, type ArtifactDoc } from "../lib/artifacts";
import {
  ArtifactPane,
  ARTIFACT_SANDBOX,
  ARTIFACT_SANDBOX_SCRIPTS,
} from "./ArtifactPane";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

// Save must resolve without Tauri; both fs calls answer ready.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const DOC: ArtifactDoc = {
  kind: "html",
  title: "Demo",
  source:
    "<!doctype html><html><head><title>Demo</title></head><body><h1>Hi</h1></body></html>",
  turn: 2,
  n: 0,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("ArtifactPane sandbox", () => {
  it("renders the srcdoc iframe without scripts and with the CSP meta", () => {
    const { container } = render(<ArtifactPane doc={DOC} cwd="/proj" />);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe(ARTIFACT_SANDBOX);
    expect(ARTIFACT_SANDBOX).not.toContain("allow-scripts");
    expect(ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    const srcdoc = iframe?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain(ARTIFACT_CSP);
    expect(srcdoc).toContain("<h1>Hi</h1>");
  });

  it("shows the empty state before any artifact", () => {
    const { container } = render(<ArtifactPane doc={null} cwd="/proj" />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("No artifact yet");
  });
});

describe("ArtifactPane scripts consent", () => {
  it("turns allow-scripts on only after the one-line consent", () => {
    const { container, getByRole, getByText } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      ARTIFACT_SANDBOX,
    );

    fireEvent.click(getByRole("button", { name: "Run scripts" }));
    // The consent line shows first; nothing re-renders yet.
    expect(
      getByText("Scripts in this artifact run with the network blocked."),
    ).not.toBeNull();
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      ARTIFACT_SANDBOX,
    );

    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      ARTIFACT_SANDBOX,
    );

    fireEvent.click(getByRole("button", { name: "Run scripts" }));
    fireEvent.click(getByRole("button", { name: "Allow" }));
    const sandbox = container.querySelector("iframe")?.getAttribute("sandbox");
    expect(sandbox).toBe(ARTIFACT_SANDBOX_SCRIPTS);
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(getByRole("button", { name: "Scripts on" })).not.toBeNull();
  });

  it("resets scripts and the saved path when the artifact changes", () => {
    const { container, getByRole, rerender } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );
    fireEvent.click(getByRole("button", { name: "Run scripts" }));
    fireEvent.click(getByRole("button", { name: "Allow" }));
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      ARTIFACT_SANDBOX_SCRIPTS,
    );

    rerender(
      <ArtifactPane doc={{ ...DOC, title: "Next", turn: 3 }} cwd="/proj" />,
    );
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      ARTIFACT_SANDBOX,
    );
    expect(getByRole("button", { name: "Run scripts" })).not.toBeNull();
  });
});

describe("ArtifactPane save", () => {
  it("writes the project file under .pi/artifacts and opens it from the chip", async () => {
    const opened: string[] = [];
    const listener = (e: Event) => {
      opened.push((e as CustomEvent<{ path: string }>).detail.path);
    };
    window.addEventListener("pi:open-file", listener);
    const { container, getByRole } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );

    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fs_create_dir", {
        path: "/proj/.pi/artifacts",
        workspace: { kind: "local" },
      });
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fs_write_file", {
        path: "/proj/.pi/artifacts/2-0.html",
        content: DOC.source,
        workspace: { kind: "local" },
      });
    });

    const chip = getByRole("button", { name: /\.pi\/artifacts\/2-0\.html/ });
    expect(container.textContent).toContain(".pi/artifacts/2-0.html");
    fireEvent.click(chip);
    expect(opened).toEqual(["/proj/.pi/artifacts/2-0.html"]);
    window.removeEventListener("pi:open-file", listener);
  });

  it("keeps the Save button off for artifacts that already are files", () => {
    const { container } = render(
      <ArtifactPane
        doc={{ ...DOC, path: "/proj/.pi/artifacts/2-0.html", kind: "md" }}
        cwd="/proj"
      />,
    );
    expect(container.textContent).not.toContain("Save");
  });

  it("surfaces a failed write instead of swallowing it", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fs_write_file"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(),
    );
    const { getByRole, getByText } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(getByText("disk full")).not.toBeNull());
  });
});
