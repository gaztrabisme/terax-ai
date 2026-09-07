import { describe, expect, it } from "vitest";

import {
  cloudKeyStatus,
  cloudKeyStatusLabel,
  cloudProviderEnvVars,
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
    expect(cloudKeyStatus("openai", false, true, "key")).toBe("env");
    expect(cloudKeyStatus("openai", false, true, "none")).toBe("env");
  });

  it("falls back to the runtime agent dir entry, then not set", () => {
    expect(cloudKeyStatus("openrouter", false, false, "key")).toBe("auth");
    expect(cloudKeyStatus("openrouter", false, false, "oauth")).toBe("auth");
    expect(cloudKeyStatus("openrouter", false, false, "none")).toBe("none");
  });

  it("never reports a status for a non-cloud provider", () => {
    expect(cloudKeyStatus("bppc", true, true, "key")).toBe("none");
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
