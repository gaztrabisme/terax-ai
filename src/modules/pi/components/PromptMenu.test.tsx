// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptMenu } from "./PromptMenu";
import type { PiPromptEntry } from "@/modules/pi/lib/prompts";

afterEach(cleanup);

function entry(
  name: string,
  source: PiPromptEntry["source"],
  description = `${name} description`,
): PiPromptEntry {
  return { name, description, path: `/prompts/${name}.md`, source };
}

const prompts = [
  entry("brief", "agent"),
  entry("review", "project"),
  entry("ticket", "agent"),
];

describe("PromptMenu", () => {
  it("lists prompts with name, description and source", () => {
    render(
      <PromptMenu
        prompts={prompts}
        query=""
        highlighted={0}
        onHighlight={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("/brief")).toBeTruthy();
    expect(screen.getByText("brief description")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();
  });

  it("filters fuzzily on the query", () => {
    render(
      <PromptMenu
        prompts={prompts}
        query="rev"
        highlighted={0}
        onHighlight={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.queryByText("/brief")).toBeNull();
    expect(screen.queryByText("/ticket")).toBeNull();
  });

  it("shows the empty state when nothing matches", () => {
    render(
      <PromptMenu
        prompts={prompts}
        query="zzz"
        highlighted={0}
        onHighlight={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("No matching prompts")).toBeTruthy();
  });

  it("marks the highlighted row and reports hover moves", () => {
    const onHighlight = vi.fn();
    render(
      <PromptMenu
        prompts={prompts}
        query=""
        highlighted={1}
        onHighlight={onHighlight}
        onSelect={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(
      options.map((o) => o.getAttribute("aria-selected")),
    ).toEqual(["false", "true", "false"]);
    fireEvent.mouseEnter(options[2]);
    expect(onHighlight).toHaveBeenCalledWith(2);
  });

  it("selects on click without stealing the editor focus", () => {
    const onSelect = vi.fn();
    render(
      <PromptMenu
        prompts={prompts}
        query=""
        highlighted={0}
        onHighlight={vi.fn()}
        onSelect={onSelect}
      />,
    );
    const option = screen.getAllByRole("option")[1];
    // A cancelable native event dispatched at the option: React's delegated
    // handler preventDefaults it (so the editor never blurs), visible once
    // dispatchEvent returns.
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(event);
    expect(onSelect).toHaveBeenCalledWith(prompts[1]);
    expect(event.defaultPrevented).toBe(true);
  });
});
