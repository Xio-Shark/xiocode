import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PerfOverheadProbe, PerfReport, PerfResourceSummary, PerfSample } from "./types.ts";
import { PERF_REPORT_SCHEMA } from "./types.ts";
import { summarizeSpansByName, summarizeWallMs } from "./stats.ts";
import { PerfTracer, sampleResources } from "./tracer.ts";
import type { PerfOutcome, PerfSpan } from "./types.ts";

export type PerfStoreOptions = Readonly<{
  /** Bench-local report root (default ~/.xiocode/perf). */
  root?: string;
  /**
   * Existing local evidence model root (default ~/.xiocode/runs).
   * When set, each bench report is mirrored under `<evidenceRoot>/<benchId>/`
   * so xio eval / regress do not depend on a second truth source alone.
   */
  evidenceRoot?: string;
  now?: () => Date;
  packageVersion?: string;
}>;

export class PerfStore {
  private readonly root: string;
  private readonly evidenceRoot: string | undefined;
  private readonly now: () => Date;
  private readonly packageVersion: string;

  constructor(options: PerfStoreOptions = {}) {
    this.root = expandHome(options.root ?? path.join(os.homedir(), ".xiocode", "perf"));
    this.evidenceRoot = options.evidenceRoot !== undefined
      ? expandHome(options.evidenceRoot)
      : undefined;
    this.now = options.now ?? (() => new Date());
    this.packageVersion = options.packageVersion ?? "0.0.0";
  }

  rootPath(): string {
    return this.root;
  }

  evidenceRootPath(): string | undefined {
    return this.evidenceRoot;
  }

  benchPath(benchId: string): string {
    return path.join(this.root, benchId);
  }

  evidenceBenchPath(benchId: string): string | undefined {
    return this.evidenceRoot ? path.join(this.evidenceRoot, benchId) : undefined;
  }

  async writeReport(input: Readonly<{
    benchId: string;
    iterations: number;
    fixtures: readonly string[];
    samples: readonly PerfSample[];
    overhead: PerfOverheadProbe;
    notes?: readonly string[];
  }>): Promise<{ report: PerfReport; dir: string; evidenceDir?: string }> {
    const dir = this.benchPath(input.benchId);
    await mkdir(dir, { recursive: true });
    const allSpans = input.samples.flatMap((sample) => sample.spans);
    const metrics = summarizeSpansByName(allSpans);
    // Also publish fixture-level wall summaries as fixture.<id>.wall
    for (const fixture of input.fixtures) {
      const fixtureSamples = input.samples.filter((sample) => sample.fixture === fixture);
      metrics[`fixture.${fixture}.wall`] = summarizeWallMs(
        fixtureSamples.map((sample) => sample.wall_ms),
        fixtureSamples.map((sample) => sample.outcome),
      );
    }

    const evidenceDir = this.evidenceRoot
      ? path.join(this.evidenceRoot, input.benchId)
      : undefined;
    const notes = [
      ...(input.notes ?? []),
      ...(evidenceDir ? [`mirrored to evidence model: ${evidenceDir}`] : []),
    ];
    const resource = summarizeResourceFromSamples(input.samples);
    const report: PerfReport = {
      schema_version: PERF_REPORT_SCHEMA,
      bench_id: input.benchId,
      created_at: this.now().toISOString(),
      package_version: this.packageVersion,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      iterations: input.iterations,
      fixtures: [...input.fixtures],
      metrics,
      ...(resource ? { resource } : {}),
      overhead: input.overhead,
      notes,
    };

    await writeBenchArtifacts(dir, report, input.samples);

    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeBenchArtifacts(evidenceDir, report, input.samples);
      // Run-shaped metadata so the directory is a first-class evidence peer of agent runs.
      await writeFile(
        path.join(evidenceDir, "metadata.json"),
        `${JSON.stringify({
          run_id: input.benchId,
          provider: "bench",
          model: "fixtures",
          started_at: report.created_at,
          kind: "perf_bench",
          package_version: report.package_version,
        }, null, 2)}\n`,
        "utf8",
      );
    }

