import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  catalogPrice,
  getPriceCatalog,
  priceCatalogPath,
  refreshPriceCatalog,
  setPriceCatalog,
  slimPriceCatalog,
} from "./pricing-catalog.ts";
import { resolveModelPrice } from "./pricing.ts";

const PAYLOAD = {
  commandcode: {
    id: "commandcode",
    api: "https://api.commandcode.ai/provider/v1",
    models: {
      "deepseek/deepseek-v4.1-flash-fast": { cost: { input: 0.16, output: 0.58, cache_read: 0.016 } },
      "unpriced-model": {},
    },
  },
  "opencode-go": {
    id: "opencode-go",
    api: "https://opencode.ai/inference/go/openai/v1",
    models: {
      "deepseek-v4.1-flash": { cost: { input: 0.1, output: 0.4 } },
    },
  },
  deepseek: {
    id: "deepseek",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
    },
  },
  alpha: { models: { "shared-model": { cost: { input: 1, output: 2 } } } },
  beta: { models: { "shared-model": { cost: { input: 1, output: 2 } } } },
  gamma: { models: { "split-model": { cost: { input: 1, output: 2 } } } },
  delta: { models: { "split-model": { cost: { input: 9, output: 9 } } } },
};

function slim() {
  return slimPriceCatalog(PAYLOAD, Date.now());
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xio-price-catalog-"));
  return { XIO_CONFIG: path.join(dir, "config.toml") };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  setPriceCatalog(undefined);
});

describe("slimPriceCatalog", () => {
  it("keeps priced models only, lowercases ids and carries the api url", () => {
    const catalog = slimPriceCatalog({
      Example: {
        api: "https://api.example.test/v1",
        models: {
          "Model-A": { cost: { input: 1, output: 2, cache_read: 0.5 } },
          "Model-B": { cost: { input: 1 } },
          "Model-C": { name: "no cost" },
        },
      },
      Empty: { models: {} },
    }, 42);
    expect(catalog.fetchedAt).toBe(42);
    expect(catalog.providers.Example?.api).toBe("https://api.example.test/v1");
    expect(Object.keys(catalog.providers.Example?.models ?? {})).toEqual(["model-a"]);
    expect(catalog.providers.Example?.models["model-a"]).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cachePerMTok: 0.5,
    });
    expect(catalog.providers.Empty).toBeUndefined();
  });

  it("rejects a payload without a single priced model", () => {
    expect(() => slimPriceCatalog({ p: { models: { m: { name: "x" } } } }, 1)).toThrow(/no priced models/);
    expect(() => slimPriceCatalog("nope", 1)).toThrow(/expected an object/);
  });
});

describe("catalogPrice", () => {
  const catalog = slim();

  it("matches by provider name and by normalised name", () => {
    expect(catalogPrice(catalog, { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash-fast" })?.price.inputPerMTok)
      .toBe(0.16);
    expect(catalogPrice(catalog, { provider: "opencodego", model: "deepseek-v4.1-flash" })?.provider)
      .toBe("opencode-go");
  });

  it("matches a renamed gateway by its base url host", () => {
    const hit = catalogPrice(catalog, {
      provider: "my-gateway",
      model: "deepseek/deepseek-v4.1-flash-fast",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
    expect(hit?.provider).toBe("commandcode");
  });

  it("falls back to a model id only when every provider prices it the same", () => {
    expect(catalogPrice(catalog, { provider: "unknown", model: "shared-model" })?.price.inputPerMTok).toBe(1);
    expect(catalogPrice(catalog, { provider: "unknown", model: "split-model" })).toBeUndefined();
    expect(catalogPrice(catalog, { model: "not-in-catalog" })).toBeUndefined();
  });
});

describe("resolveModelPrice with a catalog", () => {
  it("prices a gateway model the built-in table has never seen", () => {
    setPriceCatalog(slim());
    expect(resolveModelPrice("deepseek/deepseek-v4.1-flash-fast", {
      provider: "command",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    })?.outputPerMTok).toBe(0.58);
  });

  it("keeps user overrides on top of the catalog", () => {
    setPriceCatalog(slim());
    expect(resolveModelPrice("deepseek/deepseek-v4.1-flash-fast", {
      provider: "command",
      overrides: { "command/deepseek/deepseek-v4.1-flash-fast": { inputPerMTok: 7, outputPerMTok: 8 } },
    })?.inputPerMTok).toBe(7);
  });
});

describe("refreshPriceCatalog", () => {
  it("downloads once, then serves the cache without a second request", async () => {
    const env = await tempEnv();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(PAYLOAD);
    }) as unknown as typeof fetch;

    const first = await refreshPriceCatalog({ env, fetchImpl, now: 1_000 });
    expect(first.source).toBe("network");
    expect(first.catalog?.providers.commandcode?.models["deepseek/deepseek-v4.1-flash-fast"]).toBeDefined();

    const cached = JSON.parse(await readFile(priceCatalogPath(env), "utf8")) as { fetchedAt: number };
    expect(cached.fetchedAt).toBe(1_000);

    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const second = await refreshPriceCatalog({ env, fetchImpl: failing, now: 2_000 });
    expect(second.source).toBe("cache");
    expect(calls).toBe(1);
    expect(getPriceCatalog()?.fetchedAt).toBe(1_000);
  });

  it("refreshes a stale cache, and keeps it when the download fails", async () => {
    const env = await tempEnv();
    await mkdir(path.dirname(priceCatalogPath(env)), { recursive: true });
    await writeFile(priceCatalogPath(env), JSON.stringify(slimPriceCatalog(PAYLOAD, 1_000)));

    const failing = (async () => jsonResponse({ broken: true })) as unknown as typeof fetch;
    const status = await refreshPriceCatalog({ env, fetchImpl: failing, now: 1_000 + 7 * 60 * 60 * 1000 });
    expect(status.source).toBe("stale-cache");
    expect(status.error).toMatch(/no priced models/);
    expect(getPriceCatalog()?.fetchedAt).toBe(1_000);

    const failing2 = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const status2 = await refreshPriceCatalog({ env, fetchImpl: failing2, now: 1_000 + 8 * 60 * 60 * 1000 });
    expect(status2.source).toBe("stale-cache");
    expect(status2.error).toBe("offline");
  });

  it("reports no catalog when the very first download fails", async () => {
    const env = await tempEnv();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const status = await refreshPriceCatalog({ env, fetchImpl: failing });
    expect(status.source).toBe("none");
    expect(status.catalog).toBeUndefined();
    expect(getPriceCatalog()).toBeUndefined();
  });
});
