import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { TokenUsage } from "../types.ts";
import type { PerfAttrValue, PerfOutcome, PerfSpan, PerfSpanName } from "./types.ts";
import { PERF_SPAN_SCHEMA } from "./types.ts";

const BLOCKED_ATTR_KEYS = new Set([
  "prompt",
  "content",
  "args",
  "body",
  "text",
  "message",
  "api_key",
  "apikey",
  "authorization",
  "token",
  "password",
  "secret",
  "cookie",
]);

const SECRET_LIKE = /sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}/;

export type ResourceSnapshot = Readonly<{
  wall_ms: number;
  cpu_user_ms: number | null;
  cpu_system_ms: number | null;
  rss_bytes: number | null;
}>;

export type ActiveSpan = Readonly<{
  name: PerfSpanName;
  span_id: string;
  parent_id?: string;
  trace_id: string;
  start: ResourceSnapshot;
  attrs?: Readonly<Record<string, PerfAttrValue>>;
}>;

export type PerfTracerOptions = Readonly<{
  enabled?: boolean;
  traceId?: string;
  originMs?: number;
  now?: () => number;
  sampleResources?: () => ResourceSnapshot;
  onSpan?: (span: PerfSpan) => void;
}>;

/** Process-wide origin set once at CLI entry. */
let processOriginMs: number | undefined;
let processTraceId: string | undefined;

export function markProcessOrigin(now: number = performance.now()): void {
  if (processOriginMs === undefined) {
    processOriginMs = now;
    processTraceId = randomUUID();
  }
}

export function getProcessOriginMs(): number | undefined {
  return processOriginMs;
}

export function getProcessTraceId(): string | undefined {
  return processTraceId;
}

export function resetProcessOriginForTests(): void {
  processOriginMs = undefined;
  processTraceId = undefined;
}

export function isPerfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.XIO_PERF?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || env.XIO_PERF_BOOT_EXIT === "1";
}

export function sampleResources(now: () => number = () => performance.now()): ResourceSnapshot {
  let cpu_user_ms: number | null = null;
  let cpu_system_ms: number | null = null;
  let rss_bytes: number | null = null;
  try {
    const usage = process.resourceUsage();
    // Node reports microseconds.
    cpu_user_ms = usage.userCPUTime / 1000;
    cpu_system_ms = usage.systemCPUTime / 1000;
  } catch {
    // platform may lack resourceUsage
  }
  try {
    rss_bytes = process.memoryUsage().rss;
  } catch {
    // ignore
  }
  return {
    wall_ms: now(),
    cpu_user_ms,
    cpu_system_ms,
    rss_bytes,
  };
}

