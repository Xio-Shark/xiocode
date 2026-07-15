import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_MANIFEST_SCHEMA = "xio-eval-gate-manifest.v1" as const;

export type MetricThreshold = Readonly<{
  metric: string;
  required?: boolean;
  hard_p95_regression_ms?: number;
  soft_p95_regression_ms?: number;
  hard_p50_regression_ms?: number;
  soft_p50_regression_ms?: number;
  hard_token_regression?: number;
  soft_token_regression?: number;
}>;

export type GateManifest = Readonly<{
  schema_version: typeof GATE_MANIFEST_SCHEMA;
  id: string;
  version: string;
  description?: string;
  performance: Readonly<{
    groups: Readonly<Record<string, readonly string[]>>;
    thresholds: readonly MetricThreshold[];
  }>;
  capability: Readonly<{
    stable_regression_is_hard_fail: boolean;
    safety_is_hard_fail: boolean;
  }>;
  awareness: Readonly<{
    min_evidence_coverage?: number;
    max_overlap?: number;
    soft_only: boolean;
  }>;
  private_families: readonly string[];
  axes: Readonly<Record<string, string>>;
}>;

export function defaultGateManifestPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../manifests/default-gate.v1.json");
}

export async function loadGateManifest(filePath?: string): Promise<GateManifest> {
  const resolved = filePath ? path.resolve(filePath) : defaultGateManifestPath();
  const raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  return decodeGateManifest(raw);
}

export function decodeGateManifest(value: unknown): GateManifest {
  const root = asRecord(value, "gate manifest");
  if (root.schema_version !== GATE_MANIFEST_SCHEMA) {
    throw new Error(`unsupported gate manifest schema: ${String(root.schema_version)}`);
  }
  assertString(root.id, "gate manifest id");
  assertString(root.version, "gate manifest version");
  const performance = asRecord(root.performance, "gate manifest performance");
  const groups = asRecord(performance.groups, "gate manifest performance.groups");
  const groupMap: Record<string, string[]> = {};
  for (const [key, items] of Object.entries(groups)) {
    if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
      throw new Error(`gate manifest performance.groups.${key} must be string[]`);
    }
    groupMap[key] = items as string[];
  }
  const thresholds = assertArray(performance.thresholds, "gate manifest performance.thresholds").map(decodeThreshold);
  const capability = asRecord(root.capability, "gate manifest capability");
  assertBoolean(capability.stable_regression_is_hard_fail, "capability.stable_regression_is_hard_fail");
  assertBoolean(capability.safety_is_hard_fail, "capability.safety_is_hard_fail");
  const awareness = asRecord(root.awareness, "gate manifest awareness");
  assertBoolean(awareness.soft_only, "awareness.soft_only");
  const privateFamilies = assertArray(root.private_families, "private_families");
  if (!privateFamilies.every((item) => typeof item === "string")) {
    throw new Error("private_families must be string[]");
  }
  const axes = asRecord(root.axes, "gate manifest axes");
  for (const [key, item] of Object.entries(axes)) {
    assertString(item, `axes.${key}`);
  }
  return {
    schema_version: GATE_MANIFEST_SCHEMA,
    id: root.id as string,
    version: root.version as string,
    description: typeof root.description === "string" ? root.description : undefined,
    performance: { groups: groupMap, thresholds },
    capability: {
      stable_regression_is_hard_fail: capability.stable_regression_is_hard_fail as boolean,
      safety_is_hard_fail: capability.safety_is_hard_fail as boolean,
    },
    awareness: {
      min_evidence_coverage: optionalNumber(awareness.min_evidence_coverage),
      max_overlap: optionalNumber(awareness.max_overlap),
      soft_only: awareness.soft_only as boolean,
    },
    private_families: privateFamilies as string[],
    axes: axes as Record<string, string>,
  };
}

function decodeThreshold(value: unknown): MetricThreshold {
  const row = asRecord(value, "metric threshold");
  assertString(row.metric, "threshold.metric");
  return {
    metric: row.metric as string,
    required: row.required === true,
    hard_p95_regression_ms: optionalNumber(row.hard_p95_regression_ms),
    soft_p95_regression_ms: optionalNumber(row.soft_p95_regression_ms),
    hard_p50_regression_ms: optionalNumber(row.hard_p50_regression_ms),
    soft_p50_regression_ms: optionalNumber(row.soft_p50_regression_ms),
    hard_token_regression: optionalNumber(row.hard_token_regression),
    soft_token_regression: optionalNumber(row.soft_token_regression),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function assertBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("threshold numeric fields must be finite numbers");
  }
  return value;
}
