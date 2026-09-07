// Minimal model/endpoint primitives kept for the preferences store's persisted
// shape. The models/agents settings UI and the AI stack were removed from this
// fork; these types only keep old stored preferences loadable.

export type CustomEndpoint = {
  id: string;
  name: string;
  baseURL: string;
  modelId: string;
  contextLimit: number;
};

export type ModelId = string;

export const DEFAULT_MODEL_ID: ModelId = "gpt-5.4-mini";

export function isKnownModelId(id: string): id is ModelId {
  return typeof id === "string" && id.length > 0;
}

export type AutocompleteProviderId = string;

/** One-shot migration of the legacy single OpenAI-compatible config into the
 *  named-endpoint list. Returns one endpoint when the old base URL + model id
 *  were both set, else empty. `id` is supplied by the caller to stay pure. */
export function migrateLegacyCompatEndpoint(
  baseURL: string,
  modelId: string,
  contextLimit: number,
  id: string,
): CustomEndpoint[] {
  if (!baseURL.trim() || !modelId.trim()) return [];
  return [{ id, name: "Custom endpoint", baseURL, modelId, contextLimit }];
}

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
export const MLX_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "";
