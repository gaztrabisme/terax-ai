import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authStatus,
  blankEndpoint,
  expandHomePath,
  modelAcceptsImages,
  modelsForProvider,
  modelRowsForProvider,
  parseModelsJsonTmpl,
  parsePiModels,
  parsePiProviders,
  piSignInCommand,
  piSignInPayload,
  piSpawnEnv,
  PI_PREF_DEFAULTS,
  removeProviderAuth,
  resolvePiPrefs,
  serializeModelsJsonTmpl,
  setProviderApiKey,
  type PiEndpointView,
} from "./providers";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "__fixtures__", name), "utf8");

describe("resolvePiPrefs", () => {
  it("falls back to the module defaults for empty inputs", () => {
    expect(resolvePiPrefs({}, null)).toEqual(PI_PREF_DEFAULTS);
  });

  it("returns the empty role defaults for an empty store", () => {
    const resolved = resolvePiPrefs(
      { provider: "", model: "", smol: "", thinking: "xhigh" },
      null,
    );
    expect(resolved.provider).toBe("");
    expect(resolved.model).toBe("");
    expect(resolved.smol).toBe("");
    expect(resolved.thinking).toBe("xhigh");
  });

  it("applies global prefs over defaults", () => {
    const resolved = resolvePiPrefs(
      { provider: "openai", model: "gpt-4o", piSmol: undefined } as never,
      null,
    );
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.thinking).toBe(PI_PREF_DEFAULTS.thinking);
  });

  it("workspace terax.json wins over global values", () => {
    const resolved = resolvePiPrefs(
      { provider: "openai", model: "gpt-4o" },
      { piProvider: "anthropic", piModel: "claude", piThinking: "low" },
    );
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude");
    expect(resolved.thinking).toBe("low");
  });

  it("keeps global values for keys the workspace file omits", () => {
    const resolved = resolvePiPrefs(
      { provider: "openai", smol: "openai/gpt-4o-mini" },
      { piModel: "gpt-4.1" },
    );
    expect(resolved.model).toBe("gpt-4.1");
    expect(resolved.provider).toBe("openai");
    expect(resolved.smol).toBe("openai/gpt-4o-mini");
  });

  it("ignores wrong-typed values and unknown thinking levels", () => {
    const resolved = resolvePiPrefs(
      { launcherDir: 42 as unknown as string },
      {
        piProvider: 7,
        piThinking: "ultra",
        piModel: null,
        piSmol: ["x"],
      },
    );
    expect(resolved).toEqual(PI_PREF_DEFAULTS);
  });

  it("ignores a non-object workspace file but keeps global prefs", () => {
    const resolved = resolvePiPrefs(
      { provider: "openai" },
      "[1,2,3]",
    );
    expect(resolved.provider).toBe("openai");
  });

  it("accepts an empty launcherDir as the workspace-local fallback", () => {
    const resolved = resolvePiPrefs({ launcherDir: "" }, {});
    expect(resolved.launcherDir).toBe("");
  });

  it("carries the bppc host from global prefs and workspace overrides", () => {
    expect(PI_PREF_DEFAULTS.bppcHost).toBe("");
    const resolved = resolvePiPrefs(
      { bppcHost: "100.100.100.100" },
      { piBppcHost: "10.0.0.9" },
    );
    expect(resolved.bppcHost).toBe("10.0.0.9");
    // A workspace value of the wrong type is ignored like every other key.
    expect(resolvePiPrefs({}, { piBppcHost: 42 }).bppcHost).toBe("");
  });
});

