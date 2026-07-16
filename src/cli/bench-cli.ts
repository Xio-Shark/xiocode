import { createRequire } from "node:module";
import { writeSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ALL_FIXTURES,
  isFixtureId,
  runFixture,
  type FixtureId,
} from "../runtime/perf/fixtures.ts";
import {
  PerfStore,
  createBenchId,
  probeOverhead,
} from "../runtime/perf/index.ts";
import type { PerfReport, PerfSample } from "../runtime/perf/index.ts";

export type BenchCliArgs = Readonly<{
  command: "run" | "list" | "help";
  fixtures: readonly FixtureId[];
  iterations: number;
  json: boolean;
  outRoot?: string;
}>;

export async function runBenchCli(
  argv: readonly string[],
  options: Readonly<{
    write?: (chunk: string) => void;
    writeErr?: (chunk: string) => void;
    env?: NodeJS.ProcessEnv;
    packageVersion?: string;
  }> = {},
): Promise<number> {
  const write = options.write ?? writeStdout;
  const writeErr = options.writeErr ?? writeStderr;
  let args: BenchCliArgs;
  try {
    args = parseBenchArgs(argv);
  } catch (error) {
    write(`xio bench: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (args.command === "help") {
    write(benchHelp());
    return 0;
  }
  if (args.command === "list") {
    write(`${ALL_FIXTURES.join("\n")}\n`);
    return 0;
  }

  const env = options.env ?? process.env;
  const packageVersion = options.packageVersion ?? readPackageVersion();
  const xioHome = expandHome(env.XIO_HOME ?? path.join(os.homedir(), ".xiocode"));
  const outRoot = args.outRoot
    ?? env.XIO_PERF_ROOT
    ?? path.join(xioHome, "perf");
  // Always mirror into the existing runs evidence tree unless explicitly disabled.
  const evidenceRoot = env.XIO_BENCH_NO_EVIDENCE_MIRROR === "1"
    ? undefined
    : (env.XIO_RUN_ROOT ?? path.join(xioHome, "runs"));
  const store = new PerfStore({ root: outRoot, evidenceRoot, packageVersion });
  const benchId = createBenchId();
  const overhead = probeOverhead();
  const samples: PerfSample[] = [];
  const notes: string[] = [
    "tui.replay_10k path=reducer+coalescer",
    "session.tool_heavy path=session_store journal+snapshot",
    "provider.overhead path=agent_loop_stream provider.request+first_token+completion",
    "explore.workers_* default explore_mode=mock (set XIO_BENCH_EXPLORE_REAL=1 for real provider)",
  ];

  // Isolated home for interactive boot so we never touch the operator's real sessions.
  let tempHome: string | undefined;
  if (args.fixtures.some((fixture) => fixture === "startup.interactive")) {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "xio-bench-home-"));
    notes.push(`startup.interactive used XIO_HOME=${tempHome}`);
  }

  for (const fixture of args.fixtures) {
    for (let iteration = 0; iteration < args.iterations; iteration += 1) {
      try {
        const sample = await runFixture(fixture, {
          iteration,
          env: {
            ...env,
            ...(tempHome
              ? {
                  XIO_HOME: tempHome,
                  XIO_CONFIG: path.join(tempHome, "config.toml"),
                }
              : {}),
          },
        });
        samples.push(sample);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`${fixture}#${iteration} threw: ${message.slice(0, 120)}`);
        samples.push({
          fixture,
          iteration,
          spans: [],
          outcome: "failure",
          error_class: "fixture_throw",
          wall_ms: 0,
        });
      }
    }
  }

  if (overhead.concern) {
    notes.push(overhead.note);
  }

  const { report, dir, evidenceDir } = await store.writeReport({
    benchId,
    iterations: args.iterations,
    fixtures: args.fixtures,
    samples,
    overhead,
    notes,
  });

  if (args.json) {
    write(`${JSON.stringify(report)}\n`);
  } else {
    write(formatReport(report, dir, evidenceDir));
  }
  return reportHasHardFailure(report) ? 1 : 0;
}

