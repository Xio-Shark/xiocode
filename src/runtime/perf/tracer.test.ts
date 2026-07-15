import { describe, expect, it, beforeEach } from "vitest";

import {
  PerfTracer,
  classifyUnknownError,
  resetProcessOriginForTests,
  sanitizeAttrs,
  setGlobalTracerForTests,
} from "./tracer.ts";
import { percentile, summarizeWallMs } from "./stats.ts";
import { probeOverhead, sampleFromSpans } from "./store.ts";
import { PERF_SPAN_SCHEMA } from "./types.ts";

beforeEach(() => {
  resetProcessOriginForTests();
  setGlobalTracerForTests(undefined);
});

describe("PerfTracer", () => {
  it("records versioned spans with outcomes", async () => {
    const tracer = new PerfTracer({ enabled: true, originMs: 0 });
    const active = tracer.start("provider.request", { attrs: { model: "m" } });
    const span = tracer.end(active, "success", {
      usage: { inputTokens: 1, outputTokens: 2, cacheTokens: 0, reasoningTokens: null },
    });
    expect(span?.schema_version).toBe(PERF_SPAN_SCHEMA);
    expect(span?.outcome).toBe("success");
    expect(span?.usage?.outputTokens).toBe(2);
    expect(span?.wall_ms).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes cancelled from failure", async () => {
    const tracer = new PerfTracer({ enabled: true });
    await expect(tracer.measure("tool.batch", async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    })).rejects.toThrow();
    expect(tracer.getSpans()[0]?.outcome).toBe("cancelled");
    expect(tracer.getSpans()[0]?.error_class).toBe("abort");
  });

  it("sanitizes secret-like and blocked attrs", () => {
    const cleaned = sanitizeAttrs({
      prompt: "should drop",
      model: "ok",
      token: "x",
      note: "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    });
    expect(cleaned).toEqual({ model: "ok", note: "[redacted]" });
  });
});

describe("stats", () => {
  it("computes p50 and p95", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5.5);
    expect(percentile(values, 95)).toBeCloseTo(9.55, 5);
    const summary = summarizeWallMs(values, values.map(() => "success" as const));
    expect(summary.p50_ms).toBe(5.5);
    expect(summary.outcomes.success).toBe(10);
  });
});

describe("overhead and samples", () => {
  it("probes overhead without throwing", () => {
    const probe = probeOverhead(200);
    expect(probe.samples).toBe(200);
    expect(probe.median_span_cost_us).toBeGreaterThanOrEqual(0);
  });

  it("builds samples with worst outcome", () => {
    const tracer = new PerfTracer({ enabled: true });
    tracer.mark("process_start", "success");
    tracer.mark("prompt_ready", "timeout", { error_class: "timeout" });
    const sample = sampleFromSpans({
      fixture: "startup.interactive",
      iteration: 0,
      spans: tracer.getSpans(),
      wall_ms: 12,
    });
    expect(sample.outcome).toBe("timeout");
  });
});

describe("classifyUnknownError", () => {
  it("maps timeout and http failures", () => {
    expect(classifyUnknownError(new Error("request timeout"))).toEqual({
      outcome: "timeout",
      error_class: "timeout",
    });
    expect(classifyUnknownError(new Error("HTTP 500"))).toEqual({
      outcome: "failure",
      error_class: "provider_http",
    });
  });
});