export function sanitizeAttrs(
  attrs: Readonly<Record<string, PerfAttrValue>> | undefined,
): Readonly<Record<string, PerfAttrValue>> | undefined {
  if (!attrs) {
    return undefined;
  }
  const out: Record<string, PerfAttrValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (BLOCKED_ATTR_KEYS.has(normalized) || BLOCKED_ATTR_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value) || value.length > 200) {
        out[key] = "[redacted]";
        continue;
      }
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class PerfTracer {
  private readonly enabled: boolean;
  private readonly traceId: string;
  private readonly originMs: number;
  private readonly now: () => number;
  private readonly sampleResourcesFn: () => ResourceSnapshot;
  private readonly onSpan?: (span: PerfSpan) => void;
  private readonly spans: PerfSpan[] = [];

  constructor(options: PerfTracerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.traceId = options.traceId ?? processTraceId ?? randomUUID();
    this.originMs = options.originMs ?? processOriginMs ?? performance.now();
    this.now = options.now ?? (() => performance.now());
    this.sampleResourcesFn = options.sampleResources ?? (() => sampleResources(this.now));
    this.onSpan = options.onSpan;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSpans(): readonly PerfSpan[] {
    return this.spans;
  }

  clear(): void {
    this.spans.length = 0;
  }

  start(name: PerfSpanName, options: Readonly<{
    parentId?: string;
    attrs?: Readonly<Record<string, PerfAttrValue>>;
  }> = {}): ActiveSpan | undefined {
    if (!this.enabled) {
      return undefined;
    }
    return {
      name,
      span_id: randomUUID(),
      parent_id: options.parentId,
      trace_id: this.traceId,
      start: this.sampleResourcesFn(),
      attrs: options.attrs,
    };
  }

  end(
    active: ActiveSpan | undefined,
    outcome: PerfOutcome,
    options: Readonly<{
      usage?: TokenUsage;
      attrs?: Readonly<Record<string, PerfAttrValue>>;
      error_class?: string;
    }> = {},
  ): PerfSpan | undefined {
    if (!this.enabled || !active) {
      return undefined;
    }
    const end = this.sampleResourcesFn();
    const span = this.buildSpan(active, end, outcome, options);
    this.record(span);
    return span;
  }

  mark(
    name: PerfSpanName,
    outcome: PerfOutcome = "success",
    options: Readonly<{
      wall_ms?: number;
      usage?: TokenUsage;
      attrs?: Readonly<Record<string, PerfAttrValue>>;
      error_class?: string;
      parentId?: string;
    }> = {},
  ): PerfSpan | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const end = this.sampleResourcesFn();
    const wall_ms = options.wall_ms ?? Math.max(0, end.wall_ms - this.originMs);
    const active: ActiveSpan = {
      name,
      span_id: randomUUID(),
      parent_id: options.parentId,
      trace_id: this.traceId,
      start: {
        wall_ms: end.wall_ms - wall_ms,
        cpu_user_ms: end.cpu_user_ms,
        cpu_system_ms: end.cpu_system_ms,
        rss_bytes: end.rss_bytes,
      },
    };
    const span = this.buildSpan(active, end, outcome, options);
    this.record(span);
    return span;
  }

  async measure<T>(
    name: PerfSpanName,
    fn: () => Promise<T> | T,
    options: Readonly<{
      parentId?: string;
      attrs?: Readonly<Record<string, PerfAttrValue>>;
      classifyError?: (error: unknown) => { outcome: PerfOutcome; error_class: string };
      usageOf?: (result: T) => TokenUsage | undefined;
      attrsOf?: (result: T) => Readonly<Record<string, PerfAttrValue>> | undefined;
      outcomeOf?: (result: T) => PerfOutcome;
    }> = {},
  ): Promise<T> {
    const active = this.start(name, { parentId: options.parentId, attrs: options.attrs });
    try {
      const result = await fn();
      const outcome = options.outcomeOf?.(result) ?? "success";
      this.end(active, outcome, {
        usage: options.usageOf?.(result),
        attrs: options.attrsOf?.(result),
      });
      return result;
    } catch (error) {
      const classified = options.classifyError?.(error) ?? classifyUnknownError(error);
      this.end(active, classified.outcome, { error_class: classified.error_class });
      throw error;
    }
  }

  private buildSpan(
    active: ActiveSpan,
    end: ResourceSnapshot,
    outcome: PerfOutcome,
    options: Readonly<{
      usage?: TokenUsage;
      attrs?: Readonly<Record<string, PerfAttrValue>>;
      error_class?: string;
    }>,
  ): PerfSpan {
    const wall_ms = Math.max(0, end.wall_ms - active.start.wall_ms);
    const cpu_user_ms = deltaNullable(active.start.cpu_user_ms, end.cpu_user_ms);
    const cpu_system_ms = deltaNullable(active.start.cpu_system_ms, end.cpu_system_ms);
    const attrs = sanitizeAttrs({ ...active.attrs, ...options.attrs });
    return {
      schema_version: PERF_SPAN_SCHEMA,
      name: active.name,
      span_id: active.span_id,
      ...(active.parent_id ? { parent_id: active.parent_id } : {}),
      trace_id: active.trace_id,
      t0_ms: Math.max(0, active.start.wall_ms - this.originMs),
      wall_ms,
      cpu_user_ms,
      cpu_system_ms,
      rss_bytes: end.rss_bytes,
      outcome,
      ...(options.usage ? { usage: options.usage } : {}),
      ...(attrs ? { attrs } : {}),
      ...(options.error_class ? { error_class: options.error_class } : {}),
    };
  }

  private record(span: PerfSpan): void {
    this.spans.push(span);
    this.onSpan?.(span);
  }
}

export function classifyUnknownError(error: unknown): { outcome: PerfOutcome; error_class: string } {
  if (isAbortError(error)) {
    return { outcome: "cancelled", error_class: "abort" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return { outcome: "timeout", error_class: "timeout" };
  }
  if (/ECONN|fetch failed|HTTP\s*[45]/i.test(message)) {
    return { outcome: "failure", error_class: "provider_http" };
  }
  if (/ENOENT|EACCES|EPERM|ENOSPC/i.test(message)) {
    return { outcome: "failure", error_class: "io" };
  }
  return { outcome: "failure", error_class: "unknown" };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError";
}

function deltaNullable(start: number | null, end: number | null): number | null {
  if (start === null || end === null) {
    return null;
  }
  return Math.max(0, end - start);
}

/** Shared process tracer when XIO_PERF is enabled. */
let globalTracer: PerfTracer | undefined;

export function getGlobalTracer(env: NodeJS.ProcessEnv = process.env): PerfTracer | undefined {
  if (!isPerfEnabled(env)) {
    return undefined;
  }
  if (!globalTracer) {
    markProcessOrigin();
    globalTracer = new PerfTracer({ enabled: true });
  }
  return globalTracer;
}

export function setGlobalTracerForTests(tracer: PerfTracer | undefined): void {
  globalTracer = tracer;
}
