import { describe, expect, it } from "vitest";

import {
  cloudKeyStatus,
  cloudKeyStatusLabel,
  cloudProviderEnvVars,
  omlxKeyStatus,
  omlxKeyStatusLabel,
  omlxSettingsFallback,
  secretEnvMap,
} from "./secrets";

describe("cloudProviderEnvVars", () => {
  it("maps each cloud provider to the env vars pi reads", () => {
    expect(cloudProviderEnvVars("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
    expect(cloudProviderEnvVars("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(cloudProviderEnvVars("openrouter")).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("maps google onto both GEMINI_API_KEY and GOOGLE_API_KEY", () => {
    expect(cloudProviderEnvVars("google")).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ]);
  });

  it("maps omlx onto OMLX_API_KEY and EFFICIENT_PI_OMLX_KEY", () => {
    expect(cloudProviderEnvVars("omlx")).toEqual([
      "OMLX_API_KEY",
      "EFFICIENT_PI_OMLX_KEY",
    ]);
  });

  it("answers empty for unknown or blank providers", () => {
    expect(cloudProviderEnvVars("bppc")).toEqual([]);
    expect(cloudProviderEnvVars("  ")).toEqual([]);
  });
});

describe("secretEnvMap", () => {
  it("builds the spawn env from stored keys", () => {
    expect(
      secretEnvMap({ anthropic: "sk-a", openrouter: "sk-r" }),
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-a",
      OPENROUTER_API_KEY: "sk-r",
    });
  });

  it("puts one google key on both env vars", () => {
    expect(secretEnvMap({ google: "sk-g" })).toEqual({
      GEMINI_API_KEY: "sk-g",
      GOOGLE_API_KEY: "sk-g",
    });
  });

  it("puts one omlx key on the pi var and the render override", () => {
    expect(secretEnvMap({ omlx: "sk-omlx" })).toEqual({
      OMLX_API_KEY: "sk-omlx",
      EFFICIENT_PI_OMLX_KEY: "sk-omlx",
    });
  });

  it("drops unknown providers, blank keys and unset entries", () => {
    expect(
      secretEnvMap({
        mystery: "sk-x",
        anthropic: "   ",
        openai: null,
        google: undefined,
      }),
    ).toEqual({});
  });

  it("trims the stored key", () => {
    expect(secretEnvMap({ anthropic: "  sk-a  " })).toEqual({
      ANTHROPIC_API_KEY: "sk-a",
    });
  });
});

describe("cloudKeyStatus", () => {
  it("prefers the stored key over env and auth.json", () => {
    expect(cloudKeyStatus("anthropic", true, true, "oauth")).toBe("stored");
    expect(cloudKeyStatus("anthropic", true, false, "none")).toBe("stored");
  });

  it("reports an env var before an auth.json entry", () => {
    expect(cloudKeyStatus("openai", false, true, "api_key")).toBe("env");
    expect(cloudKeyStatus("openai", false, true, "none")).toBe("env");
  });

  it("falls back to the runtime agent dir entry, then not set", () => {
    expect(cloudKeyStatus("openrouter", false, false, "api_key")).toBe("auth");
    expect(cloudKeyStatus("openrouter", false, false, "oauth")).toBe("auth");
    expect(cloudKeyStatus("openrouter", false, false, "none")).toBe("none");
  });

  it("never reports a status for a non-cloud provider", () => {
    expect(cloudKeyStatus("bppc", true, true, "api_key")).toBe("none");
  });

  it("treats omlx like the other stored providers", () => {
    expect(cloudKeyStatus("omlx", true, false, "none")).toBe("stored");
    expect(cloudKeyStatus("omlx", false, true, "none")).toBe("env");
    expect(cloudKeyStatus("omlx", false, false, "none")).toBe("none");
  });
});

describe("omlxKeyStatus and omlxKeyStatusLabel", () => {
  it("ranks the stored key over the settings.json fallback", () => {
    expect(omlxKeyStatus(true, true)).toBe("stored");
    expect(omlxKeyStatus(true, false)).toBe("stored");
    expect(omlxKeyStatus(false, true)).toBe("fallback");
    expect(omlxKeyStatus(false, false)).toBe("none");
  });

  it("uses the exact badge wording", () => {
    expect(omlxKeyStatusLabel("stored")).toBe("stored");
    expect(omlxKeyStatusLabel("fallback")).toBe(
      "settings.json fallback available",
    );
    expect(omlxKeyStatusLabel("none")).toBe("not set");
  });
});

describe("omlxSettingsFallback", () => {
  it("answers true only for a non-empty auth.api_key", () => {
    expect(
      omlxSettingsFallback({ auth: { api_key: "  sk-omlx  " } }),
    ).toBe(true);
    expect(omlxSettingsFallback({ auth: { api_key: "sk" } })).toBe(true);
  });

  it("answers false for blank keys, bad shapes and junk", () => {
    expect(omlxSettingsFallback({ auth: { api_key: "   " } })).toBe(false);
    expect(omlxSettingsFallback({ auth: {} })).toBe(false);
    expect(omlxSettingsFallback({})).toBe(false);
    expect(omlxSettingsFallback("junk")).toBe(false);
    expect(omlxSettingsFallback(null)).toBe(false);
  });
});

describe("cloudKeyStatusLabel", () => {
  it("uses the exact badge wording", () => {
    expect(cloudKeyStatusLabel("stored")).toBe("stored key");
    expect(cloudKeyStatusLabel("env")).toBe("env var present");
    expect(cloudKeyStatusLabel("auth")).toBe("auth.json entry");
    expect(cloudKeyStatusLabel("none")).toBe("not set");
  });
});
