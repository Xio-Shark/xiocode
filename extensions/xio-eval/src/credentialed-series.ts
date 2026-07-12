import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PinnedEvalIdentity } from "./eval-identity.ts";
import type { EvalReport, SuiteIdentity, UsageMetrics } from "./types.ts";
import { emptyUsage } from "./types.ts";

export type CredentialedSeries = Readonly<{
  schema_version: "credentialed-series.v1";
  series_id: string;
  created_at: string;
  mode: EvalReport["mode"];
  candidate_mode: "real";
  repeat: number;
  identity: Readonly<{
    provider: string;
    exact_model_id: string;
    provider_api: string;
    inference_settings: PinnedEvalIdentity["inference_settings"];
    candidate_revision: string | null;
    suite: SuiteIdentity;
  }>;
  eval_refs: readonly {
    eval_id: string;
    report_sha256: string;
    status: EvalReport["status"];
  }[];
  aggregate: Readonly<{
    status: EvalReport["status"];
    trial_count: number;
    resolved: number;
    attempted: number;
    infra_errors: number;
    wall_ms: number;
    usage: UsageMetrics;
  }>;
  concerns: readonly string[];
  errors: readonly string[];
}>;

export async function writeCredentialedSeries(
  evalRoot: string,
  report: EvalReport,
  options: Readonly<{
    identity: PinnedEvalIdentity;
    repeat: number;
    reportJson: string;
  }>,
): Promise<CredentialedSeries> {
  const trials = report.candidates.flatMap((candidate) => candidate.trials);
  const series: CredentialedSeries = {
    schema_version: "credentialed-series.v1",
    series_id: report.series_id,
    created_at: report.created_at,
    mode: report.mode,
    candidate_mode: "real",
    repeat: options.repeat,
    identity: {
      provider: options.identity.provider,
      exact_model_id: options.identity.exact_model_id,
      provider_api: options.identity.provider_api,
      inference_settings: options.identity.inference_settings,
      candidate_revision: report.candidates[0]?.candidate_revision ?? null,
      suite: report.suite,
    },
    eval_refs: [{
      eval_id: report.eval_id,
      report_sha256: sha256(options.reportJson),
      status: report.status,
    }],
    aggregate: {
      status: report.status,
      trial_count: trials.length,
      resolved: report.candidates.reduce((sum, item) => sum + item.resolved, 0),
      attempted: report.candidates.reduce((sum, item) => sum + item.attempted, 0),
      infra_errors: report.candidates.reduce((sum, item) => sum + item.infra_errors, 0),
      wall_ms: trials.reduce((sum, trial) => sum + trial.efficiency.wall_ms, 0),
      usage: aggregateUsage(trials.map((trial) => trial.usage)),
    },
    concerns: report.concerns,
    errors: report.errors,
  };
  const dir = path.join(evalRoot, "series", report.series_id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "credentialed-series.json"), `${JSON.stringify(series, null, 2)}\n`, "utf8");
  return series;
}

export function decodeCredentialedSeries(value: unknown): CredentialedSeries {
  const record = asRecord(value, "credentialed series");
  if (record.schema_version !== "credentialed-series.v1") {
    throw new Error(`unsupported credentialed series schema: ${String(record.schema_version)}`);
  }
  return value as CredentialedSeries;
}

function aggregateUsage(usages: readonly UsageMetrics[]): UsageMetrics {
  if (usages.length === 0) return emptyUsage();
  const sum = (pick: (usage: UsageMetrics) => number | null): number | null => {
    let total = 0;
    let saw = false;
    for (const usage of usages) {
      const value = pick(usage);
      if (value === null) continue;
      saw = true;
      total += value;
    }
    return saw ? total : null;
  };
  return {
    input_tokens: sum((usage) => usage.input_tokens),
    output_tokens: sum((usage) => usage.output_tokens),
    cache_tokens: sum((usage) => usage.cache_tokens),
    reasoning_tokens: sum((usage) => usage.reasoning_tokens),
    estimated_cost_usd: sum((usage) => usage.estimated_cost_usd),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
