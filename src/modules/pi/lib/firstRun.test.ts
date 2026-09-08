import { describe, expect, it } from "vitest";
import {
  buildRows,
  chosenLocalEndpoints,
  effectiveRoles,
  endpointRows,
  pathRows,
  probeUrlFor,
  providerRows,
  rolesScopeLabel,
  summarize,
  type PiHealthMap,
  type PiRoles,
} from "./firstRun";
import type { PiResolvedPaths } from "@/modules/pi/lib/providers";

const bundledPaths: PiResolvedPaths = {
  pi: { path: "/app/exe/pi", source: "bundled", candidates: ["/app/exe/pi"] },
  agent: {
    path: "/app/exe/agent",
    source: "bundled",
    candidates: ["/app/exe/agent"],
  },
  agentDir: {
    path: "/app/res/pi-home/agent",
    source: "bundled",
    candidates: ["/app/res/pi-home/agent"],
  },
  runtimeAgentDir: {
    path: "/app/data/pi-home/agent",
    source: "bundled",
    seeded: true,
  },
};

const roles: PiRoles = { provider: "bppc", smol: "omlx/Qwen3.6-35B" };

describe("pathRows", () => {
  it("reports bundled and pref wins as ok with the winning path and source", () => {
    const rows = pathRows({
      ...bundledPaths,
      pi: {
        path: "/custom/pi",
        source: "pref",
        candidates: ["/custom/pi", "/app/exe/pi"],
      },
    });
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(rows[0].detail).toBe("/custom/pi (preference)");
    expect(rows[1].detail).toBe("/app/exe/agent (bundled)");
    // The agent dir row shows the runtime dir pi runs from, not the template.
    expect(rows[2].detail).toBe("/app/data/pi-home/agent (seeded copy)");
    expect(rows.map((r) => r.id)).toEqual([
      "path-pi",
      "path-agent",
      "path-agentDir",
    ]);
    expect(rows.every((r) => r.action === undefined)).toBe(true);
  });

  it("warns when a path falls back to the efficient-pi checkout", () => {
    const rows = pathRows({
      ...bundledPaths,
      pi: {
        path: "/checkout/bin/pi",
        source: "checkout",
        candidates: ["/app/exe/pi", "/checkout/bin/pi"],
      },
      runtimeAgentDir: {
        path: "/checkout/pi-home/agent",
        source: "checkout",
        seeded: false,
      },
    });
    expect(rows[0].status).toBe("warn");
    expect(rows[0].detail).toBe(
      "using the efficient-pi checkout at /checkout/bin/pi",
    );
    expect(rows[0].action).toEqual({
      label: "Open paths",
      kind: "focus-paths",
    });
    expect(rows[2].status).toBe("warn");
    expect(rows[2].detail).toBe(
      "using the efficient-pi checkout at /checkout/pi-home/agent",
    );
  });

  it("marks a bundled but unseeded runtime agent dir as seeded later", () => {
    const rows = pathRows({
      ...bundledPaths,
      runtimeAgentDir: {
        path: "/app/data/pi-home/agent",
        source: "bundled",
        seeded: false,
      },
    });
    expect(rows[2].status).toBe("warn");
    expect(rows[2].detail).toBe(
      "/app/data/pi-home/agent (seeded on the first session)",
    );
  });

  it("a pref agent dir is its own runtime dir with the preference label", () => {
    const prefRows = pathRows({
      ...bundledPaths,
      agentDir: {
        path: "/custom/agent-dir",
        source: "pref",
        candidates: ["/custom/agent-dir"],
      },
      runtimeAgentDir: { path: "/custom/agent-dir", source: "pref", seeded: false },
    });
    expect(prefRows[2].status).toBe("ok");
    expect(prefRows[2].detail).toBe("/custom/agent-dir (preference)");
  });

  it("reports missing with the first two candidates", () => {
    const rows = pathRows({
      ...bundledPaths,
      agentDir: {
        path: null,
        source: "missing",
        candidates: ["/first", "/second", "/third"],
      },
      runtimeAgentDir: { path: null, source: "missing", seeded: false },
    });
    expect(rows[2].status).toBe("missing");
    expect(rows[2].detail).toBe("/first or /second");
    expect(rows[2].action?.kind).toBe("focus-paths");
  });
});

