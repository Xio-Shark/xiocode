/**
 * Live model prices from models.dev.
 *
 * The table inside pricing.ts only knows ids XioCode ships with, so a gateway
 * that names its own models (`deepseek-v4.1-flash-fast`) showed up as "unpriced"
 * even after a real turn. Here the public catalog is fetched, slimmed down to
 * `provider → model → price`, cached under `~/.xiocode/cache`, and reused when
 * the network is unavailable — a stale price beats no price, and it is labelled
 * as stale by the caller.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateFileAtomic } from "./private-fs.ts";

import type { ModelPrice } from "./pricing.ts";

export const PRICE_CATALOG_VERSION = 1;
export const PRICE_CATALOG_URL = "https://models.dev/api.json";
/** How long a downloaded catalog is trusted before a refresh is attempted. */
export const PRICE_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export type CatalogProvider = Readonly<{
  /** Upstream base URL; recognises a gateway whose configured name differs. */
  api?: string;
  models: Readonly<Record<string, ModelPrice>>;
}>;

export type PriceCatalog = Readonly<{
  version: number;
  source: string;
  /** Epoch ms of the download this copy came from. */
  fetchedAt: number;
  providers: Readonly<Record<string, CatalogProvider>>;
}>;

export type PriceCatalogStatus = Readonly<{
  catalog: PriceCatalog | undefined;
  /** Where this call's numbers came from. */
  source: "cache" | "network" | "stale-cache" | "none";
  error?: string;
}>;

/** What the UI may show about the loaded catalog. */
export type PriceCatalogSummary = Readonly<{
  source: string;
  fetchedAt: number;
  providers: number;
  models: number;
}>;

/** `~/.xiocode/cache/model-prices.json`, honouring XIO_CONFIG like the rest of the runtime. */
export function priceCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XIO_CONFIG;
  const configPath = configured
    ? (configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured)
    : path.join(os.homedir(), ".xiocode", "config.toml");
  return path.join(path.dirname(path.resolve(configPath)), "cache", "model-prices.json");
}

/** Keep only the priced entries of a models.dev payload; throws when none survive. */
export function slimPriceCatalog(raw: unknown, fetchedAt: number): PriceCatalog {
  if (!isRecord(raw)) {
    throw new Error("price catalog: expected an object of providers");
  }
  const providers: Record<string, CatalogProvider> = {};
  for (const [providerId, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const models: Record<string, ModelPrice> = {};
    const entries = isRecord(value.models) ? value.models : {};
    for (const [modelId, entry] of Object.entries(entries)) {
      const price = priceFromEntry(entry);
      if (price) models[modelId.toLowerCase()] = price;
    }
    if (Object.keys(models).length === 0) continue;
    providers[providerId] = {
      ...(typeof value.api === "string" ? { api: value.api } : {}),
      models,
    };
  }
  if (Object.keys(providers).length === 0) {
    throw new Error("price catalog: no priced models in the response");
  }
  return { version: PRICE_CATALOG_VERSION, source: PRICE_CATALOG_URL, fetchedAt, providers };
}

/**
 * Read the cached catalog, refreshing it when it is older than `maxAgeMs`.
 * Never throws: a failed download falls back to the cache (marked stale), and
 * no catalog at all leaves pricing on the built-in table.
 */
export async function refreshPriceCatalog(options: Readonly<{
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetchImpl?: typeof fetch;
  maxAgeMs?: number;
  timeoutMs?: number;
  force?: boolean;
}> = {}): Promise<PriceCatalogStatus> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? PRICE_CATALOG_MAX_AGE_MS;
  const file = priceCatalogPath(env);
  const cached = await readPriceCatalog(file);

  if (cached && !options.force && now - cached.fetchedAt <= maxAgeMs) {
    setPriceCatalog(cached);
    return { catalog: cached, source: "cache" };
  }

  try {
    const fetched = await fetchPriceCatalog(options.fetchImpl ?? fetch, now, options.timeoutMs ?? FETCH_TIMEOUT_MS);
    await writePrivateFileAtomic(file, JSON.stringify(fetched));
    setPriceCatalog(fetched);
    return { catalog: fetched, source: "network" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached) {
      setPriceCatalog(cached);
      return { catalog: cached, source: "stale-cache", error: message };
    }
    return { catalog: undefined, source: "none", error: message };
  }
}

async function fetchPriceCatalog(fetchImpl: typeof fetch, fetchedAt: number, timeoutMs: number): Promise<PriceCatalog> {
  const response = await fetchImpl(PRICE_CATALOG_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`price catalog: HTTP ${response.status}`);
  }
  return slimPriceCatalog(await response.json(), fetchedAt);
}

