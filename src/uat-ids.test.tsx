// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer, useRef } from "react";
import { ChatView } from "./modules/pi/components/ChatView";
import { ModeStrip } from "./modules/pi/components/ModeStrip";
import {
  CLOSED_VIEW,
  viewReducer,
  type ChatView as View,
} from "./modules/pi/lib/viewMachine";
import {
  UAT_IDS_K4,
  UAT_IDS_K6,
  UAT_IDS_K4_ABSENT,
  UAT_IDS_K4_STATEFUL,
  UAT_IDS_K12F_STATEFUL,
} from "./lib/uatIds";

// Entries are repo-root-relative; this test lives in src/.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceOf(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

/** True when the source carries the id in any data-uat attribute form:
 *  a JSX literal, a ternary value, or an imperative setAttribute. */
function carriesUatId(source: string, id: string): boolean {
  return (
    source.includes(`data-uat="${id}"`) ||
    source.includes(`"data-uat", "${id}"`) ||
    (source.includes("data-uat") && source.includes(`"${id}"`))
  );
}

describe("UAT_IDS_K4", () => {
  it("assigns every in-scope id a unique kebab-case name", () => {
    const ids = [...UAT_IDS_K4, ...UAT_IDS_K6].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("marks every id on its owning component's source", () => {
    for (const entry of [...UAT_IDS_K4, ...UAT_IDS_K6]) {
      expect(
        carriesUatId(sourceOf(entry.file), entry.id),
        `data-uat="${entry.id}" missing from ${entry.file}`,
      ).toBe(true);
    }
  });
});

describe("UAT_IDS_K4_STATEFUL", () => {
  it("marks every stateful id on its owning component's source", () => {
    for (const entry of UAT_IDS_K4_STATEFUL) {
      expect(
        carriesUatId(sourceOf(entry.file), entry.id),
        `data-uat="${entry.id}" missing from ${entry.file}`,
      ).toBe(true);
      expect(entry.state.length).toBeGreaterThan(0);
    }
  });

  it("records a state for each and never overlaps the reachable list", () => {
    const reachable = new Set(UAT_IDS_K4.map((entry) => entry.id));
    for (const entry of UAT_IDS_K4_STATEFUL) {
      expect(reachable.has(entry.id)).toBe(false);
    }
  });
});

describe("UAT_IDS_K12F_STATEFUL", () => {
  it("registers all ten action, graph error and child navigation ids without overlap", () => {
    expect(UAT_IDS_K12F_STATEFUL).toHaveLength(10);
    const known = [...UAT_IDS_K4, ...UAT_IDS_K6, ...UAT_IDS_K4_STATEFUL, ...UAT_IDS_K12F_STATEFUL].map((entry) => entry.id);
    expect(new Set(known).size).toBe(known.length);
    for (const entry of UAT_IDS_K12F_STATEFUL) {
      expect(carriesUatId(sourceOf(entry.file), entry.id), entry.id).toBe(true);
      expect(entry.state.length).toBeGreaterThan(0);
    }
  });
});

describe("UAT_IDS_K4_ABSENT", () => {
  it("documents K4 rows whose control does not exist in this tree", () => {
    const known = new Set([
      ...UAT_IDS_K4.map((entry) => entry.id),
      ...UAT_IDS_K4_STATEFUL.map((entry) => entry.id),
    ]);
    for (const entry of UAT_IDS_K4_ABSENT) {
      expect(known.has(entry.id)).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

function ViewInventory() {
  const [state, dispatch] = useReducer(viewReducer, CLOSED_VIEW);
  const buttons = useRef<Partial<Record<View, HTMLButtonElement>>>({});
  const viewRef = useRef<HTMLElement>(null);
  return (
    <div>
      <ModeStrip
        view={state.view}
        hasArtifact
        boardCount={1}
        graphCount={1}
        buttons={buttons}
        onToggle={(view) => dispatch({ type: "toggle", view, narrow: false })}
      />
      {state.view && (
        <ChatView
          view={state.view}
          mode={state.mode}
          width={300}
          contentWidth={1000}
          popoverTop={80}
          viewRef={viewRef}
          onClose={() => dispatch({ type: "close" })}
          onBack={() => dispatch({ type: "back", narrow: false })}
          onFullscreen={() => dispatch({ type: "fullscreen" })}
          onExpand={() => dispatch({ type: "expand", narrow: false })}
          onWidthCommit={() => {}}
        >
          <input aria-label="View content" />
        </ChatView>
      )}
    </div>
  );
}

afterEach(cleanup);

describe("K6 rendered mode inventory", () => {
  it("traverses the strip and each open mode with canonical names and scoped separators", () => {
    const { container } = render(<ViewInventory />);
    const seen = new Set<string>();
    const collect = () => {
      container
        .querySelectorAll("[data-uat]")
        .forEach((node) => seen.add(node.getAttribute("data-uat")!));
      expect(
        container.querySelectorAll("section[data-mode]").length,
      ).toBeLessThanOrEqual(1);
    };
    collect();
    for (const view of ["Board", "Graph", "Sessions", "Artifact"]) {
      fireEvent.click(screen.getByRole("button", { name: view }));
      collect();
      if (view === "Sessions") {
        expect(
          container.querySelector('[data-uat="sessions-popover"]'),
        ).toBeTruthy();
        fireEvent.click(
          screen.getByRole("button", { name: "Expand Sessions" }),
        );
        collect();
      }
      const separator = screen.getByRole("separator", {
        name: `Resize ${view} panel`,
      });
      expect(separator.getAttribute("data-uat")).toBe("panel-resize");
      expect(separator.getAttribute("data-uat-key")).toBe(view.toLowerCase());
      fireEvent.click(
        screen.getByRole("button", { name: `Full screen ${view}` }),
      );
      collect();
      expect(
        container.querySelector(
          `[data-uat="${view.toLowerCase()}-fullscreen"]`,
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      fireEvent.click(screen.getByRole("button", { name: `Close ${view}` }));
      collect();
    }
    expect([...seen].sort()).toEqual(
      UAT_IDS_K6.map((entry) => entry.id).sort(),
    );
    expect(container.querySelector('[data-uat$="-pane"]')).toBeNull();
  });
});