    return { report, dir, evidenceDir };
  }

  async appendRunSpans(runDir: string, spans: readonly PerfSpan[]): Promise<void> {
    if (spans.length === 0) {
      return;
    }
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "perf-spans.jsonl"),
      spans.map((span) => JSON.stringify(span)).join("\n") + "\n",
      { encoding: "utf8", flag: "a" },
    );
  }
}

async function writeBenchArtifacts(
  dir: string,
  report: PerfReport,
  samples: readonly PerfSample[],
): Promise<void> {
  await writeFile(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(dir, "samples.jsonl"),
    samples.map((sample) => JSON.stringify(sample)).join("\n") + (samples.length > 0 ? "\n" : ""),
    "utf8",
  );
}

export function createBenchId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `bench-${stamp}`;
}

export function probeOverhead(samples = 2000): PerfOverheadProbe {
  const tracer = new PerfTracer({ enabled: true, originMs: 0 });
  const start = sampleResources();
  for (let i = 0; i < samples; i += 1) {
    const active = tracer.start("tui.paint", { attrs: { i } });
    tracer.end(active, "success");
  }
  const end = sampleResources();
  const wallMs = Math.max(0, end.wall_ms - start.wall_ms);
  const medianUs = (wallMs * 1000) / samples;
  // Concern if a no-op span costs more than ~50µs median (noisy hosts may still pass).
  const concern = medianUs > 50;
  return {
    samples,
    median_span_cost_us: Number(medianUs.toFixed(3)),
    concern,
    note: concern
      ? "Measurement overhead median > 50µs/span; treat light fixtures carefully."
      : "Measurement overhead median ≤ 50µs/span.",
  };
}

export function sampleFromSpans(input: Readonly<{
  fixture: string;
  iteration: number;
  spans: readonly PerfSpan[];
  wall_ms: number;
  outcome?: PerfOutcome;
  error_class?: string;
}>): PerfSample {
  const outcomes = input.spans.map((span) => span.outcome);
  const worst = pickWorstOutcome(outcomes) ?? input.outcome ?? "success";
  return {
    fixture: input.fixture,
    iteration: input.iteration,
    spans: [...input.spans],
    outcome: input.outcome ?? worst,
    ...(input.error_class ? { error_class: input.error_class } : {}),
    wall_ms: input.wall_ms,
  };
}

function summarizeResourceFromSamples(samples: readonly PerfSample[]): PerfResourceSummary | undefined {
  const rss = maxNullable(samples.flatMap((sample) => sample.spans.map((span) => span.rss_bytes)));
  const cpuUser = sumNullable(samples.flatMap((sample) => sample.spans.map((span) => span.cpu_user_ms)));
  const cpuSystem = sumNullable(samples.flatMap((sample) => sample.spans.map((span) => span.cpu_system_ms)));
  const cacheTokens = sumNullable(
    samples.flatMap((sample) => sample.spans.map((span) => span.usage?.cacheTokens ?? null)),
  );
  if (rss === null && cpuUser === null && cpuSystem === null && cacheTokens === null) {
    return undefined;
  }
  return {
    rss_bytes: rss,
    cpu_user_ms: cpuUser,
    cpu_system_ms: cpuSystem,
    cache_tokens: cacheTokens,
    cost_usd: null,
  };
}

function maxNullable(values: readonly (number | null | undefined)[]): number | null {
  const nums = values.filter((value): value is number => typeof value === "number");
  return nums.length > 0 ? Math.max(...nums) : null;
}

function sumNullable(values: readonly (number | null | undefined)[]): number | null {
  const nums = values.filter((value): value is number => typeof value === "number");
  return nums.length > 0 ? nums.reduce((total, value) => total + value, 0) : null;
}

function pickWorstOutcome(outcomes: readonly PerfOutcome[]): PerfOutcome | undefined {
  if (outcomes.includes("failure")) return "failure";
  if (outcomes.includes("timeout")) return "timeout";
  if (outcomes.includes("cancelled")) return "cancelled";
  if (outcomes.includes("success")) return "success";
  return undefined;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export type { PerfSample };
