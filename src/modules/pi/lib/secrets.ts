// Pure helpers behind the Settings "Pi" cloud keys group: the env map the
// spawn carries for stored keys, and the per-provider badge status. No Tauri
// imports here so the logic stays unit-testable in plain node. Rust twin:
// src-tauri/src/modules/pi/secrets.rs (PROVIDER_ENVS, inject_secret_env).

import { cloudProvider, type PiAuthStatus } from "./providers";

/** Env var names pi reads for a cloud provider id; empty when not cloud. */
export function cloudProviderEnvVars(providerId: string): readonly string[] {
  return cloudProvider(providerId)?.envVars ?? [];
}

/**
 * The env map a set of stored keys produces, mirroring the Rust spawn-env
 * injection minus the caller-wins rule (the caller's own env is only known
 * Rust-side): one entry per env var pi reads for each stored provider, so a
 * google key lands on both GEMINI_API_KEY and GOOGLE_API_KEY. Unknown
 * providers and blank keys are dropped.
 */
export function secretEnvMap(
  stored: Record<string, string | null | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [providerId, key] of Object.entries(stored)) {
    const trimmed = key?.trim();
    if (!trimmed) continue;
    for (const envVar of cloudProviderEnvVars(providerId)) {
      env[envVar] = trimmed;
    }
  }
  return env;
}

/** The badge states one cloud key row can show, best source first. */
export type PiCloudKeyStatus = "stored" | "env" | "auth" | "none";

/**
 * Badge resolution for one cloud provider: the app's own stored key wins,
 * then an env var pi would read, then an auth.json entry in the runtime agent
 * dir (key or OAuth token), else not set.
 */
export function cloudKeyStatus(
  providerId: string,
  stored: boolean,
  envPresent: boolean,
  auth: PiAuthStatus,
): PiCloudKeyStatus {
  if (!cloudProvider(providerId)) return "none";
  if (stored) return "stored";
  if (envPresent) return "env";
  if (auth !== "none") return "auth";
  return "none";
}

/** Human label for a badge state; the wording the UI must show. */
export function cloudKeyStatusLabel(status: PiCloudKeyStatus): string {
  switch (status) {
    case "stored":
      return "stored key";
    case "env":
      return "env var present";
    case "auth":
      return "auth.json entry";
    case "none":
      return "not set";
  }
}

/// ---------------------------------------------------------------------------
/// oMLX key (Settings > Pi endpoints group; stored as provider id "omlx")
/// ---------------------------------------------------------------------------

/**
 * The badge states of the endpoints-group oMLX key field, best source first:
 * the app's stored key, else the launcher's own ~/.omlx/settings.json
 * fallback, else nothing. Unlike the cloud badge there is no env or auth.json
 * stop: the render falls back to settings.json directly.
 */
export type PiOmlxKeyStatus = "stored" | "fallback" | "none";

export function omlxKeyStatus(
  stored: boolean,
  settingsFallback: boolean,
): PiOmlxKeyStatus {
  if (stored) return "stored";
  if (settingsFallback) return "fallback";
  return "none";
}

/** Human label for an oMLX badge state; the wording the UI must show. */
export function omlxKeyStatusLabel(status: PiOmlxKeyStatus): string {
  switch (status) {
    case "stored":
      return "stored";
    case "fallback":
      return "settings.json fallback available";
    case "none":
      return "not set";
  }
}

/**
 * True when a parsed ~/.omlx/settings.json carries a non-empty
 * auth.api_key, the launcher's own fallback, without exposing the value.
 * Anything malformed resolves to false so the badge reports "not set".
 */
export function omlxSettingsFallback(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const auth = (parsed as Record<string, unknown>).auth;
  if (typeof auth !== "object" || auth === null) return false;
  const key = (auth as Record<string, unknown>).api_key;
  return typeof key === "string" && key.trim().length > 0;
}