async function readPriceCatalog(file: string): Promise<PriceCatalog | undefined> {
  try {
    return parseStoredCatalog(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Read back the slim format written above (not the models.dev shape). */
function parseStoredCatalog(raw: unknown): PriceCatalog | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== PRICE_CATALOG_VERSION) return undefined;
  const fetchedAt = finiteNumber(raw.fetchedAt);
  if (fetchedAt === undefined || !isRecord(raw.providers)) return undefined;

  const providers: Record<string, CatalogProvider> = {};
  for (const [providerId, value] of Object.entries(raw.providers)) {
    if (!isRecord(value)) continue;
    const models: Record<string, ModelPrice> = {};
    const entries = isRecord(value.models) ? value.models : {};
    for (const [modelId, price] of Object.entries(entries)) {
      const parsed = storedPrice(price);
      if (parsed) models[modelId] = parsed;
    }
    if (Object.keys(models).length === 0) continue;
    providers[providerId] = {
      ...(typeof value.api === "string" ? { api: value.api } : {}),
      models,
    };
  }
  if (Object.keys(providers).length === 0) return undefined;
  return {
    version: PRICE_CATALOG_VERSION,
    source: typeof raw.source === "string" ? raw.source : PRICE_CATALOG_URL,
    fetchedAt,
    providers,
  };
}

function storedPrice(value: unknown): ModelPrice | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value.inputPerMTok);
  const output = finiteNumber(value.outputPerMTok);
  if (input === undefined || output === undefined) return undefined;
  const cache = finiteNumber(value.cachePerMTok);
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cache === undefined ? {} : { cachePerMTok: cache }),
  };
}

let active: PriceCatalog | undefined;
let activeSummary: PriceCatalogSummary | undefined;

/** Install a catalog for `resolveModelPrice` (sync lookups cannot await a fetch). */
export function setPriceCatalog(catalog: PriceCatalog | undefined): void {
  active = catalog;
  activeSummary = catalog ? summarize(catalog) : undefined;
}

export function getPriceCatalog(): PriceCatalog | undefined {
  return active;
}

/** Freshness of the loaded catalog, for the usage view. */
export function priceCatalogSummary(): PriceCatalogSummary | undefined {
  return activeSummary;
}

function summarize(catalog: PriceCatalog): PriceCatalogSummary {
  let models = 0;
  for (const provider of Object.values(catalog.providers)) {
    models += Object.keys(provider.models).length;
  }
  return {
    source: catalog.source,
    fetchedAt: catalog.fetchedAt,
    providers: Object.keys(catalog.providers).length,
    models,
  };
}

/**
 * Price for one model out of the catalog.
 *
 * Provider-aware first (name, normalised name, then the configured base URL's
 * host). Only when the provider is unrecognised does it fall back to a model id
 * every provider agrees on — several gateways price the same id differently, and
 * guessing between them would be worse than saying "unpriced".
 */
export function catalogPrice(
  catalog: PriceCatalog | undefined,
  query: Readonly<{ provider?: string; model: string; baseUrl?: string }>,
): Readonly<{ price: ModelPrice; provider: string; model: string }> | undefined {
  if (!catalog || query.model.length === 0) return undefined;
  const modelIds = uniq([query.model.toLowerCase(), stripVendor(query.model)]);

  for (const providerId of providerCandidates(catalog, query)) {
    for (const modelId of modelIds) {
      const price = catalog.providers[providerId]?.models[modelId];
      if (price) return { price, provider: providerId, model: modelId };
    }
  }

  const hits: { price: ModelPrice; provider: string; model: string }[] = [];
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    for (const modelId of modelIds) {
      const price = provider.models[modelId];
      if (price) hits.push({ price, provider: providerId, model: modelId });
    }
  }
  const first = hits[0];
  if (!first) return undefined;
  return hits.every((hit) => samePrice(hit.price, first.price)) ? first : undefined;
}

function providerCandidates(
  catalog: PriceCatalog,
  query: Readonly<{ provider?: string; baseUrl?: string }>,
): readonly string[] {
  const candidates: string[] = [];
  const push = (id: string | undefined) => {
    if (id && !candidates.includes(id) && catalog.providers[id]) candidates.push(id);
  };

  const name = query.provider;
  if (name) {
    push(name);
    const normalized = normalizeProviderName(name);
    for (const id of Object.keys(catalog.providers)) {
      if (normalizeProviderName(id) === normalized) push(id);
    }
  }

  const host = query.baseUrl ? hostOf(query.baseUrl) : undefined;
  if (host) {
    const matches = Object.entries(catalog.providers)
      .filter(([, provider]) => provider.api !== undefined && hostOf(provider.api) === host)
      .map(([id]) => id);
    // Two catalog providers behind one host (opencode's free and gateway tiers)
    // cannot be told apart by URL alone; leave that to the name match above.
    if (matches.length === 1) push(matches[0]);
  }
  return candidates;
}

function normalizeProviderName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function stripVendor(model: string): string {
  const lower = model.toLowerCase();
  const slash = lower.indexOf("/");
  return slash > 0 && slash < lower.length - 1 ? lower.slice(slash + 1) : lower;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function priceFromEntry(entry: unknown): ModelPrice | undefined {
  if (!isRecord(entry)) return undefined;
  const cost = isRecord(entry.cost) ? entry.cost : undefined;
  if (!cost) return undefined;
  const input = finiteNumber(cost.input);
  const output = finiteNumber(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = finiteNumber(cost.cache_read);
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cache === undefined ? {} : { cachePerMTok: cache }),
  };
}

function samePrice(left: ModelPrice, right: ModelPrice): boolean {
  return left.inputPerMTok === right.inputPerMTok
    && left.outputPerMTok === right.outputPerMTok
    && left.cachePerMTok === right.cachePerMTok;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}
