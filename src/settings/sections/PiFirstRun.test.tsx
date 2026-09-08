// @vitest-environment jsdom
// K14 check rows from the project's runtime report (design.md rows R2.1 and
// R2.2): when `<project>/.pi/runtime.json` is present the panel shows the
// effective binary, runtime agent dir, provider, model, thinking and
// endpoint with the sources the report records, and a failed endpoint check
// names the endpoint and the error with no fallback provider success.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const PROJ = "/proj/fixture";

/** The credential-free report runtime.rs writes before pi spawns. */
const REPORT = {
  v: 1,
  steps: [
    {
      name: "seed",
      status: "OK",
      detail: "seeded /agents/runtime: 3 created, 0 updated, 0 kept",
    },
    { name: "render", status: "OK", detail: "models.json rendered" },
    { name: "root", status: "OK", detail: "project root" },
    { name: "wiki", status: "OK", detail: "wiki files present" },
  ],
  agent_dir: "/agents/runtime",
  session_dir: `${PROJ}/.pi/sessions`,
  agent_hub_dir: "/agents/runtime/agent-hub",
  binary: { path: "/bundled/pi", source: "bundled" },
  agent_dir_source: "pref",
  roles: {
    orchestrator: {
      provider: "local-fixture",
      model: "fixture-model",
      thinking: "high",
      endpoint: "http://127.0.0.1:9999/v1",
      source: "project",
    },
  },
  launched_at: "2026-09-09T10:00:00.000Z",
};

/** The same launch against the built-in bppc provider. */
const BPPC_REPORT = {
  ...REPORT,
  roles: {
    orchestrator: { ...REPORT.roles.orchestrator, provider: "bppc" },
  },
};

const { readFileMock, invokeMock, cwdsHandlers } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  invokeMock: vi.fn(),
  cwdsHandlers: [] as Array<(e: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    cwdsHandlers.push(handler);
    return () => {};
  }),
}));

vi.mock("@/lib/native", () => ({ native: { readFile: readFileMock } }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async set() {}
    async save() {}
    async entries() {
      return [] as [string, unknown][];
    }
    async onChange() {
      return () => {};
    }
  },
}));

import { PI_PREF_DEFAULTS } from "@/modules/pi/lib/providers";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { PiFirstRun } from "./PiFirstRun";

function seedPrefs(provider: string, smol: string) {
  usePreferencesStore.setState({
    piLauncherDir: PI_PREF_DEFAULTS.launcherDir,
    piBoardBin: PI_PREF_DEFAULTS.boardBin,
    piAgentBin: PI_PREF_DEFAULTS.agentBin,
    piAgentDir: PI_PREF_DEFAULTS.agentDir,
    piProvider: provider,
    piModel: PI_PREF_DEFAULTS.model,
    piThinking: PI_PREF_DEFAULTS.thinking,
    piSmol: smol,
    piBppcHost: PI_PREF_DEFAULTS.bppcHost,
  });
}

/** The paths resolution, plus health answers keyed by URL: every other
 *  command and file read fails like on a bare machine. */
function mockBackend(
  health: Record<string, unknown>,
  report: typeof REPORT = REPORT,
) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "pi_paths") {
      return {
        pi: {
          path: "/bundled/pi",
          source: "bundled",
          candidates: ["/bundled/pi"],
        },
        agent: {
          path: "/harness/agent",
          source: "pref",
          candidates: ["/harness/agent"],
        },
        agentDir: {
          path: "/agents/runtime",
          source: "pref",
          candidates: ["/agents/runtime"],
        },
        runtimeAgentDir: {
          path: "/agents/runtime",
          source: "pref",
          seeded: true,
        },
      };
    }
    if (cmd === "pi_health") {
      const url = (args as { url: string }).url;
      if (url in health) return Promise.resolve(health[url]);
      return { ok: false, status: null, ms: 0, error: `no probe for ${url}` };
    }
    throw new Error(`${cmd} unavailable in test`);
  });
  readFileMock.mockImplementation(async (path: string) => {
    if (path === `${PROJ}/.pi/runtime.json`) {
      return { kind: "text", content: JSON.stringify(report), size: 1 };
    }
    throw new Error(`ENOENT: ${path}`);
  });
}

