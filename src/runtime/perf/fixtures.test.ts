import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFixture } from "./fixtures.ts";
import { runTuiReplayFixture } from "../../tui/perf-replay.ts";
import { PerfStore, createBenchId, probeOverhead } from "./store.ts";
import { resetProcessOriginForTests, setGlobalTracerForTests } from "./tracer.ts";

const tempDirs: string[] = [];

beforeEach(() => {
  resetProcessOriginForTests();
  setGlobalTracerForTests(undefined);
});

afterEach(async () => {
  setGlobalTracerForTests(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("trusted perf fixtures", () => {
  it("tui.replay_10k drives reducer+coalescer paints (not empty loop)", async () => {
    const sample = await runFixture("tui.replay_10k", { iteration: 0, tuiReplay: runTuiReplayFixture });
    expect(sample.outcome).toBe("success");
    const paints = sample.spans.filter((span) => span.name === "tui.paint");
    expect(paints.length).toBeGreaterThan(10);
    expect(paints.every((span) => span.attrs?.path === "reducer+coalescer")).toBe(true);
    const start = sample.spans.find((span) => span.name === "process_start");
    expect(start?.attrs?.trusted).toBe(true);
    expect(Number(start?.attrs?.paints ?? 0)).toBe(paints.length);
  }, 30_000);

  it("session.tool_heavy records tool.batch and checkpoint.persist via SessionStore", async () => {
    const sample = await runFixture("session.tool_heavy", { iteration: 0 });
    expect(sample.outcome).toBe("success");
    const toolBatches = sample.spans.filter((span) => span.name === "tool.batch");
    const checkpoints = sample.spans.filter((span) => span.name === "checkpoint.persist");
    expect(toolBatches.length).toBeGreaterThan(0);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.some((span) => span.attrs?.kind === "journal")).toBe(true);
    expect(checkpoints.some((span) => span.attrs?.kind === "snapshot")).toBe(true);
    const start = sample.spans.find((span) => span.name === "process_start");
    expect(start?.attrs?.durable).toBe(true);
    expect(start?.attrs?.trusted).toBe(true);
    expect(start?.attrs?.path).toBe("session_store");
    expect(start?.attrs?.journal_p95_ok).toBe(true);
    expect(Number(start?.attrs?.journal_p95_ms)).toBeLessThan(20);
  }, 60_000);

  it("explore fixtures label mock mode", async () => {
    const sample = await runFixture("explore.workers_2", { iteration: 0 });
    expect(sample.outcome).toBe("success");
    const dispatches = sample.spans.filter((span) => span.name === "subagent.dispatch");
    expect(dispatches).toHaveLength(2);
    expect(dispatches.every((span) => span.attrs?.explore_mode === "mock")).toBe(true);
    const start = sample.spans.find((span) => span.name === "process_start");
    expect(start?.attrs?.trusted_for_latency).toBe(false);
  }, 30_000);

  it("provider.overhead records streaming provider spans via agent loop", async () => {
    const sample = await runFixture("provider.overhead", { iteration: 0 });
    expect(sample.outcome).toBe("success");
    expect(sample.spans.some((span) => span.name === "provider.request")).toBe(true);
    expect(sample.spans.some((span) => span.name === "provider.first_token")).toBe(true);
    expect(sample.spans.some((span) => span.name === "provider.completion")).toBe(true);
    const start = sample.spans.find((span) => span.name === "process_start");
    expect(start?.attrs?.trusted).toBe(true);
    expect(start?.attrs?.path).toBe("agent_loop_stream");
  }, 30_000);
});

describe("PerfStore evidence mirror", () => {
  it("writes report under both perf root and runs evidence root", async () => {
    const perfRoot = await mkdtemp(path.join(os.tmpdir(), "xio-perf-"));
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), "xio-runs-"));
    tempDirs.push(perfRoot, runsRoot);

    const store = new PerfStore({
      root: perfRoot,
      evidenceRoot: runsRoot,
      packageVersion: "0.0.0-test",
    });
    const sample = await runFixture("tui.replay_10k", { iteration: 0, tuiReplay: runTuiReplayFixture });
    const benchId = createBenchId(new Date("2026-07-16T00:00:00.000Z"));
    const { dir, evidenceDir, report } = await store.writeReport({
      benchId,
      iterations: 1,
      fixtures: ["tui.replay_10k"],
      samples: [sample],
      overhead: probeOverhead(50),
    });

    expect(dir).toBe(path.join(perfRoot, benchId));
    expect(evidenceDir).toBe(path.join(runsRoot, benchId));
    expect(report.notes.some((note) => note.includes("evidence model"))).toBe(true);

    const perfReport = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8")) as {
      bench_id: string;
    };
    const evidenceReport = JSON.parse(await readFile(path.join(evidenceDir!, "report.json"), "utf8")) as {
      bench_id: string;
    };
    const metadata = JSON.parse(await readFile(path.join(evidenceDir!, "metadata.json"), "utf8")) as {
      kind: string;
      run_id: string;
    };
    expect(perfReport.bench_id).toBe(benchId);
    expect(evidenceReport.bench_id).toBe(benchId);
    expect(metadata.kind).toBe("perf_bench");
    expect(metadata.run_id).toBe(benchId);
    expect(await readdir(evidenceDir!)).toEqual(
      expect.arrayContaining(["report.json", "samples.jsonl", "metadata.json"]),
    );
  }, 30_000);
});
