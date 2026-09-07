// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, convertFileSrcMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn(),
}));

// fs_stat rides invoke; convertFileSrc stands in for the Tauri asset mapping.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));

import { ImageRenderer } from "./Image";

beforeEach(() => {
  invokeMock.mockReset();
  convertFileSrcMock.mockReset();
  convertFileSrcMock.mockImplementation((p: string) => `asset://localhost/${p}`);
  invokeMock.mockResolvedValue({ size: 12, mtime: 0, kind: "file" });
});

afterEach(cleanup);

const part = (text: string) => ({ type: "image", text });

describe("ImageRenderer", () => {
  it("renders the bitmap through the asset protocol", async () => {
    const { container } = render(
      <ImageRenderer part={part("/tmp/art/shot.png")} />,
    );
    const img = await waitFor(() => {
      const el = container.querySelector("img");
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute("src")).toBe("asset://localhost//tmp/art/shot.png");
    expect(img.getAttribute("alt")).toBe("shot.png");
    expect(container.textContent).toContain("shot.png");
  });

  it("falls back to the chip when the bitmap fails to load", async () => {
    const { container } = render(
      <ImageRenderer part={part("/tmp/art/shot.png")} />,
    );
    const img = (await waitFor(() => {
      const el = container.querySelector("img");
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    })) as HTMLImageElement;
    fireEvent.error(img);
    await waitFor(() => {
      expect(container.querySelector("img")).toBeNull();
    });
    expect(container.textContent).toContain("/tmp/art/shot.png");
  });

  it("renders the chip when the file is missing", async () => {
    invokeMock.mockRejectedValue(new Error("missing"));
    const { container } = render(
      <ImageRenderer part={part("/tmp/art/gone.png")} />,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("file missing");
    });
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders only the chip when no asset URL can be built", () => {
    convertFileSrcMock.mockImplementation(() => {
      throw new Error("no tauri runtime");
    });
    const { container } = render(
      <ImageRenderer part={part("/tmp/art/shot.png")} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("/tmp/art/shot.png");
  });
});