describe("piSpawnEnv", () => {
  it("omits EFFICIENT_PI_PROVIDER/MODEL/SMOL when the resolved prefs are empty", () => {
    const resolved = resolvePiPrefs({}, null);
    expect(resolved.provider).toBe("");
    const env = piSpawnEnv(resolved, null);
    expect(env.EFFICIENT_PI_PROVIDER).toBeUndefined();
    expect(env.EFFICIENT_PI_MODEL).toBeUndefined();
    expect(env.EFFICIENT_PI_SMOL).toBeUndefined();
    // Thinking keeps its non-empty default, so it always exports.
    expect(env.EFFICIENT_PI_THINKING).toBe(PI_PREF_DEFAULTS.thinking);
  });

  it("exports the EFFICIENT_PI_* role values when they are set", () => {
    const resolved = resolvePiPrefs(
      { provider: "bppc", model: "qwen3.8-27b", smol: "omlx/m" },
      null,
    );
    expect(piSpawnEnv(resolved, null)).toEqual({
      EFFICIENT_PI_PROVIDER: "bppc",
      EFFICIENT_PI_MODEL: "qwen3.8-27b",
      EFFICIENT_PI_THINKING: "xhigh",
      EFFICIENT_PI_SMOL: "omlx/m",
    });
  });

  it("exports the endpoint overrides only when they are set", () => {
    const resolved = resolvePiPrefs({}, null);
    const base = piSpawnEnv(resolved, null);
    // Blank or unset members are omitted so the launcher defaults survive.
    expect(piSpawnEnv(resolved, null, { bppcHost: "  ", omlxKey: null })).toEqual(
      base,
    );
    expect(piSpawnEnv(resolved, null, {}).EFFICIENT_PI_BPPC_HOST).toBeUndefined();
    expect(
      piSpawnEnv(resolved, null, { bppcHost: "10.0.0.9" }).EFFICIENT_PI_OMLX_KEY,
    ).toBeUndefined();
    expect(
      piSpawnEnv(resolved, null, { bppcHost: "10.0.0.9", omlxKey: "sk-omlx" }),
    ).toEqual({
      EFFICIENT_PI_THINKING: PI_PREF_DEFAULTS.thinking,
      EFFICIENT_PI_BPPC_HOST: "10.0.0.9",
      EFFICIENT_PI_OMLX_KEY: "sk-omlx",
    });
  });

  it("exports the pref bppc host only when it is set", () => {
    const blank = resolvePiPrefs({}, null);
    // The blank pref is omitted so the render's 127.0.0.1 fallback survives.
    expect(
      piSpawnEnv(blank, null, { bppcHost: blank.bppcHost })
        .EFFICIENT_PI_BPPC_HOST,
    ).toBeUndefined();
    const hosted = resolvePiPrefs({}, { piBppcHost: "100.100.100.100" });
    expect(
      piSpawnEnv(hosted, null, { bppcHost: hosted.bppcHost })
        .EFFICIENT_PI_BPPC_HOST,
    ).toBe("100.100.100.100");
    // The oMLX key stays backend-side: the caller never passes one.
    expect(
      piSpawnEnv(hosted, null, { bppcHost: hosted.bppcHost, omlxKey: null })
        .EFFICIENT_PI_OMLX_KEY,
    ).toBeUndefined();
  });

  it("sets PI_CODING_AGENT_DIR only for a custom agent dir", () => {
    const resolved = resolvePiPrefs({}, null);
    expect(
      piSpawnEnv(resolved, "  ").PI_CODING_AGENT_DIR,
    ).toBeUndefined();
    expect(piSpawnEnv(resolved, "$HOME/pi-agents/main")).toEqual({
      ...piSpawnEnv(resolved, null),
      PI_CODING_AGENT_DIR: "$HOME/pi-agents/main",
    });
  });
});

describe("expandHomePath", () => {
  it("mirrors the Rust expand_home contract", () => {
    expect(expandHomePath("$HOME/work/pi", "/u/me")).toBe("/u/me/work/pi");
    expect(expandHomePath("$HOME/work/pi", "/u/me/")).toBe("/u/me/work/pi");
    expect(expandHomePath("$HOME", "/u/me")).toBe("/u/me");
    expect(expandHomePath("/abs/bin", "/u/me")).toBe("/abs/bin");
    expect(expandHomePath("$HOME/x", null)).toBe("$HOME/x");
    expect(expandHomePath("home/$HOME/x", "/u/me")).toBe("home/$HOME/x");
  });
});

describe("parsePiProviders", () => {
  const rows = parsePiProviders(fixture("pi-list-providers.sample.txt"));

  it("parses every provider row from the saved sample", () => {
    expect(rows.length).toBe(102);
  });

  it("splits comma lists in the aliases and auth env columns", () => {
    const alibaba = rows.find((r) => r.id === "alibaba");
    expect(alibaba?.name).toBe("Alibaba (Qwen)");
    expect(alibaba?.aliases).toEqual(["dashscope", "qwen"]);
    expect(alibaba?.authEnv).toEqual(["DASHSCOPE_API_KEY", "QWEN_API_KEY"]);
    expect(alibaba?.api).toBe("openai-completions");
  });

  it("keeps empty cells empty for OAuth-only providers", () => {
    const gemini = rows.find((r) => r.id === "google-gemini-cli");
    expect(gemini?.authEnv).toEqual([]);
    expect(gemini?.api).toBe("-");
  });

  it("stops before the trailing footer line", () => {
    expect(rows[rows.length - 1]?.id).toBe("zhipuai-coding-plan");
  });

  it("returns an empty list for untable output", () => {
    expect(parsePiProviders("pi: invalid usage\n")).toEqual([]);
  });
});

