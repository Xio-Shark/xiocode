import { describe, expect, it, vi } from "vitest";

import { discoverModels, probeApiKey } from "./discover.ts";

describe("discoverModels", () => {
  it("lists OpenAI-compatible models from /models", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "b-model" }, { id: "a-model" }],
    }), { status: 200 }));
    const result = await discoverModels({
      kind: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.source).toBe("api");
    expect(result.models).toEqual(["a-model", "b-model"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back to catalog for Anthropic without calling OpenAI /models", async () => {
    const fetchImpl = vi.fn();
    const result = await discoverModels({
      kind: "anthropic",
      apiKey: "sk-test",
      catalogModels: ["claude-sonnet-4-20250514"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.source).toBe("catalog");
    expect(result.models).toEqual(["claude-sonnet-4-20250514"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns catalog when OpenAI list fails with a non-auth error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const result = await discoverModels({
      kind: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      catalogModels: ["fallback"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.source).toBe("catalog");
    expect(result.models).toEqual(["fallback"]);
    expect(result.error).toMatch(/500/);
    expect(result.error).not.toContain("boom");
  });
});

describe("probeApiKey", () => {
  it("rejects empty keys", async () => {
    await expect(probeApiKey({ kind: "openai", apiKey: "  " })).resolves.toMatchObject({ ok: false });
  });

  it("fails OpenAI probe on 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await probeApiKey({
      kind: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it("accepts Anthropic catalog when list endpoint is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const result = await probeApiKey({
      kind: "anthropic",
      apiKey: "sk-good",
      catalogModels: ["claude-sonnet-4-20250514"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["claude-sonnet-4-20250514"]);
  });
});
