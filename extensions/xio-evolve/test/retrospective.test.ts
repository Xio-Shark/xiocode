import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractBlockerLog } from "../src/retrospective/extract.ts";
import { RetrospectiveRunner, loadRetrospectiveImproveGoals } from "../src/retrospective/runner.ts";
import { washRetrospectiveReport, formatInjectionContext } from "../src/retrospective/wash.ts";
import { RunStore } from "../src/run-store.ts";

import type { RunSummary } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "run-test",
    status: "failed",
    duration_ms: 100,
    success: false,
    failure_reasons: ["tool_error:bash", "stuck:bash"],
    finished_at: new Date().toISOString(),
    usage: { inputTokens: 1, outputTokens: 1, cacheTokens: null, reasoningTokens: null },
    ...overrides,
  };
}

describe("extractBlockerLog + wash", () => {
  it("merges failure_reasons and tool.error events into blockers with locations", () => {
    const log = extractBlockerLog({
      runId: "run-1",
      summary: summary(),
      events: [
        { event: "tool.call", tool_name: "bash", payload: { args: { command: "npm test" } } },
        {
          event: "tool.error",
          tool_name: "bash",
          payload: {
            result: {
              content: [{ type: "text", text: "exit_code=1\n\nstderr:\nfail src/foo.ts" }],
              isError: true,
            },
            args: { command: "npm test" },
          },
        },
        {
          event: "tool.error",
          tool_name: "edit",
          payload: {
            result: {
              content: "edit failed: old_string matched 2 times in src/bar.ts; must be unique",
              isError: true,
            },
            args: { path: "src/bar.ts" },
          },
        },
      ],
    });
    expect(log.blockers.length).toBeGreaterThanOrEqual(2);
    expect(log.tool_call_count).toBeGreaterThanOrEqual(1);
    expect(log.blockers.some((b) => b.kind === "stuck_loop")).toBe(true);
    expect(log.blockers.some((b) => b.location?.includes("bar.ts") || b.tool === "edit")).toBe(true);

    const report = washRetrospectiveReport(log);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.markdown).toContain("Blockers");
    expect(formatInjectionContext(report)).toContain("Post-task retrospective");
  });
});

describe("RetrospectiveRunner", () => {
  it("writes log+report, injects, and enqueues improve goal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-retro-"));
    tempDirs.push(root);
    const store = new RunStore({ root: path.join(root, "runs") });
    const record = await store.createRun({ run_id: "run-abc", provider: "t", model: "m" });
    await store.appendJsonl(record.run_id, "events.jsonl", {
      event: "tool.call",
      tool_name: "bash",
      message: "tool call: bash",
      payload: { args: { command: "false" } },
    });
    await store.appendJsonl(record.run_id, "events.jsonl", {
      event: "tool.error",
      tool_name: "bash",
      message: "tool result: bash",
      payload: {
        result: { content: "exit_code=1\nfail", isError: true },
        args: { command: "false" },
      },
    });

    const queueRoot = path.join(root, "improve-queue");
    const runner = new RetrospectiveRunner({
      runStore: store,
      improveQueueRoot: queueRoot,
      config: { enabled: true, skipTrivial: true, minToolCalls: 1, autoInject: true, enqueueImprove: true },
    });

    const result = await runner.runForFinishedTask({
      runId: record.run_id,
      summary: summary({ run_id: record.run_id, failure_reasons: ["tool_error:bash"] }),
      agentSuccess: false,
    });
    expect(result.skipped).toBe(false);
    expect(result.paths?.reportMd).toBeTruthy();
    const md = await readFile(result.paths!.reportMd, "utf8");
    expect(md).toContain("retrospective");
    const injection = runner.consumeInjection();
    expect(injection).toContain("Post-task retrospective");
    expect(runner.consumeInjection()).toBeUndefined();

    const goals = await loadRetrospectiveImproveGoals(queueRoot);
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals.some((g) => g.id.startsWith("entropy-"))).toBe(true);
    expect(goals[0]?.prompt).toMatch(/improving XioCode|entropy/i);
    expect(goals[0]?.meta?.from).toBe("retrospective");

    // Same entropy key overwrites and bumps seen count.
    await runner.runForFinishedTask({
      runId: record.run_id,
      summary: summary({ run_id: record.run_id, failure_reasons: ["tool_error:bash"] }),
      agentSuccess: false,
    });
    const goals2 = await loadRetrospectiveImproveGoals(queueRoot);
    const bashGoal = goals2.find((g) => g.meta?.action_id?.includes("bash") || g.id.includes("bash"));
    expect(Number(bashGoal?.meta?.seen ?? goals2[0]?.meta?.seen ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("skips trivial runs with no tools and no blockers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-retro-triv-"));
    tempDirs.push(root);
    const store = new RunStore({ root: path.join(root, "runs") });
    const record = await store.createRun({ run_id: "run-triv" });
    const runner = new RetrospectiveRunner({ runStore: store });
    const result = await runner.runForFinishedTask({
      runId: record.run_id,
      summary: summary({
        run_id: record.run_id,
        success: true,
        status: "success",
        failure_reasons: [],
      }),
      agentSuccess: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("trivial");
  });

  it("agent_end preflight does not claim session authority; session_end writes session-retrospective", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-retro-pre-"));
    tempDirs.push(root);
    const store = new RunStore({ root: path.join(root, "runs") });
    const record = await store.createRun({ run_id: "run-pre" });
    await store.appendJsonl(record.run_id, "events.jsonl", {
      event: "tool.error",
      tool_name: "bash",
      payload: { result: { content: "exit_code=1", isError: true }, args: { command: "false" } },
    });
    const runner = new RetrospectiveRunner({
      runStore: store,
      config: { sessionEndSubagent: false, autoInject: true, enqueueImprove: false },
    });
    const pre = await runner.runPreflight({
      runId: record.run_id,
      summary: summary({ run_id: record.run_id }),
    });
    expect(pre.skipped).toBe(false);
    expect(pre.report?.superseded_by).toBe("session");
    const preflight = await readFile(store.filePath(record.run_id, "blockers.preflight.json"), "utf8");
    expect(preflight).toContain("run-pre");

    const session = await runner.runSessionEnd({ runId: record.run_id, summary: summary({ run_id: record.run_id }) });
    expect(session.sessionReport?.schema_version).toBe("xio-session-retrospective.v1");
    const md = await readFile(store.filePath(record.run_id, "session-retrospective.md"), "utf8");
    expect(md).toContain("xio-session-retrospective.v1");
  });
});