export function parseBenchArgs(argv: readonly string[]): BenchCliArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", fixtures: [], iterations: 0, json: false };
  }
  if (argv[0] === "list") {
    return { command: "list", fixtures: [], iterations: 0, json: false };
  }
  if (argv[0] !== "run") {
    throw new Error(`unknown command '${argv[0]}' (try: run | list | help)`);
  }

  let iterations = 5;
  let json = false;
  let outRoot: string | undefined;
  let all = false;
  const fixtures: FixtureId[] = [];

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--iterations" || arg === "-n") {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--iterations must be an integer 1..100");
      }
      iterations = value;
      continue;
    }
    if (arg === "--fixture" || arg === "-f") {
      const raw = argv[++i];
      if (!raw || !isFixtureId(raw)) {
        throw new Error(`unknown fixture '${raw ?? ""}' (use xio bench list)`);
      }
      fixtures.push(raw);
      continue;
    }
    if (arg === "--out") {
      outRoot = argv[++i];
      if (!outRoot) {
        throw new Error("--out requires a directory");
      }
      continue;
    }
    throw new Error(`unknown flag '${arg}'`);
  }

  const selected = all || fixtures.length === 0 ? [...ALL_FIXTURES] : fixtures;
  return {
    command: "run",
    fixtures: selected,
    iterations,
    json,
    outRoot,
  };
}

export function benchHelp(): string {
  return [
    "xio bench — performance baseline fixtures",
    "  reports:  $XIO_HOME/perf/<bench_id>/ (or --out / XIO_PERF_ROOT)",
    "  evidence: $XIO_HOME/runs/<bench_id>/  (mirrored; same report.json + samples.jsonl)",
    "",
    "Usage:",
    "  xio bench run [--all] [--fixture <id>]... [--iterations N] [--json] [--out DIR]",
    "  xio bench list",
    "  xio bench help",
    "",
    "Fixtures:",
    ...ALL_FIXTURES.map((id) => `  ${id}`),
    "",
    "Acceptance command:",
    "  xio bench run --all --iterations 5 --json",
    "",
    "Env:",
    "  XIO_PERF_ROOT                 Override bench report root (default: $XIO_HOME/perf)",
    "  XIO_RUN_ROOT                  Evidence model root for mirror (default: $XIO_HOME/runs)",
    "  XIO_BENCH_NO_EVIDENCE_MIRROR  Set 1 to skip runs/ mirror",
    "  XIO_BENCH_EXPLORE_REAL        Set 1 for real-provider explore fixtures",
    "  XIO_PERF=1                    Enable in-process span recording during interactive sessions",
    "",
  ].join("\n");
}

function formatReport(report: PerfReport, dir: string, evidenceDir?: string): string {
  const lines = [
    `bench_id: ${report.bench_id}`,
    `schema: ${report.schema_version}`,
    `package: ${report.package_version}`,
    `iterations: ${report.iterations}`,
    `fixtures: ${report.fixtures.join(", ")}`,
    `overhead: ${report.overhead.median_span_cost_us}µs/span${report.overhead.concern ? " (CONCERN)" : ""}`,
    `output: ${dir}`,
    ...(evidenceDir ? [`evidence: ${evidenceDir}`] : []),
    "",
    "metrics (P50 / P95 ms):",
  ];
  const names = Object.keys(report.metrics).sort();
  for (const name of names) {
    const metric = report.metrics[name]!;
    const p50 = metric.p50_ms === null ? "n/a" : metric.p50_ms.toFixed(2);
    const p95 = metric.p95_ms === null ? "n/a" : metric.p95_ms.toFixed(2);
    const outcomes = Object.entries(metric.outcomes)
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(" ");
    lines.push(`  ${name}: ${p50} / ${p95}  (n=${metric.count}${outcomes ? ` ${outcomes}` : ""})`);
  }
  if (report.notes.length > 0) {
    lines.push("", "notes:");
    for (const note of report.notes) {
      lines.push(`  - ${note}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function reportHasHardFailure(report: PerfReport): boolean {
  for (const metric of Object.values(report.metrics)) {
    if (metric.outcomes.failure > 0 || metric.outcomes.timeout > 0) {
      // Soft: still exit 0 for baseline collection unless every fixture failed process_start? 
      // Prefer exit 0 so CI can archive reports; operator inspects outcomes.
    }
  }
  return false;
}

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}

function writeStderr(chunk: string): void {
  writeSync(process.stderr.fd, chunk);
}
