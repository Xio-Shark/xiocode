import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./fetch-retry.ts";

describe("fetchWithRetry", () => {
  it("returns immediately on 200 OK without retrying", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await fetchWithRetry("https://api.test/v1/chat", undefined, { fetchImpl: mockFetch });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("retries on 429 and succeeds when upstream recovers", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0.01" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const retries: number[] = [];
    const res = await fetchWithRetry("https://api.test/v1/chat", undefined, {
      fetchImpl: mockFetch,
      baseDelayMs: 10,
      onRetry: (info) => retries.push(info.attempt),
    });

    expect(callCount).toBe(2);
    expect(retries).toEqual([1]);
    expect(res.status).toBe(200);
  });

  it("retries on 529 (Anthropic Overloaded) with exponential backoff", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 2) {
        return new Response("overloaded", { status: 529 });
      }
      return new Response("ok", { status: 200 });
    });

    const res = await fetchWithRetry("https://api.test/v1/chat", undefined, {
      fetchImpl: mockFetch,
      baseDelayMs: 5,
      maxRetries: 3,
    });

    expect(callCount).toBe(3);
    expect(res.status).toBe(200);
  });

  it("stops retrying and returns the response when maxRetries is exhausted", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("internal error", { status: 500 }));
    const res = await fetchWithRetry("https://api.test/v1/chat", undefined, {
      fetchImpl: mockFetch,
      baseDelayMs: 5,
      maxRetries: 2,
    });
    // 1 initial + 2 retries = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(500);
  });

  it("retries on transient network errors (TypeError: fetch failed)", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response("ok", { status: 200 });
    });

    const res = await fetchWithRetry("https://api.test/v1/chat", undefined, {
      fetchImpl: mockFetch,
      baseDelayMs: 5,
    });

    expect(callCount).toBe(2);
    expect(res.status).toBe(200);
  });

  it("aborts immediately when AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn();
    await expect(
      fetchWithRetry("https://api.test/v1/chat", { signal: controller.signal }, { fetchImpl: mockFetch }),
    ).rejects.toThrow(/aborted/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