describe("providerRows", () => {
  const providerList = [
    {
      id: "anthropic",
      name: "Anthropic",
      aliases: [],
      authEnv: ["ANTHROPIC_API_KEY"],
      api: "anthropic",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      aliases: [],
      authEnv: ["OPENROUTER_API_KEY"],
      api: "openai-completions",
    },
  ];

  it("flags a role with no provider chosen as missing with focus-roles", () => {
    const rows = providerRows(
      { provider: "  ", smol: "/model" },
      null,
      providerList,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("missing");
      expect(row.detail).toBe("no provider chosen");
      expect(row.action?.kind).toBe("focus-roles");
    }
  });

  it("is ok when the provider holds a key or an OAuth token", () => {
    const entries = {
      anthropic: "oauth",
      openrouter: "api_key",
    } as const;
    const rows = providerRows(
      { provider: "anthropic", smol: "openrouter/m" },
      entries,
      providerList,
    );
    expect(rows[0].status).toBe("ok");
    expect(rows[0].detail).toBe("anthropic: auth.json entry");
    expect(rows[1].status).toBe("ok");
    expect(rows[1].detail).toBe("openrouter: auth.json entry");
  });

  it("is ok for a cloud provider with the app's own stored key or env var", () => {
    const withStored = providerRows(
      { provider: "anthropic", smol: "openrouter/m" },
      null,
      providerList,
      "global",
      { stored: { anthropic: true, openrouter: false } },
    );
    expect(withStored[0].status).toBe("ok");
    expect(withStored[0].detail).toBe("anthropic: stored key");
    expect(withStored[1].status).toBe("missing");
    const withEnv = providerRows(
      { provider: "anthropic", smol: "openrouter/m" },
      null,
      providerList,
      "global",
      { env: { anthropic: false, openrouter: true } },
    );
    expect(withEnv[0].status).toBe("missing");
    expect(withEnv[1].status).toBe("ok");
    expect(withEnv[1].detail).toBe("openrouter: env var present");
    // A stored key outranks an auth.json entry and the env var.
    const both = providerRows(
      { provider: "anthropic", smol: "anthropic/m" },
      { anthropic: "oauth" } as const,
      providerList,
      "global",
      { stored: { anthropic: true }, env: { anthropic: true } },
    );
    expect(both[0].detail).toBe("anthropic: stored key");
  });

  it("asks an unsigned non-cloud OAuth provider to sign in", () => {
    const rows = providerRows(
      { provider: "openai-codex", smol: "bppc/m" },
      null,
      [],
    );
    expect(rows[0].status).toBe("missing");
    expect(rows[0].detail).toBe("openai-codex is not signed in");
    expect(rows[0].action).toEqual({
      label: "Sign in",
      kind: "sign-in",
      provider: "openai-codex",
    });
  });

  it("asks a cloud provider with nothing set to add a key", () => {
    const rows = providerRows(
      { provider: "openrouter", smol: "anthropic/m" },
      {},
      providerList,
      "global",
      { stored: { openrouter: false, anthropic: false } },
    );
    expect(rows[0].status).toBe("missing");
    expect(rows[0].detail).toBe("openrouter: not set (add one under Cloud keys)");
    expect(rows[0].action).toEqual({
      label: "Add key",
      kind: "add-key",
      provider: "openrouter",
    });
    // The smol role reuses the cloud branch for anthropic.
    expect(rows[1].action?.kind).toBe("add-key");
    expect(rows[1].action?.provider).toBe("anthropic");
  });

  it("treats unlisted providers as needing no auth.json entry", () => {
    const rows = providerRows({ provider: "bppc", smol: "local/m" }, null, []);
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(rows[0].detail).toBe("bppc: no key required");
  });

  it("reports an omlx role through the stored-key path", () => {
    const rows = providerRows({ provider: "bppc", smol: "omlx/m" }, null, []);
    expect(rows[1].status).toBe("missing");
    expect(rows[1].detail).toBe("omlx: not set (add one under Cloud keys)");
    const stored = providerRows(
      { provider: "bppc", smol: "omlx/m" },
      null,
      [],
      "global",
      { stored: { omlx: true } },
    );
    expect(stored[1].status).toBe("ok");
    expect(stored[1].detail).toBe("omlx: stored key");
  });

  it("is ok when omlx falls back to the launcher's settings.json key", () => {
    const rows = providerRows(
      { provider: "bppc", smol: "omlx/m" },
      null,
      [],
      "global",
      { local: { omlx: "fallback" } },
    );
    expect(rows[1].status).toBe("ok");
    expect(rows[1].detail).toBe("omlx: key from ~/.omlx/settings.json");
  });

  it("asks a local endpoint with no key anywhere to add one", () => {
    const rows = providerRows(
      { provider: "bppc", smol: "omlx/m" },
      null,
      [],
      "global",
      { local: { omlx: "none" } },
    );
    expect(rows[1].status).toBe("missing");
    expect(rows[1].detail).toBe("omlx: not set (add one under Cloud keys)");
    expect(rows[1].action).toEqual({
      label: "Add key",
      kind: "add-key",
      provider: "omlx",
    });
  });

  it("is ok when a local endpoint carries a real key in the template", () => {
    const rows = providerRows(
      { provider: "bppc", smol: "omlx/m" },
      null,
      [],
      "global",
      { local: { bppc: "template", omlx: "stored" } },
    );
    expect(rows[0].status).toBe("ok");
    expect(rows[0].detail).toBe("bppc: key in models.json.tmpl");
    expect(rows[1].detail).toBe("omlx: key stored in the app");
  });

  it("labels the role rows global by default and with the passed scope", () => {
    const rows = providerRows({ provider: "bppc", smol: "omlx/m" }, null, []);
    expect(rows[0].label).toBe("Orchestrator provider (global)");
    expect(rows[1].label).toBe("Subagent provider (global)");
    const scoped = providerRows(
      { provider: "bppc", smol: "omlx/m" },
      null,
      [],
      "for demo",
    );
    expect(scoped[0].label).toBe("Orchestrator provider (for demo)");
    expect(scoped[1].label).toBe("Subagent provider (for demo)");
  });
});

