// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_CSP, type ArtifactDoc } from "../lib/artifacts";
import { ArtifactPane, ARTIFACT_SANDBOX } from "./ArtifactPane";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const DOC: ArtifactDoc = {
  kind: "html",
  title: "Demo",
  source:
    "<!doctype html><html><head><title>Demo</title></head><body><h1>Hi</h1></body></html>",
  turn: 2,
  n: 0,
  path: "/proj/.pi/artifacts/art-abc123.html",
  sha256: "f00d",
};

const READ = {
  mime: "text/html",
  sha256: "f00d",
  content: DOC.source,
  base64: null,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(READ);
});

afterEach(() => cleanup());

describe("ArtifactPane file-first viewer", () => {
  it("reads the file back and renders it in a scriptless sandboxed iframe", async () => {
    const { container } = render(<ArtifactPane doc={DOC} cwd="/proj" />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("pi_read_artifact", {
        cwd: "/proj",
        path: "/proj/.pi/artifacts/art-abc123.html",
        workspace: { kind: "local" },
      });
    });
    const iframe = await waitFor(() => {
      const frame = container.querySelector("iframe");
      expect(frame).not.toBeNull();
      return frame as HTMLIFrameElement;
    });
    expect(iframe.getAttribute("sandbox")).toBe(ARTIFACT_SANDBOX);
    expect(ARTIFACT_SANDBOX).not.toContain("allow-scripts");
    expect(ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    const srcdoc = iframe.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain(ARTIFACT_CSP);
    expect(srcdoc).toContain("<h1>Hi</h1>");
  });

  it("shows the path, copies the absolute path, and opens the editor from the link", async () => {
    const opened: string[] = [];
    const listener = (e: Event) => {
      opened.push((e as CustomEvent<{ path: string }>).detail.path);
    };
    window.addEventListener("pi:open-file", listener);
    const written: string[] = [];
    const writeSpy = vi.fn((text: string) => {
      written.push(text);
      return Promise.resolve();
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeSpy },
      configurable: true,
    });
    const { getByRole, getByText } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );
    function container_query(selector: string): Element | null {
      return document.querySelector(selector);
    }
    await waitFor(() => {
      expect(getByText(".pi/artifacts/art-abc123.html")).not.toBeNull();
    });
    fireEvent.click(getByRole("button", { name: "Copy path" }));
    await waitFor(() => {
      expect(written).toEqual(["/proj/.pi/artifacts/art-abc123.html"]);
    });
    fireEvent.click(
      container_query('[data-uat="artifact-path"]') as HTMLButtonElement,
    );
    expect(opened).toEqual(["/proj/.pi/artifacts/art-abc123.html"]);
    window.removeEventListener("pi:open-file", listener);
  });

  it("shows a path-bearing error when the file is missing or unreadable", async () => {
    invokeMock.mockRejectedValue(
      new Error("cannot read artifact /proj/.pi/artifacts/art-abc123.html: no such file"),
    );
    const { getByText, getByRole } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );
    await waitFor(() => {
      const error = getByText(/cannot read artifact/);
      expect(error.textContent).toContain("art-abc123.html");
    });
    expect(document.querySelector('[data-uat="artifact-error"]')).not.toBeNull();
    expect(container_iframe()).toBeNull();
    // Retry re-reads the file.
    invokeMock.mockResolvedValue(READ);
    fireEvent.click(getByRole("button", { name: "Retry artifact load" }));
    await waitFor(() => {
      expect(container_iframe()).not.toBeNull();
    });
  });

  function container_iframe(): HTMLIFrameElement | null {
    return document.querySelector("iframe");
  }

  it("reloads with the file's new contents when a refresh changes the hash", async () => {
    const { container, getByRole } = render(
      <ArtifactPane doc={DOC} cwd="/proj" />,
    );
    await waitFor(() => {
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
        "<h1>Hi</h1>",
      );
    });
    invokeMock.mockResolvedValue({
      mime: "text/html",
      sha256: "beef",
      content: "<!doctype html><html><body><p>Changed</p></body></html>",
      base64: null,
    });
    fireEvent.click(getByRole("button", { name: "Refresh artifact" }));
    await waitFor(() => {
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
        "Changed",
      );
    });
  });

  it("offers no Run scripts, Allow or Save control anywhere", async () => {
    const { container } = render(<ArtifactPane doc={DOC} cwd="/proj" />);
    await waitFor(() => {
      expect(container.querySelector("iframe")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Run scripts");
    expect(container.textContent).not.toContain("Allow");
    expect(container.textContent).not.toContain("Save");
  });

  it("shows the empty state before any artifact", () => {
    const { container } = render(<ArtifactPane doc={null} cwd="/proj" />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("No artifact yet");
  });
});
