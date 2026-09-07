// Pure helpers behind the Settings "Pi" tab: preference resolution (global
// prefs + per-workspace .pi/terax.json), pi CLI table parsing, auth.json
// editing, and models.json.tmpl round-tripping. No Tauri imports here so the
// logic stays unit-testable in plain node.

export const PI_THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export type PiRuntimePrefs = {
  /** Dir holding bin/efficient-pi (or bin/pi); a leading $HOME/ expands Rust-side. */
  launcherDir: string;
  /** Efficient-pi board CLI; a leading $HOME/ expands in the shell. */
  boardBin: string;
  /** Harness agent binary for human keystone board actions. */
  agentBin: string;
  /** pi agent dir; empty lets the launcher default apply. */
  agentDir: string;
  provider: string;
  model: string;
  thinking: PiThinkingLevel;
  /** Subagent model as provider/model with an optional :thinking suffix. */
  smol: string;
};

export const PI_PREF_DEFAULTS: PiRuntimePrefs = {
  launcherDir: "$HOME/Documents/Work/Lab/efficient-pi",
  boardBin: "$HOME/Documents/Work/Lab/efficient-pi/bin/board",
  agentBin: "$HOME/Documents/Work/harness/target/release/agent",
  agentDir: "",
  // Roles start empty so a fresh install has no provider until the user picks
  // one; piSpawnEnv omits empty values so the launcher defaults stay in charge.
  provider: "",
  model: "",
  thinking: "xhigh",
  smol: "",
};

/** Providers that authenticate through pi's interactive /login flow. */
export const PI_OAUTH_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "google-gemini-cli",
  "google-antigravity",
  "kimi-for-coding",
  "github-copilot",
  "gitlab",
] as const;

/** Layout listens for this and opens a terminal running `command` in `cwd`. */
export const PI_OPEN_TERMINAL_EVENT = "pi:open-terminal";

export type PiSignInPayload = {
  cwd: string;
  command: string;
  hint: string;
};

/** Exact payload contract for the pi:open-terminal listener (layout worker). */
export function piSignInPayload(launcherDir: string): PiSignInPayload {
  return {
    cwd: launcherDir,
    command: piSignInCommand(launcherDir),
    hint: "Type /login <provider> in the pi prompt",
  };
}

/** Interactive pi command for /login; paths are quoted, $HOME survives quoting. */
export function piSignInCommand(launcherDir: string): string {
  return `PI_CODING_AGENT_DIR="${launcherDir}/pi-home/agent" "${launcherDir}/bin/pi"`;
}

const WORKSPACE_KEYS = {
  launcherDir: "piLauncherDir",
  boardBin: "piBoardBin",
  agentBin: "piAgentBin",
  agentDir: "piAgentDir",
  provider: "piProvider",
  model: "piModel",
  thinking: "piThinking",
  smol: "piSmol",
} as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asThinking(v: unknown): PiThinkingLevel | null {
  return (PI_THINKING_LEVELS as readonly string[]).includes(v as string)
    ? (v as PiThinkingLevel)
    : null;
}

/**
 * Merges defaults <- global prefs <- per-workspace overrides. The workspace
 * file is the parsed `<cwd>/.pi/terax.json`; it uses the same keys as the
 * global preferences (piLauncherDir, piBoardBin, ...) and every key is
 * optional. Values of the wrong type (including an unknown thinking level or
 * a non-object file) are ignored rather than rejected, so one bad key never
 * blanks a session.
 */
export function resolvePiPrefs(
  global: Partial<PiRuntimePrefs>,
  workspaceJson: unknown,
): PiRuntimePrefs {
  const resolved: PiRuntimePrefs = { ...PI_PREF_DEFAULTS };
  const apply = (field: string, value: unknown): void => {
    const valid = field === "thinking" ? asThinking(value) : asString(value);
    if (valid !== null) {
      (resolved as Record<string, unknown>)[field] = valid;
    }
  };
  // Global prefs use the plain field names; the workspace file uses the
  // pi-prefixed preference keys.
  for (const field of Object.keys(WORKSPACE_KEYS)) {
    apply(field, (global as Record<string, unknown>)[field]);
  }
  if (isObject(workspaceJson)) {
    for (const [field, key] of Object.entries(WORKSPACE_KEYS)) {
      apply(field, workspaceJson[key]);
    }
  }
  return resolved;
}

/**
 * Spawn env for one pi session: the EFFICIENT_PI_* variables the launcher
 * reads, plus PI_CODING_AGENT_DIR only when the user set a custom agent dir.
 * Empty values are omitted rather than exported, because an empty export
 * would override the checkout launcher's own defaults for unset variables.
 * endpoints carries the models.json.tmpl render overrides (bppc host, oMLX
 * key); no pref stores either today, so the caller passes what it has and
 * the launcher falls back for the rest. A leading $HOME in agentDir is
 * expanded Rust-side before spawn.
 */
