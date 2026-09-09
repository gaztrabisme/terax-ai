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

const { readFileMock, invokeMock, cwdsHandlers, healthCalls } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  invokeMock: vi.fn(),
  cwdsHandlers: [] as Array<(e: { payload: unknown }) => void>,
  healthCalls: [] as Array<{
    url: string;
    agentDir: string | null;
    provider: string | null;
  }>,
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
import { modelsProbeUrl, PiFirstRun } from "./PiFirstRun";

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

/** The paths resolution, plus health answers keyed by the probed
 *  `<base>/models` URL: every other command and file read fails like on a
 *  bare machine. The health mock mirrors the backend contract: the probe is
 *  asked with the endpoint base plus the runtime agent dir and provider, and
 *  the answer echoes the exact URL that was (or would be) requested. */
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
      const call = args as {
        url: string;
        agentDir: string | null;
        provider: string | null;
      };
      healthCalls.push(call);
      const probed = `${call.url.trim().replace(/\/+$/, "")}/models`;
      const hit = health[probed] as
        | { ok: boolean; status: number | null; ms: number; error?: string | null }
        | undefined;
      return hit
        ? { ...hit, url: probed }
        : { ok: false, status: null, ms: 0, error: `no probe for ${probed}`, url: probed };
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
  healthCalls.length = 0;
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
      "http://127.0.0.1:8080/models": {
        ok: true,
        status: 200,
        ms: 3,
        error: null,
      },
      "http://127.0.0.1:9999/v1/models": {
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
    screen.getByText(
      "http://127.0.0.1:9999/v1/models: connection refused (project)",
    ),
  ).toBeTruthy();
  // The generic bppc row for the answering fallback URL is stood down.
  expect(screen.queryByText(/127.0.0.1:8080\/models answered/)).toBeNull();
  // The probes went to GET <base>/models with the runtime agent dir and the
  // report's provider, the same request path and key inference uses.
  const runtimeProbe = healthCalls.find(
    (call) => call.url === "http://127.0.0.1:9999/v1",
  );
  expect(runtimeProbe).toEqual({
    url: "http://127.0.0.1:9999/v1",
    agentDir: "/agents/runtime",
    provider: "bppc",
  });
  const localProbe = healthCalls.find(
    (call) => call.url === "http://127.0.0.1:8080",
  );
  expect(localProbe).toEqual({
    url: "http://127.0.0.1:8080",
    agentDir: "/agents/runtime",
    provider: "bppc",
  });
});

it("the endpoint check row shows the exact URL and the HTTP status", async () => {
  seedPrefs("local-fixture", "");
  mockBackend(
    {
      "http://127.0.0.1:9999/v1/models": {
        ok: false,
        status: 404,
        ms: 2,
        error: null,
      },
    },
    REPORT,
  );
  render(<PiFirstRun
    onFocusPaths={() => {}}
    onFocusRoles={() => {}}
    onFocusEndpoints={() => {}}
    onSignIn={() => {}}
    onAddKey={() => {}}
  />);
  await openProjectTab();
  expect(
    await screen.findByText(
      "http://127.0.0.1:9999/v1/models: HTTP 404 (project)",
    ),
  ).toBeTruthy();
});

it("an answered endpoint check row names the probed URL with its latency", async () => {
  seedPrefs("local-fixture", "");
  mockBackend(
    {
      "http://127.0.0.1:9999/v1/models": {
        ok: true,
        status: 200,
        ms: 4,
        error: null,
      },
    },
    REPORT,
  );
  render(<PiFirstRun
    onFocusPaths={() => {}}
    onFocusRoles={() => {}}
    onFocusEndpoints={() => {}}
    onSignIn={() => {}}
    onAddKey={() => {}}
  />);
  await openProjectTab();
  expect(
    await screen.findByText(
      "http://127.0.0.1:9999/v1/models answered in 4 ms (project)",
    ),
  ).toBeTruthy();
});

it("modelsProbeUrl appends /models with and without a trailing /v1", () => {
  expect(modelsProbeUrl("http://127.0.0.1:8000/v1")).toBe(
    "http://127.0.0.1:8000/v1/models",
  );
  expect(modelsProbeUrl("http://127.0.0.1:8080")).toBe(
    "http://127.0.0.1:8080/models",
  );
  expect(modelsProbeUrl("http://127.0.0.1:8000/v1/")).toBe(
    "http://127.0.0.1:8000/v1/models",
  );
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

it("shows pi defaults and per-field sources in the first-run rows", async () => {
  const { runtimeReportRows } = await import("./PiFirstRun");
  const rows = runtimeReportRows({ ...REPORT, roles: { orchestrator: { ...REPORT.roles.orchestrator, source: "pi default", model_source: "global", thinking_source: "explicit" } } }, {});
  expect(rows.find((row) => row.id === "runtime-provider")?.detail).toBe("local-fixture (pi default)");
  expect(rows.find((row) => row.id === "runtime-model")?.detail).toBe("fixture-model (global)");
  expect(rows.find((row) => row.id === "runtime-thinking")?.detail).toBe("high (explicit)");
  expect(rows.find((row) => row.id === "runtime-endpoint")?.detail).toContain("127.0.0.1:9999");
});