describe("parsePiModels", () => {
  const rows = parsePiModels(fixture("pi-list-models.sample.txt"));

  it("parses model rows including models.json.tmpl endpoints", () => {
    expect(rows.find((r) => r.provider === "bppc")).toEqual({
      provider: "bppc",
      model: "qwen3.8-27b",
      context: "73.7K",
      maxOut: "32.8K",
      thinking: true,
      images: false,
    });
    expect(rows.find((r) => r.provider === "omlx")?.model).toBe(
      "Qwen3.6-35B-A3B-OptiQ-4bit",
    );
  });

  it("reads the thinking, context, max-out and images columns", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows[0]?.provider).not.toBe("provider");
    expect(
      rows.find((r) => r.model === "anthropic.claude-3-5-haiku-20241022-v1:0")
        ?.thinking,
    ).toBe(false);
    // A row with images yes and one with no, from the saved sample.
    const vision = rows.find(
      (r) =>
        r.provider === "amazon-bedrock" &&
        r.model === "us.meta.llama4-scout-17b-instruct-v1:0",
    );
    expect(vision).toEqual({
      provider: "amazon-bedrock",
      model: "us.meta.llama4-scout-17b-instruct-v1:0",
      context: "3.5M",
      maxOut: "16.4K",
      thinking: false,
      images: true,
    });
    expect(rows.find((r) => r.model === "cohere.command-r-plus-v1:0")?.images).toBe(
      false,
    );
  });

  it("skips header and footer lines", () => {
    const parsed = parsePiModels(
      [
        "provider        model               context  max-out  thinking  images",
        "anthropic       claude-sonnet-4-6   1M       128K     yes       yes",
        "bppc            qwen3.8-27b         73.7K    32.8K    yes       no",
        "Showing 7 of 102 providers. Run `pi --list-providers` to see all.",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        context: "1M",
        maxOut: "128K",
        thinking: true,
        images: true,
      },
      {
        provider: "bppc",
        model: "qwen3.8-27b",
        context: "73.7K",
        maxOut: "32.8K",
        thinking: true,
        images: false,
      },
    ]);
  });

  it("filters model ids per provider in table order", () => {
    expect(modelsForProvider(rows, "bppc")).toEqual(["qwen3.8-27b"]);
  });
});

describe("modelAcceptsImages", () => {
  const rows = parsePiModels(
    [
      "provider   model              context  max-out  thinking  images",
      "anthropic  claude-sonnet-4-6  1M       128K     yes       yes",
      "bppc       qwen3.8-27b        73.7K    32.8K    yes       no",
    ].join("\n"),
  );

  it("answers true only for a listed row with images yes", () => {
    expect(modelAcceptsImages(rows, "anthropic", "claude-sonnet-4-6")).toBe(
      true,
    );
    expect(modelAcceptsImages(rows, "bppc", "qwen3.8-27b")).toBe(false);
  });

  it("stays undefined without a table, provider or matching row", () => {
    expect(modelAcceptsImages(null, "anthropic", "claude-sonnet-4-6")).toBeUndefined();
    expect(modelAcceptsImages(rows, null, "claude-sonnet-4-6")).toBeUndefined();
    expect(modelAcceptsImages(rows, "anthropic", "claude-opus-4-5")).toBeUndefined();
    expect(modelAcceptsImages(rows, "anthropic", "  ")).toBeUndefined();
  });

  it("returns every parsed row for one provider", () => {
    expect(modelRowsForProvider(rows, "anthropic").map((r) => r.model)).toEqual([
      "claude-sonnet-4-6",
    ]);
    expect(modelRowsForProvider(rows, "missing")).toEqual([]);
    expect(modelRowsForProvider(null, "anthropic")).toEqual([]);
    expect(modelRowsForProvider(rows, undefined)).toEqual([]);
  });
});

describe("auth.json edits", () => {
  const stored = {
    openai: { type: "api_key", key: "sk-old" },
    "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 1 },
  };

  it("classifies stored credentials", () => {
    expect(authStatus(stored, "openai")).toBe("key");
    expect(authStatus(stored, "github-copilot")).toBe("oauth");
    expect(authStatus(stored, "anthropic")).toBe("none");
    expect(authStatus(null, "openai")).toBe("none");
    expect(authStatus({ openai: "junk" }, "openai")).toBe("none");
  });

  it("merges an api key without touching other entries", () => {
    const next = setProviderApiKey(stored, "openai", "sk-new");
    expect(next.openai).toEqual({ type: "api_key", key: "sk-new" });
    expect(next["github-copilot"]).toEqual(stored["github-copilot"]);
    expect(stored.openai.key).toBe("sk-old");
  });

  it("starts a fresh file when auth.json is missing", () => {
    expect(setProviderApiKey(null, "anthropic", "k")).toEqual({
      anthropic: { type: "api_key", key: "k" },
    });
  });

  it("removes only the target provider", () => {
    const next = removeProviderAuth(stored, "openai");
    expect(next).toEqual({ "github-copilot": stored["github-copilot"] });
    expect(removeProviderAuth(null, "openai")).toEqual({});
  });
});