export function piSpawnEnv(
  prefs: PiRuntimePrefs,
  customAgentDir?: string | null,
  endpoints?: { bppcHost?: string | null; omlxKey?: string | null } | null,
): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (key: string, value: string | null | undefined): void => {
    if (value && value.trim()) env[key] = value;
  };
  set("EFFICIENT_PI_PROVIDER", prefs.provider);
  set("EFFICIENT_PI_MODEL", prefs.model);
  set("EFFICIENT_PI_THINKING", prefs.thinking);
  set("EFFICIENT_PI_SMOL", prefs.smol);
  set("EFFICIENT_PI_BPPC_HOST", endpoints?.bppcHost);
  set("EFFICIENT_PI_OMLX_KEY", endpoints?.omlxKey);
  const dir = customAgentDir?.trim();
  if (dir) env.PI_CODING_AGENT_DIR = dir;
  return env;
}

/// ---------------------------------------------------------------------------
/// `pi_paths` response (Rust twin: launch.rs ResolvedPaths)
/// ---------------------------------------------------------------------------

export type PiPathSource = "pref" | "bundled" | "checkout" | "missing";

export type PiResolvedPath = {
  /** The winning path, or null when source is "missing". */
  path: string | null;
  source: PiPathSource;
  /** Every candidate in precedence order; the useful bit when path is null. */
  candidates: string[];
};

export type PiResolvedPaths = {
  pi: PiResolvedPath;
  agent: PiResolvedPath;
  agentDir: PiResolvedPath;
};

/// ---------------------------------------------------------------------------
/// `pi_prepare` response (Rust twin: launcher.rs PrepareReport)
/// ---------------------------------------------------------------------------

export type PiPrepareStep = {
  /** Launcher step in fixed order: seed, render, root, wiki. */
  name: string;
  ok: boolean;
  detail: string;
};

export type PiPrepareReport = {
  steps: PiPrepareStep[];
  /** Writable per-user agent dir the session must spawn with. */
  agentDir: string;
  /** PI_CODING_AGENT_DIR plus the four EFFICIENT_PI_* values. */
  env: Record<string, string>;
};

/// ---------------------------------------------------------------------------
/// `$HOME` expansion (frontend twin of launch.rs expand_home)
/// ---------------------------------------------------------------------------

/** Expands a leading `$HOME/` (or bare `$HOME`) against `home`; else passthrough. */
export function expandHomePath(path: string, home: string | null): string {
  if (!home) return path;
  const trimmed = home.replace(/\/+$/, "");
  if (path === "$HOME") return trimmed;
  const rest = path.startsWith("$HOME/") ? path.slice("$HOME/".length) : null;
  return rest && rest.length > 0 ? `${trimmed}/${rest}` : path;
}

/// ---------------------------------------------------------------------------
/// `pi --list-providers` parsing
/// ---------------------------------------------------------------------------

export type PiProviderRow = {
  id: string;
  name: string;
  aliases: string[];
  authEnv: string[];
  api: string;
};