describe("effectiveRoles and rolesScopeLabel", () => {
  const globalPrefs = {
    provider: "bppc",
    model: "qwen3.8-27b",
    thinking: "xhigh" as const,
    smol: "omlx/Qwen3.6-35B",
  };

  it("merges the project override file over the global prefs", () => {
    const roles = effectiveRoles(globalPrefs, {
      piProvider: "anthropic",
      piSmol: "openai/gpt-4o-mini",
    });
    expect(roles).toEqual({ provider: "anthropic", smol: "openai/gpt-4o-mini" });
  });

  it("keeps the global roles when the override file omits or is unreadable", () => {
    expect(effectiveRoles(globalPrefs, null)).toEqual({
      provider: "bppc",
      smol: "omlx/Qwen3.6-35B",
    });
    expect(effectiveRoles(globalPrefs, "not json")).toEqual({
      provider: "bppc",
      smol: "omlx/Qwen3.6-35B",
    });
    // Wrong-typed keys are ignored rather than blanking the session.
    expect(effectiveRoles(globalPrefs, { piProvider: 7 })).toEqual({
      provider: "bppc",
      smol: "omlx/Qwen3.6-35B",
    });
  });

  it("labels the scope for the cwd basename and global without one", () => {
    expect(rolesScopeLabel("/home/me/work/demo")).toBe("for demo");
    expect(rolesScopeLabel("C:\\repo\\terax")).toBe("for terax");
    expect(rolesScopeLabel("/proj/")).toBe("for proj");
    expect(rolesScopeLabel(null)).toBe("global");
    expect(rolesScopeLabel("")).toBe("global");
  });
});

describe("chosenLocalEndpoints and probeUrlFor", () => {
  const endpoints = [
    {
      id: "bppc",
      baseUrl: "http://10.0.0.9:8080/v1/",
      apiKey: "",
      modelId: "m",
      name: "",
      contextWindow: 0,
      maxTokens: 0,
    },
  ];

  it("picks only the endpoints the roles reference", () => {
    expect(chosenLocalEndpoints(roles)).toEqual(["bppc", "omlx"]);
    expect(
      chosenLocalEndpoints({ provider: "bppc", smol: "anthropic/m" }),
    ).toEqual(["bppc"]);
    expect(
      chosenLocalEndpoints({ provider: "anthropic", smol: "anthropic/m" }),
    ).toEqual([]);
  });

  it("probes <base>/health for bppc from the endpoints settings", () => {
    expect(probeUrlFor(endpoints, "bppc")).toBe(
      "http://10.0.0.9:8080/health",
    );
  });

  it("falls back to defaults and appends /api/status for omlx", () => {
    expect(probeUrlFor(endpoints, "omlx")).toBe(
      "http://127.0.0.1:8000/api/status",
    );
    expect(probeUrlFor(null, "omlx")).toBe("http://127.0.0.1:8000/api/status");
    expect(probeUrlFor(null, "bppc")).toBe("http://127.0.0.1:8080/health");
  });

  it("fills the bppc __BPPC_HOST__ placeholder the way a render would", () => {
    const tmpl = [
      {
        id: "bppc",
        baseUrl: "http://__BPPC_HOST__:8080/v1",
        apiKey: "__OMLX_KEY__",
        modelId: "m",
        name: "",
        contextWindow: 0,
        maxTokens: 0,
      },
    ];
    expect(probeUrlFor(tmpl, "bppc", "100.100.100.100")).toBe(
      "http://100.100.100.100:8080/health",
    );
    // Blank or unset pref keeps the render's 127.0.0.1 fallback.
    expect(probeUrlFor(tmpl, "bppc", "  ")).toBe(
      "http://127.0.0.1:8080/health",
    );
    expect(probeUrlFor(tmpl, "bppc")).toBe(
      "http://127.0.0.1:8080/health",
    );
    // The placeholder substitution never touches an explicit host.
    expect(probeUrlFor(endpoints, "bppc", "100.100.100.100")).toBe(
      "http://10.0.0.9:8080/health",
    );
  });
});