describe("models.json.tmpl round-trip", () => {
  const source = fixture("models-tmpl.sample.json");

  it("round-trips an untouched template without semantic change", () => {
    const doc = parseModelsJsonTmpl(source);
    expect(doc.endpoints.map((e) => e.id)).toEqual(["bppc", "omlx"]);
    // Serialization reindents (JSON.stringify), but the parsed value, the
    // placeholder strings included, must survive a save unchanged.
    expect(JSON.parse(serializeModelsJsonTmpl(doc, doc.endpoints))).toEqual(
      JSON.parse(source),
    );
  });

  it("exposes the editable fields and keeps placeholders on save", () => {
    const doc = parseModelsJsonTmpl(source);
    const bppc = doc.endpoints[0];
    expect(bppc.baseUrl).toBe("http://__BPPC_HOST__:8080/v1");
    expect(bppc.modelId).toBe("qwen3.8-27b");
    expect(bppc.name).toBe("Qwen3.8 27B (bppc)");
    expect(bppc.contextWindow).toBe(73728);
    expect(bppc.maxTokens).toBe(32768);
    expect(bppc.apiKey).toBe("local");

    const edited: PiEndpointView[] = doc.endpoints.map((e) =>
      e.id === "bppc"
        ? { ...e, baseUrl: "http://__BPPC_HOST__:9000/v1", contextWindow: 131072 }
        : e,
    );
    const out = serializeModelsJsonTmpl(doc, edited);
    expect(out).toContain("__BPPC_HOST__:9000");
    expect(out).toContain("__OMLX_KEY__");
    const reparsed = parseModelsJsonTmpl(out);
    expect(reparsed.endpoints.find((e) => e.id === "bppc")?.contextWindow).toBe(
      131072,
    );
    expect(
      reparsed.endpoints.find((e) => e.id === "omlx")?.modelId,
    ).toBe("Qwen3.6-35B-A3B-OptiQ-4bit");
  });

  it("appends a new openai-completions block for a fresh id", () => {
    const doc = parseModelsJsonTmpl(source);
    const out = serializeModelsJsonTmpl(doc, [
      ...doc.endpoints,
      { ...blankEndpoint(), id: "vllm", baseUrl: "http://localhost:9999/v1", modelId: "m1", name: "M1", contextWindow: 8192, maxTokens: 2048 },
    ]);
    const reparsed = parseModelsJsonTmpl(out);
    const vllm = reparsed.endpoints.find((e) => e.id === "vllm");
    expect(vllm?.baseUrl).toBe("http://localhost:9999/v1");
    const raw = JSON.parse(out) as {
      providers: Record<string, { api?: string; models: { reasoning?: boolean }[] }>;
    };
    expect(raw.providers.vllm.api).toBe("openai-completions");
    expect(raw.providers.vllm.models[0]?.reasoning).toBe(true);
  });

  it("skips blank ids instead of writing nameless blocks", () => {
    const doc = parseModelsJsonTmpl(source);
    const out = serializeModelsJsonTmpl(doc, [
      ...doc.endpoints,
      blankEndpoint(),
    ]);
    expect(JSON.parse(out)).toEqual(JSON.parse(source));
  });

  it("treats an unparsable template as an empty doc", () => {
    expect(parseModelsJsonTmpl("not json{").endpoints).toEqual([]);
  });
});

describe("sign in payload", () => {
  it("builds the pi:open-terminal contract for the layout listener", () => {
    const dir = "/Users/me/efficient-pi";
    expect(piSignInCommand(dir)).toBe(
      `PI_CODING_AGENT_DIR="${dir}/pi-home/agent" "${dir}/bin/pi"`,
    );
    expect(piSignInPayload(dir)).toEqual({
      cwd: dir,
      command: `PI_CODING_AGENT_DIR="${dir}/pi-home/agent" "${dir}/bin/pi"`,
      hint: "Type /login <provider> in the pi prompt",
    });
  });
});
