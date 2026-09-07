// Pure first-run check builders behind the Pi settings panel: turn the
// pi_paths result, auth.json entries, the pi --list-providers table and the
// local endpoint health probes into green, amber or red rows. No Tauri
// imports here so the logic stays unit-testable in plain node.

import {
  authStatus,
  piAuthStatusLabel,
  PI_OAUTH_PROVIDERS,
  type PiEndpointView,
  type PiProviderRow,
  type PiResolvedPaths,
} from "@/modules/pi/lib/providers";

export type CheckStatus = "ok" | "warn" | "missing";

export type CheckActionKind =
  | "focus-paths"
  | "focus-roles"
  | "focus-endpoints"
  | "sign-in"
  | "add-key";

export type CheckRow = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  action?: { label: string; kind: CheckActionKind; provider?: string };
};

/** The two role values the panel checks: prefs.provider and prefs.smol. */
export type PiRoles = { provider: string; smol: string };

/** Twin of the Rust pi_health response (health.rs HealthResult). */
export type PiHealthResult = {
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
};

/** Health probe outcomes keyed by endpoint id (bppc, omlx). */
export type PiHealthMap = Record<string, PiHealthResult>;

const PATH_ROWS: Array<{ key: keyof PiResolvedPaths; label: string }> = [
  { key: "pi", label: "pi binary" },
  { key: "agent", label: "agent binary" },
  { key: "agentDir", label: "agent dir" },
];

/**
 * One row per resolved path. Bundled and pref wins are green, the checkout
 * fallback warns (it breaks on a fresh machine), and missing lists the first
 * two candidates so the reader knows what to create.
 */
export function pathRows(paths: PiResolvedPaths): CheckRow[] {
  return PATH_ROWS.map(({ key, label }) => {
    const id = `path-${key}`;
    const entry = paths[key];
    if (entry.source === "missing") {
      return {
        id,
        label,
        status: "missing",
        detail: entry.candidates.slice(0, 2).join(" or "),
        action: { label: "Open paths", kind: "focus-paths" },
      };
    }
    if (entry.source === "checkout") {
      return {
        id,
        label,
        status: "warn",
        detail: `using the efficient-pi checkout at ${entry.path ?? ""}`,
        action: { label: "Open paths", kind: "focus-paths" },
      };
    }
    return { id, label, status: "ok", detail: entry.path ?? "" };
  });
}

/** Subagent role value is provider/model; the endpoint matters, not the model. */
function smolProvider(smol: string): string {
  return smol.split("/")[0].trim();
}

/**
 * One row per role (orchestrator, subagent). A provider is green when it
 * holds a key or OAuth token, or needs no auth.json entry at all: endpoint
 * providers like bppc and omlx carry their key in models.json.tmpl.
 */
export function providerRows(
  roles: PiRoles,
  authEntries: unknown,
  providerList: PiProviderRow[],
): CheckRow[] {
  const roleList = [
    {
      id: "provider-orchestrator",
      label: "Orchestrator provider",
      provider: roles.provider.trim(),
    },
    {
      id: "provider-smol",
      label: "Subagent provider",
      provider: smolProvider(roles.smol),
    },
  ];
  return roleList.map(({ id, label, provider }) => {
    if (!provider) {
      return {
        id,
        label,
        status: "missing",
        detail: "no provider chosen",
        action: { label: "Open roles", kind: "focus-roles" },
      };
    }
    const stored = authStatus(authEntries, provider);
    if (stored !== "none") {
      return {
        id,
        label,
        status: "ok",
        detail: `${provider}: ${piAuthStatusLabel(stored)}`,
      };
    }
    const isOAuth = (PI_OAUTH_PROVIDERS as readonly string[]).includes(
      provider,
    );
    if (isOAuth) {
      return {
        id,
        label,
        status: "missing",
        detail: `${provider} is not signed in`,
        action: { label: "Sign in", kind: "sign-in", provider },
      };
    }
    const listed = providerList.find((p) => p.id === provider);
    if (listed && listed.authEnv.length > 0) {
      return {
        id,
        label,
        status: "missing",
        detail: `${provider} has no key (env ${listed.authEnv.join(", ")})`,
        action: { label: "Add key", kind: "add-key", provider },
      };
    }
    return { id, label, status: "ok", detail: `${provider}: no key required` };
  });
}

export const PI_LOCAL_ENDPOINTS = ["bppc", "omlx"] as const;

/** Providers among bppc and omlx the resolved roles would actually use. */
export function chosenLocalEndpoints(roles: PiRoles): string[] {
  const orchestrator = roles.provider.trim();
  const smol = smolProvider(roles.smol);
  return PI_LOCAL_ENDPOINTS.filter((id) => id === orchestrator || id === smol);
}

/**
 * Probe URL for one local endpoint: `<base>/health` for the bppc proxy and
 * `/api/status` for oMLX. The base comes from the endpoints settings entry;
 * the fallbacks match the bundled models.json.tmpl defaults.
 */
export function probeUrlFor(
  endpoints: PiEndpointView[] | null,
  id: string,
): string {
  const path = id === "bppc" ? "/health" : "/api/status";
  const fallback =
    id === "bppc" ? "http://127.0.0.1:8080" : "http://127.0.0.1:8000";
  const base = endpoints
    ?.find((ep) => ep.id === id)
    ?.baseUrl.trim()
    .replace(/\/+$/, "");
  return `${base && base.length > 0 ? base : fallback}${path}`;
}

/**
 * One row per chosen local endpoint, green only when its probe answered
 * successfully. Untested or unreachable endpoints are red with the reason.
 */
export function endpointRows(
  roles: PiRoles,
  endpoints: PiEndpointView[] | null,
  health: PiHealthMap,
): CheckRow[] {
  return chosenLocalEndpoints(roles).map((id) => {
    const url = probeUrlFor(endpoints, id);
    const result = health[id];
    if (result?.ok) {
      return {
        id: `endpoint-${id}`,
        label: `${id} endpoint`,
        status: "ok",
        detail: `${url} answered in ${result.ms} ms`,
      };
    }
    const why = result
      ? (result.error ?? `HTTP ${result.status ?? "?"}`)
      : "not probed";
    return {
      id: `endpoint-${id}`,
      label: `${id} endpoint`,
      status: "missing",
      detail: `${url}: ${why}`,
      action: { label: "Open endpoints", kind: "focus-endpoints" },
    };
  });
}

/** All rows in panel order: paths, providers, local endpoints. */
export function buildRows(input: {
  paths: PiResolvedPaths;
  roles: PiRoles;
  authEntries: unknown;
  providerList: PiProviderRow[];
  endpoints: PiEndpointView[] | null;
  health: PiHealthMap;
}): CheckRow[] {
  return [
    ...pathRows(input.paths),
    ...providerRows(input.roles, input.authEntries, input.providerList),
    ...endpointRows(input.roles, input.endpoints, input.health),
  ];
}

export type PiCheckSummary = {
  ok: number;
  warn: number;
  missing: number;
  verdict: string;
};

/** Counts plus the one-line verdict the panel opens with. */
export function summarize(rows: CheckRow[]): PiCheckSummary {
  const counts = { ok: 0, warn: 0, missing: 0 };
  for (const row of rows) counts[row.status] += 1;
  const fixes = counts.missing + counts.warn;
  const verdict =
    counts.missing === 0 && counts.warn === 0
      ? "Ready"
      : counts.missing === 0
        ? "Ready with warnings"
        : `${fixes} ${fixes === 1 ? "thing" : "things"} to fix`;
  return { ...counts, verdict };
}