describe("endpointRows", () => {
  const health: PiHealthMap = {
    bppc: { ok: true, status: 200, ms: 12, error: null },
    omlx: { ok: false, status: null, ms: 4021, error: "connection refused" },
  };

  it("is ok when the probe answered and red with the error otherwise", () => {
    const rows = endpointRows(roles, null, health);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].detail).toBe(
      "http://127.0.0.1:8080/health answered in 12 ms",
    );
    expect(rows[1].status).toBe("missing");
    expect(rows[1].detail).toBe(
      "http://127.0.0.1:8000/api/status: connection refused",
    );
    expect(rows[1].action?.kind).toBe("focus-endpoints");
  });

  it("marks an endpoint that was never probed as missing", () => {
    const rows = endpointRows(roles, null, {});
    expect(rows.map((r) => r.status)).toEqual(["missing", "missing"]);
    expect(rows[0].detail).toContain("not probed");
  });

  it("emits no rows when no local endpoint is chosen", () => {
    expect(
      endpointRows(
        { provider: "anthropic", smol: "anthropic/m" },
        null,
        health,
      ),
    ).toEqual([]);
  });
});

describe("summarize", () => {
  it("says Ready only when every row is green", () => {
    expect(summarize([]).verdict).toBe("Ready");
    const all = buildRows({
      paths: bundledPaths,
      roles,
      authStatusMap: null,
      providerList: [],
      endpoints: null,
      health: {
        bppc: { ok: true, status: 200, ms: 5, error: null },
        omlx: { ok: true, status: 200, ms: 7, error: null },
      },
      // The omlx subagent role is managed like the cloud keys now.
      cloudKeys: { stored: { omlx: true } },
    });
    const summary = summarize(all);
    expect(summary).toMatchObject({
      ok: all.length,
      warn: 0,
      missing: 0,
      verdict: "Ready",
    });
  });

  it("says Ready with warnings when only amber rows remain", () => {
    const checkoutPaths: PiResolvedPaths = {
      ...bundledPaths,
      pi: { path: "/c/bin/pi", source: "checkout", candidates: [] },
    };
    const rows = pathRows(checkoutPaths);
    expect(summarize(rows).verdict).toBe("Ready with warnings");
    expect(summarize(rows)).toMatchObject({ ok: 2, warn: 1, missing: 0 });
  });

  it("counts every non-green row in the fix verdict", () => {
    const summary = summarize([
      ...pathRows({
        ...bundledPaths,
        agentDir: { path: null, source: "missing", candidates: [] },
        runtimeAgentDir: { path: null, source: "missing", seeded: false },
      }),
      ...providerRows({ provider: "", smol: "" }, null, []),
    ]);
    expect(summary.missing).toBe(3);
    expect(summary.verdict).toBe("3 things to fix");
  });

  it("uses the singular for one fix", () => {
    expect(
      summarize([{ id: "x", label: "x", status: "missing", detail: "" }])
        .verdict,
    ).toBe("1 thing to fix");
  });
});

describe("buildRows", () => {
  it("orders paths, providers, then endpoints", () => {
    const rows = buildRows({
      paths: bundledPaths,
      roles,
      authStatusMap: null,
      providerList: [],
      endpoints: null,
      health: { omlx: { ok: false, status: null, ms: 0, error: "down" } },
    });
    expect(rows.map((r) => r.id)).toEqual([
      "path-pi",
      "path-agent",
      "path-agentDir",
      "provider-orchestrator",
      "provider-smol",
      "endpoint-bppc",
      "endpoint-omlx",
    ]);
  });
});

describe("probeUrlFor strips the /v1 base", () => {
  it("probes the server root for omlx and bppc", () => {
    const endpoints = [
      { id: "omlx", baseUrl: "http://127.0.0.1:8000/v1" },
      { id: "bppc", baseUrl: "http://__BPPC_HOST__:8080/v1" },
    ] as never;
    expect(probeUrlFor(endpoints, "omlx")).toBe("http://127.0.0.1:8000/api/status");
    expect(probeUrlFor(endpoints, "bppc", "10.0.0.5")).toBe("http://10.0.0.5:8080/health");
  });
});
