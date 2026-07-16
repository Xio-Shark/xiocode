import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseBenchArgs, runBenchCli, benchHelp } from "./bench-cli.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("parseBenchArgs", () => {
  it("defaults run to all fixtures", () => {
    const args = parseBenchArgs(["run", "--iterations", "2"]);
    expect(args.command).toBe("run");
    expect(args.iterations).toBe(2);
    expect(args.fixtures.length).toBeGreaterThan(3);
  });

  it("accepts a single fixture", () => {
    const args = parseBenchArgs(["run", "--fixture", "cli.version", "-n", "1"]);
    expect(args.fixtures).toEqual(["cli.version"]);
  });
});

describe("runBenchCli", () => {
  it("writes a versioned report for cli.version and mirrors evidence", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "xio-bench-out-"));
    const runs = await mkdtemp(path.join(os.tmpdir(), "xio-bench-runs-"));
    tempDirs.push(out, runs);
    let stdout = "";
    const code = await runBenchCli(
      ["run", "--fixture", "cli.version", "--iterations", "1", "--json", "--out", out],
      {
        write: (chunk) => {
          stdout += chunk;
        },
        packageVersion: "0.0.0-test",
        env: {
          ...process.env,
          XIO_RUN_ROOT: runs,
          XIO_BENCH_NO_EVIDENCE_MIRROR: "",
        },
      },
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      schema_version: string;
      metrics: Record<string, { p50_ms: number | null; p95_ms: number | null }>;
      overhead: { median_span_cost_us: number };
      notes: string[];
    };
    expect(report.schema_version).toBe("xio-perf-report.v1");
    expect(report.metrics["process_start"]?.p50_ms).not.toBeNull();
    expect(report.overhead.median_span_cost_us).toBeGreaterThanOrEqual(0);
    expect(report.notes.some((note) => note.includes("evidence model"))).toBe(true);
    const dirs = await import("node:fs/promises").then((fs) => fs.readdir(out));
    expect(dirs.length).toBe(1);
    const reportPath = path.join(out, dirs[0]!, "report.json");
    const onDisk = JSON.parse(await readFile(reportPath, "utf8")) as { bench_id: string };
    expect(onDisk.bench_id).toContain("bench-");
    const evidenceDirs = await import("node:fs/promises").then((fs) => fs.readdir(runs));
    expect(evidenceDirs).toContain(dirs[0]!);
    const metadata = JSON.parse(
      await readFile(path.join(runs, dirs[0]!, "metadata.json"), "utf8"),
    ) as { kind: string };
    expect(metadata.kind).toBe("perf_bench");
  }, 60_000);

  it("lists fixtures and help", async () => {
    let listOut = "";
    expect(await runBenchCli(["list"], { write: (c) => { listOut += c; } })).toBe(0);
    expect(listOut).toContain("cli.version");
    expect(listOut).toContain("provider.overhead");
    expect(benchHelp()).toContain("xio bench run");
  });
});