function splitList(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses the fixed-width `pi --list-providers` table: a header line, a dash
 * separator whose runs mark the column boundaries, then one row per provider
 * until the first line with an empty id (the trailing "N providers" footer).
 */
export function parsePiProviders(output: string): PiProviderRow[] {
  const lines = output.split("\n");
  const sepIndex = lines.findIndex((l) => /^-+( {2}-+)*\s*$/.test(l));
  if (sepIndex <= 0) return [];
  const columns = [...lines[sepIndex].matchAll(/-+/g)].map((m) => m.index ?? 0);
  if (columns.length < 2) return [];
  const rows: PiProviderRow[] = [];
  for (const line of lines.slice(sepIndex + 1)) {
    const cell = (i: number): string =>
      line
        .slice(
          columns[i],
          i + 1 < columns.length ? columns[i + 1] : line.length,
        )
        .trim();
    const id = cell(0);
    if (!id) break;
    rows.push({
      id,
      name: cell(1),
      aliases: splitList(cell(2)),
      authEnv: splitList(cell(3)),
      api: cell(4),
    });
  }
  return rows;
}

/// ---------------------------------------------------------------------------
/// `pi --list-models` parsing
/// ---------------------------------------------------------------------------

export type PiModelRow = {
  provider: string;
  model: string;
  thinking: boolean;
};

/**
 * Parses `pi --list-models` (no pattern: the `<provider>/` filter drops
 * models.json.tmpl endpoints, so the UI filters the full table client-side).
 * Columns: provider, model, context, max-out, thinking, images. Header and
 * footer lines never split into a provider + model pair and are skipped.
 */
export function parsePiModels(output: string): PiModelRow[] {
  const rows: PiModelRow[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trimEnd().split(/\s{2,}/);
    if (fields.length < 2 || fields[0] === "provider") continue;
    rows.push({
      provider: fields[0],
      model: fields[1],
      thinking: fields[4] === "yes",
    });
  }
  return rows;
}

/** Model ids offered by one provider, in table order. */
export function modelsForProvider(
  rows: PiModelRow[],
  providerId: string,
): string[] {
  return rows
    .filter((r) => r.provider === providerId)
    .map((r) => r.model);
}

/// ---------------------------------------------------------------------------
/// auth.json (verified shape: {"<provider>": {"type":"api_key","key":"..."}})
/// ---------------------------------------------------------------------------

export type PiAuthStatus = "key" | "oauth" | "none";

export function piAuthStatusLabel(status: PiAuthStatus): string {
  return status === "key" ? "key stored" : status === "oauth" ? "OAuth token" : "not set";
}

export function authStatus(entries: unknown, providerId: string): PiAuthStatus {
  if (!isObject(entries)) return "none";
  const entry = entries[providerId];
  if (!isObject(entry)) return "none";
  if (entry.type === "api_key" || typeof entry.key === "string") return "key";
  if (entry.type === "oauth" || typeof entry.access === "string") return "oauth";
  return "none";
}

/** Pure merge: sets `{type:"api_key", key}` for one provider, keeps the rest. */
export function setProviderApiKey(
  entries: unknown,
  providerId: string,
  key: string,
): Record<string, unknown> {
  const base = isObject(entries) ? { ...entries } : {};
  base[providerId] = { type: "api_key", key };
  return base;
}

/** Pure removal: drops one provider entry, keeps the rest. */
export function removeProviderAuth(
  entries: unknown,
  providerId: string,
): Record<string, unknown> {
  if (!isObject(entries)) return {};
  const base = { ...entries };
  delete base[providerId];
  return base;
}

/// ---------------------------------------------------------------------------
/// models.json.tmpl (custom OpenAI-compatible endpoints)
/// ---------------------------------------------------------------------------

export type PiEndpointView = {
  id: string;
  baseUrl: string;
  /** Rendered in, never edited: carries the __OMLX_KEY__ style placeholders. */
  apiKey: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
};

export type PiEndpointsDoc = {
  /** The full parsed template; serialization writes back into this object. */
  data: Record<string, unknown>;
  endpoints: PiEndpointView[];
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parses the rendered template source. Placeholders like __BPPC_HOST__ live
 * inside string values, so plain JSON.parse keeps them intact.
 */
export function parseModelsJsonTmpl(text: string): PiEndpointsDoc {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed)) data = parsed;
  } catch {
    // Unreadable template: start from an empty doc, the next save rewrites it.
  }
  const providers = isObject(data.providers) ? data.providers : {};
  const endpoints: PiEndpointView[] = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!isObject(value)) continue;
    const models = Array.isArray(value.models) ? value.models : [];
    const model = isObject(models[0]) ? models[0] : {};
    endpoints.push({
      id,
      baseUrl: asString(value.baseUrl) ?? "",
      apiKey: asString(value.apiKey) ?? "",
      modelId: asString(model.id) ?? "",
      name: asString(model.name) ?? "",
      contextWindow: num(model.contextWindow),
      maxTokens: num(model.maxTokens),
    });
  }
  return { data, endpoints };
}

/**
 * Writes the edited endpoint views back into the parsed template and renders
 * it. Fields the UI does not edit (apiKey placeholders, reasoning, input,
 * extra models) pass through untouched, so __BPPC_HOST__ and __OMLX_KEY__
 * survive a save. New ids append an openai-completions block.
 */
export function serializeModelsJsonTmpl(
  doc: PiEndpointsDoc,
  endpoints: PiEndpointView[],
): string {
  const providers = isObject(doc.data.providers)
    ? (doc.data.providers as Record<string, unknown>)
    : {};
  for (const ep of endpoints) {
    const id = ep.id.trim();
    if (!id) continue;
    const existing = isObject(providers[id])
      ? (providers[id] as Record<string, unknown>)
      : null;
    const models = existing && Array.isArray(existing.models)
      ? [...existing.models]
      : [];
    const first: Record<string, unknown> = isObject(models[0])
      ? { ...(models[0] as Record<string, unknown>) }
      : { reasoning: true, input: ["text"] };
    first.id = ep.modelId;
    first.name = ep.name;
    first.contextWindow = ep.contextWindow;
    first.maxTokens = ep.maxTokens;
    models[0] = first;
    const block: Record<string, unknown> = existing
      ? { ...existing }
      : { api: "openai-completions", apiKey: "" };
    block.baseUrl = ep.baseUrl;
    block.models = models;
    providers[id] = block;
  }
  return `${JSON.stringify({ ...doc.data, providers }, null, 2)}\n`;
}

/** Blank view for "Add endpoint"; the id field is filled in by the user. */
export function blankEndpoint(): PiEndpointView {
  return {
    id: "",
    baseUrl: "",
    apiKey: "",
    modelId: "",
    name: "",
    contextWindow: 0,
    maxTokens: 0,
  };
}