/** Delivers the open pi cwds, as the main window's broadcast would. */
async function openProjectTab() {
  await waitFor(() => expect(cwdsHandlers.length).toBeGreaterThan(0));
  for (const handler of cwdsHandlers) {
    handler({ payload: { cwds: [PROJ] } });
  }
}

beforeEach(() => {
  cwdsHandlers.length = 0;
  invokeMock.mockReset();
  readFileMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders the report rows with their recorded sources", async () => {
  seedPrefs("local-fixture", "local-fixture/child");
  mockBackend({});
  render(<PiFirstRun
    onFocusPaths={() => {}}
    onFocusRoles={() => {}}
    onFocusEndpoints={() => {}}
    onSignIn={() => {}}
    onAddKey={() => {}}
  />);

  // The project tab opens, so the check reads that project's report.
  await openProjectTab();
  expect(await screen.findByText("Effective binary")).toBeTruthy();
  // The live path row and the report row can share the same text.
  expect(
    screen.getAllByText("/bundled/pi (bundled)").length,
  ).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("Runtime agent dir")).toBeTruthy();
  expect(screen.getByText("/agents/runtime (pref)")).toBeTruthy();
  expect(screen.getByText("Seed")).toBeTruthy();
  expect(
    screen.getByText("OK: seeded /agents/runtime: 3 created, 0 updated, 0 kept"),
  ).toBeTruthy();
  expect(screen.getByText("Provider")).toBeTruthy();
  expect(screen.getByText("local-fixture (project)")).toBeTruthy();
  expect(screen.getByText("Model")).toBeTruthy();
  expect(screen.getByText("fixture-model (project)")).toBeTruthy();
  expect(screen.getByText("Thinking")).toBeTruthy();
  expect(screen.getByText("high (project)")).toBeTruthy();
});

it("a failed report endpoint names the endpoint and error, with no fallback success", async () => {
  seedPrefs("bppc", "");
  // The fallback probe URL (the template's default host) would answer, but
  // the report endpoint is down: only the report row may stand, and red.
  mockBackend(
    {
      "http://127.0.0.1:8080/health": {
        ok: true,
        status: 200,
        ms: 3,
        error: null,
      },
      "http://127.0.0.1:9999/v1": {
        ok: false,
        status: null,
        ms: 0,
        error: "connection refused",
      },
    },
    BPPC_REPORT,
  );
  render(<PiFirstRun
    onFocusPaths={() => {}}
    onFocusRoles={() => {}}
    onFocusEndpoints={() => {}}
    onSignIn={() => {}}
    onAddKey={() => {}}
  />);
  await openProjectTab();
  const endpoint = await screen.findByText("Endpoint");
  expect(endpoint).toBeTruthy();
  expect(
    screen.getByText("http://127.0.0.1:9999/v1: connection refused (project)"),
  ).toBeTruthy();
  // The generic bppc row for the answering fallback URL is stood down.
  expect(screen.queryByText(/127.0.0.1:8080\/health answered/)).toBeNull();
});

it("shows no report rows when the project carries no runtime.json", async () => {
  seedPrefs("local-fixture", "local-fixture/child");
  mockBackend({});
  readFileMock.mockRejectedValue(new Error("ENOENT"));
  render(<PiFirstRun
    onFocusPaths={() => {}}
    onFocusRoles={() => {}}
    onFocusEndpoints={() => {}}
    onSignIn={() => {}}
    onAddKey={() => {}}
  />);
  await openProjectTab();
  // The live resolution rows still render; nothing claims a launch happened.
  expect(await screen.findByText("pi binary")).toBeTruthy();
  expect(screen.queryByText("Effective binary")).toBeNull();
  expect(screen.queryByText("Runtime agent dir")).toBeNull();
});
