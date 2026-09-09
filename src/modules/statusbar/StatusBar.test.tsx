// @vitest-environment jsdom
// UX-10 (k4-04-statusbar): the chat status bar read "no directory" while a
// terminal tab on the same project showed a real breadcrumb. Design.md 3.2 S1
// requires a truthful project/cwd breadcrumb on every primary surface, so the
// pi tab's cwd from the tab record must render exactly like a terminal's.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

afterEach(() => cleanup());

function renderBar(cwd: string | null, home: string | null = null) {
  return render(
    <StatusBar
      cwd={cwd}
      filePath={null}
      home={home}
      onCd={() => {}}
      onWorkspaceChange={() => {}}
      privateActive={false}
    />,
  );
}

function crumbOf(container: HTMLElement): HTMLElement {
  const bar = container.querySelector('[data-uat="statusbar"]');
  expect(bar).not.toBeNull();
  const crumb = bar!.querySelector('[data-uat="cwd-breadcrumb"]');
  expect(crumb).not.toBeNull();
  return crumb as HTMLElement;
}

function segmentLabels(crumb: HTMLElement): string[] {
  const links = crumb.querySelectorAll('[data-slot="breadcrumb-link"]');
  const page = crumb.querySelector(
    '[data-slot="dropdown-menu-trigger"][aria-current="page"]',
  );
  return [
    ...Array.from(links).map((el) => el.textContent ?? ""),
    ...(page ? [page.textContent ?? ""] : []),
  ];
}

describe("StatusBar cwd breadcrumb on a pi tab", () => {
  it("names the chat tab's project path instead of no directory", () => {
    const { container } = renderBar("/tmp/standalone-proj");
    expect(crumbOf(container).textContent).not.toContain("no directory");
    // Path segments appear in order, ending on the project folder.
    expect(segmentLabels(crumbOf(container))).toEqual([
      "/",
      "tmp",
      "standalone-proj",
    ]);
  });

  it("collapses the home prefix exactly as a terminal tab's breadcrumb does", () => {
    const { container } = renderBar("/tmp/standalone-proj", "/tmp");
    expect(segmentLabels(crumbOf(container))).toEqual([
      "Home",
      "standalone-proj",
    ]);
  });

  it("still reports no directory when the surface has none", () => {
    // Truthful empty state: a surface without a cwd must not invent one.
    const { container } = renderBar(null);
    expect(
      container.querySelector('[data-uat="statusbar"]')!.textContent,
    ).toContain("no directory");
  });
});
