import { describe, expect, it } from "vitest";
import {
  buildRows,
  chosenLocalEndpoints,
  endpointRows,
  pathRows,
  probeUrlFor,
  providerRows,
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
};

const roles: PiRoles = { provider: "bppc", smol: "omlx/Qwen3.6-35B" };

describe("pathRows", () => {
  it("reports bundled and pref wins as ok with the winning path", () => {
    const rows = pathRows({
      ...bundledPaths,
      pi: {
        path: "/custom/pi",
        source: "pref",
        candidates: ["/custom/pi", "/app/exe/pi"],
      },
    });
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(rows[0].detail).toBe("/custom/pi");
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
    });
    expect(rows[0].status).toBe("warn");
    expect(rows[0].detail).toBe(
      "using the efficient-pi checkout at /checkout/bin/pi",
    );
    expect(rows[0].action).toEqual({
      label: "Open paths",
      kind: "focus-paths",
    });
  });

  it("reports missing with the first two candidates", () => {
    const rows = pathRows({
      ...bundledPaths,
      agentDir: {
        path: null,
        source: "missing",
        candidates: ["/first", "/second", "/third"],
      },
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
      anthropic: { type: "oauth", access: "token" },
      openrouter: { type: "api_key", key: "sk-or" },
    };
    const rows = providerRows(
      { provider: "anthropic", smol: "openrouter/m" },
      entries,
      providerList,
    );
    expect(rows[0].status).toBe("ok");
    expect(rows[0].detail).toBe("anthropic: OAuth token");
    expect(rows[1].status).toBe("ok");
    expect(rows[1].detail).toBe("openrouter: key stored");
  });

  it("asks an unsigned OAuth provider to sign in", () => {
    const rows = providerRows(
      { provider: "anthropic", smol: "bppc/m" },
      null,
      providerList,
    );
    expect(rows[0].status).toBe("missing");
    expect(rows[0].detail).toBe("anthropic is not signed in");
    expect(rows[0].action).toEqual({
      label: "Sign in",
      kind: "sign-in",
      provider: "anthropic",
    });
  });

  it("asks a key provider with no stored key to add one", () => {
    const rows = providerRows(
      { provider: "openrouter", smol: "anthropic/m" },
      {},
      providerList,
    );
    expect(rows[0].status).toBe("missing");
    expect(rows[0].detail).toBe(
      "openrouter has no key (env OPENROUTER_API_KEY)",
    );
    expect(rows[0].action).toEqual({
      label: "Add key",
      kind: "add-key",
      provider: "openrouter",
    });
    // The smol role reuses the OAuth branch for anthropic.
    expect(rows[1].action?.kind).toBe("sign-in");
  });

  it("treats unlisted providers as needing no auth.json entry", () => {
    const rows = providerRows({ provider: "bppc", smol: "omlx/m" }, null, []);
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(rows[0].detail).toBe("bppc: no key required");
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
      "http://10.0.0.9:8080/v1/health",
    );
  });

  it("falls back to defaults and appends /api/status for omlx", () => {
    expect(probeUrlFor(endpoints, "omlx")).toBe(
      "http://127.0.0.1:8000/api/status",
    );
    expect(probeUrlFor(null, "omlx")).toBe("http://127.0.0.1:8000/api/status");
    expect(probeUrlFor(null, "bppc")).toBe("http://127.0.0.1:8080/health");
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
      authEntries: null,
      providerList: [],
      endpoints: null,
      health: {
        bppc: { ok: true, status: 200, ms: 5, error: null },
        omlx: { ok: true, status: 200, ms: 7, error: null },
      },
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
      authEntries: null,
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
