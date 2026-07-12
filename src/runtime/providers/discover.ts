export type DiscoverModelsOptions = Readonly<{
  kind: string;
  baseUrl?: string;
  apiKey: string;
  catalogModels?: readonly string[];
  fetchImpl?: typeof fetch;
}>;

export type DiscoverModelsResult = Readonly<{
  models: readonly string[];
  source: "api" | "catalog" | "empty";
  error?: string;
}>;

export type ProbeApiKeyResult = Readonly<{
  ok: boolean;
  models: readonly string[];
  source: DiscoverModelsResult["source"];
  error?: string;
}>;

/** List models via OpenAI-compat `/models`, else fall back to catalog / free-form. */
export async function discoverModels(options: DiscoverModelsOptions): Promise<DiscoverModelsResult> {
  const catalog = options.catalogModels ?? [];
  if (options.kind === "anthropic" || options.kind === "google" || options.kind === "google-vertex") {
    return catalog.length > 0
      ? { models: [...catalog], source: "catalog" }
      : { models: [], source: "empty" };
  }
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      // Status only — response bodies can echo API keys.
      const error = `model list failed (${response.status})`;
      return catalog.length > 0
        ? { models: [...catalog], source: "catalog", error }
        : { models: [], source: "empty", error };
    }
    const json = await response.json() as { data?: Array<{ id?: string }> };
    const models = (json.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort((a, b) => a.localeCompare(b));
    if (models.length === 0) {
      return catalog.length > 0
        ? { models: [...catalog], source: "catalog" }
        : { models: [], source: "empty" };
    }
    return { models, source: "api" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return catalog.length > 0
      ? { models: [...catalog], source: "catalog", error: message }
      : { models: [], source: "empty", error: message };
  }
}

/** Cheap auth check: list models when possible; for Anthropic/Google accept non-empty key + catalog. */
export async function probeApiKey(options: DiscoverModelsOptions): Promise<ProbeApiKeyResult> {
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    return { ok: false, models: [], source: "empty", error: "API key is empty" };
  }
  if (options.kind === "anthropic") {
    return probeAnthropic(options);
  }
  if (options.kind === "google" || options.kind === "google-vertex") {
    const discovered = await discoverModels(options);
    return {
      ok: true,
      models: discovered.models,
      source: discovered.source,
      error: discovered.error,
    };
  }
  const discovered = await discoverModels(options);
  if (discovered.source === "api") {
    return { ok: true, models: discovered.models, source: "api" };
  }
  if (discovered.error && /failed \(401\)|failed \(403\)|unauthorized|invalid.*key/i.test(discovered.error)) {
    return { ok: false, models: [], source: discovered.source, error: discovered.error };
  }
  // Discovery failed for other reasons — allow connect with catalog / free-form id.
  return {
    ok: true,
    models: discovered.models,
    source: discovered.source,
    error: discovered.error,
  };
}

async function probeAnthropic(options: DiscoverModelsOptions): Promise<ProbeApiKeyResult> {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalog = options.catalogModels ?? [];
  try {
    const response = await fetchImpl(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (response.ok) {
      const json = await response.json() as { data?: Array<{ id?: string }> };
      const models = (json.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (models.length > 0) {
        return { ok: true, models, source: "api" };
      }
    } else if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => undefined);
      return { ok: false, models: [], source: "empty", error: `auth failed (${response.status})` };
    }
  } catch {
    // Fall through to catalog acceptance.
  }
  return {
    ok: true,
    models: catalog.length > 0 ? [...catalog] : [],
    source: catalog.length > 0 ? "catalog" : "empty",
  };
}
