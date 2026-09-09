// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModeStrip } from "@/modules/pi/components/ModeStrip";

afterEach(cleanup);

it("keeps Artifact available with no file and opens it on request", () => {
  const onToggle = vi.fn();
  render(<ModeStrip view={null} hasArtifact={false} boardCount={0} graphCount={0} buttons={{ current: {} }} onToggle={onToggle} />);
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Board", "Graph", "Sessions", "Artifact"]);
  const artifact = screen.getByRole("button", { name: "Artifact" });
  expect(artifact.hasAttribute("disabled")).toBe(false);
  expect(onToggle).not.toHaveBeenCalled();
  fireEvent.click(artifact);
  expect(onToggle).toHaveBeenCalledWith("artifact");
});
