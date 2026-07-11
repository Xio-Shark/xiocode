import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { decideSmoke, summarizeCandidate } from "../src/comparator.ts";
import { EvalRunner } from "../src/eval-runner.ts";
import {
  classifyOutcome,
  compactLogs,
  comparisonCompatibilityErrors,
  finalSeriesId,
  selectedHoldouts,
} from "../src/eval-support.ts";
import { materializeFixture, validateCandidateWorktree } from "../src/fixture-materializer.ts";
import { gradeWorkspace } from "../src/grader.ts";
import { decodePriceTable, estimateUsageCost } from "../src/price-table.ts";
import { loadTrustedSuite } from "../src/suite-loader.ts";
import { spawnCommand } from "../src/process.ts";
import { decodeEvalReport, emptyUsage } from "../src/types.ts";
import { parseEvalArgs, runEvalCli } from "../../../src/cli/eval-cli.ts";

import type { SafetyResult, TrialReport } from "../src/types.ts";

const trustedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("trusted capability evaluator", () => {
  it("loads five dev/holdout families with content identities", async () => {
    const suite = await loadTrustedSuite(trustedRoot);
    expect(suite.fixtures).toHaveLength(10);
    for (const family of new Set(suite.fixtures.map((fixture) => fixture.family))) {
      expect(suite.fixtures.filter((fixture) => fixture.family === family).map((fixture) => fixture.visibility).sort())
        .toEqual(["dev", "holdout"]);
    }
    expect(suite.identity.suite_sha).toMatch(/^[a-f0-9]{64}$/);
    expect(suite.identity.evaluator_sha).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates base-red/oracle-green and package-script tamper resistance", async () => {
    const evalRoot = await tempRoot();
    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      eval_root: evalRoot,
    }).preflight();
    expect(report.status).toBe("PASS");
    expect(report.errors).toEqual([]);
    const saved = decodeEvalReport(JSON.parse(
      await readFile(path.join(evalRoot, report.eval_id, "report.json"), "utf8"),
    ) as unknown);
    expect(saved.eval_id).toBe(report.eval_id);
  }, 30_000);

  it("runs the offline controller-child-worktree-hidden-grader-report path", async () => {
    const evalRoot = await tempRoot();
    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      candidate_root: trustedRoot,
      candidate_mode: "stub",
      eval_root: evalRoot,
    }).smoke();
    expect(report.status).toBe("PASS_WITH_CONCERNS");
    expect(report.concerns).toContain("stub mode validates harness wiring only, not agent capability");
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      resolved: 5,
      attempted: 5,
      infra_errors: 0,
      safety_ok: true,
    });
    for (const trial of report.candidates[0]!.trials) {
      expect(trial.outcome.task_resolved).toBe(true);
      expect(trial.safety).toMatchObject({
        main_unchanged: true,
        hidden_grader_unexposed: true,
        merge_policy_ok: true,
      });
      expect(trial.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cache_tokens: null,
        reasoning_tokens: null,
        estimated_cost_usd: null,
      });
    }
    const suite = await loadTrustedSuite(trustedRoot);
    expect(finalSeriesId({
      suite,
      createdAt: report.created_at,
      evalId: report.eval_id,
      reportRoot: evalRoot,
      provisionalSeriesId: "unused",
    }, report.candidates[0]!.trials)).toBe(report.series_id);
    const trial = report.candidates[0]!.trials[0]!;
    const incompatible = {
      ...trial,
      environment: { ...trial.environment, exact_model_id: "different-model" },
    };
    expect(comparisonCompatibilityErrors([trial], [incompatible]))
      .toEqual([`incompatible comparison contract for case ${trial.identity.case_id}`]);
    const invalidNestedReport = {
      ...report,
      candidates: [{
        ...report.candidates[0]!,
        trials: [{ ...trial, safety: { ...trial.safety, main_unchanged: "yes" } }],
      }],
    };
    expect(() => decodeEvalReport(invalidNestedReport)).toThrow(/trial safety main_unchanged/);
  }, 30_000);

  it("fails closed on unknown report major versions", () => {
    expect(() => decodeEvalReport({ schema_version: "xio-eval-report.v2" })).toThrow(
      /unsupported eval report schema/,
    );
  });

  it("keeps smoke and compare CLI arguments scriptable", () => {
    expect(parseEvalArgs(["smoke", "--provider", "stub", "--case", "local-bug-holdout", "--json"]))
      .toMatchObject({
        command: "smoke",
        candidateMode: "stub",
        caseIds: ["local-bug-holdout"],
        json: true,
      });
    expect(parseEvalArgs(["compare", "--before", "main", "--candidate", "candidate"]))
      .toMatchObject({ command: "compare", beforeRoot: "main", candidateRoot: "candidate" });
    expect(() => parseEvalArgs(["compare"])).toThrow(/requires --before/);
  });

  it("defaults smoke candidate code to the trusted package root", async () => {
    const cwd = await tempRoot();
    const evalRoot = await tempRoot();
    let output = "";
    const code = await runEvalCli(
      ["smoke", "--provider", "stub", "--case", "local-bug-holdout", "--json"],
      {
        cwd,
        trustedRoot,
        env: { XIO_EVAL_ROOT: evalRoot },
        write: (chunk) => {
          output += chunk;
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ status: "PASS_WITH_CONCERNS" });
  }, 30_000);

  it("redacts provider secrets before persisting evaluator logs", () => {
    const secret = `sk-${"a".repeat(48)}`;
    expect(compactLogs(`provider failed for ${secret}`, "")).toEqual([
      "provider failed for sk-***REDACTED***",
    ]);
  });

  it("rejects unknown or non-holdout case selections", async () => {
    const suite = await loadTrustedSuite(trustedRoot);
    expect(() => selectedHoldouts(suite, ["missing-case"])).toThrow(/unknown holdout fixture/);
    expect(() => selectedHoldouts(suite, ["local-bug-dev"])).toThrow(/unknown holdout fixture/);
  });

  it("rejects candidate-reported worktrees outside the isolated trial root", async () => {
    const suite = await loadTrustedSuite(trustedRoot);
    const parent = await tempRoot();
    const fixtureRoot = await materializeFixture(suite.fixtures[0]!, parent);
    const outsider = await tempRoot();
    await expect(validateCandidateWorktree({
      fixtureRoot,
      allowedRoot: parent,
      reportedPath: outsider,
    })).rejects.toThrow(/outside the isolated trial root/);
  });

  it("computes cost only from a versioned trusted price table", () => {
    const table = decodePriceTable({
      schema_version: "xio-eval-price-table.v1",
      version: "2026-07-10",
      models: {
        "test/model": {
          input_per_million: 1,
          output_per_million: 2,
          cache_per_million: 0.5,
          reasoning_per_million: 3,
        },
      },
    });
    expect(estimateUsageCost({
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_tokens: 100_000,
      reasoning_tokens: 100_000,
      estimated_cost_usd: null,
    }, "test", "model", table).estimated_cost_usd).toBeCloseTo(1.25);
  });

  it("cleans a surviving process group before returning", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await tempRoot();
    const script = path.join(root, "spawn-descendant.mjs");
    await writeFile(script, [
      'import { spawn } from "node:child_process";',
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "console.log(child.pid);",
      "setTimeout(() => process.exit(0), 20);",
    ].join("\n"), "utf8");
    const result = await spawnCommand({
      command: process.execPath,
      args: [script],
      cwd: root,
      timeoutMs: 2_000,
    });
    const descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.cleanupError).toBeUndefined();
    expect(isProcessAlive(descendantPid)).toBe(false);
  }, 5_000);

  it("maps candidate and grader timeouts to INFRA_ERROR outside the task-resolved denominator", async () => {
    if (process.platform === "win32") {
      return;
    }
    const hung = await spawnCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: trustedRoot,
      timeoutMs: 200,
    });
    expect(hung.timedOut).toBe(true);
    expect(hung.cleanupError).toBeUndefined();
    expect(classifyOutcome("timeout", infraGraderLike(), okSafety())).toBe("infra_error");

    const suite = await loadTrustedSuite(trustedRoot);
    const fixture = suite.fixtures.find((item) => item.id === "local-bug-holdout");
    expect(fixture).toBeDefined();
    const workspaceParent = await tempRoot();
    const workspace = await materializeFixture(fixture!, workspaceParent);
    const slowRoot = await tempRoot();
    const graderDir = path.join(slowRoot, "extensions", "xio-eval", "src");
    await mkdir(graderDir, { recursive: true });
    await writeFile(
      path.join(graderDir, "grader-child.ts"),
      "await new Promise((resolve) => setTimeout(resolve, 60_000));\n",
      "utf8",
    );
    const grader = await gradeWorkspace({
      trustedRoot: slowRoot,
      workspace,
      fixture: { ...fixture!, grader_timeout_ms: 200 },
    });
    expect(grader.status).toBe("infra_error");
    expect(grader.error).toMatch(/grader timed out/);
    expect(classifyOutcome("completed", grader, okSafety())).toBe("infra_error");

    const summary = summarizeCandidate("candidate", "rev", [
      trialReport("local-bug-holdout", "local-bug", "infra_error", false),
    ]);
    expect(summary).toMatchObject({
      resolved: 0,
      attempted: 0,
      infra_errors: 1,
      safety_ok: true,
    });
    expect(decideSmoke(summary, "real").status).toBe("INFRA_ERROR");
  }, 15_000);

  it("marks grader crashes as INFRA_ERROR outside the task-resolved denominator", async () => {
    const suite = await loadTrustedSuite(trustedRoot);
    const fixture = suite.fixtures.find((item) => item.id === "local-bug-holdout");
    expect(fixture).toBeDefined();
    const workspaceParent = await tempRoot();
    const workspace = await materializeFixture(fixture!, workspaceParent);
    const crashingRoot = await tempRoot();
    const graderDir = path.join(crashingRoot, "extensions", "xio-eval", "src");
    await mkdir(graderDir, { recursive: true });
    await writeFile(path.join(graderDir, "grader-child.ts"), "process.exit(97);\n", "utf8");

    const grader = await gradeWorkspace({
      trustedRoot: crashingRoot,
      workspace,
      fixture: fixture!,
    });
    expect(grader.status).toBe("infra_error");
    expect(grader.error).toMatch(/grader exited with code 97/);

    const safety = okSafety();
    expect(classifyOutcome("completed", grader, safety)).toBe("infra_error");
    const summary = summarizeCandidate("candidate", "rev", [
      trialReport("local-bug-holdout", "local-bug", "infra_error", false),
      trialReport("cli-holdout", "cli-behavior", "resolved", true),
    ]);
    expect(summary).toMatchObject({
      resolved: 1,
      attempted: 1,
      infra_errors: 1,
      resolved_rate: 1,
    });
    expect(decideSmoke(summary, "real").status).toBe("INFRA_ERROR");
  }, 15_000);

  it("maps provider network failures to INFRA_ERROR without counting them as task failures", async () => {
    const evalRoot = await tempRoot();
    const configHome = await tempRoot();
    const configPath = path.join(configHome, "config.toml");
    await writeFile(configPath, [
      "[general]",
      'default_provider = "broken"',
      'default_model = "broken-model"',
      "",
      "[providers.broken]",
      'kind = "openai"',
      'model = "broken-model"',
      'base_url = "http://127.0.0.1:9"',
      'api_key_env = "XIO_EVAL_BROKEN_KEY"',
      "",
    ].join("\n"), "utf8");

    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      candidate_root: trustedRoot,
      candidate_mode: "real",
      eval_root: evalRoot,
      case_ids: ["local-bug-holdout"],
      env: {
        ...process.env,
        XIO_CONFIG: configPath,
        XIO_EVAL_BROKEN_KEY: "not-a-real-key",
      },
    }).smoke();

    expect(report.status).toBe("INFRA_ERROR");
    expect(report.candidates[0]).toMatchObject({
      resolved: 0,
      attempted: 0,
      infra_errors: 1,
      safety_ok: true,
    });
    const trial = report.candidates[0]!.trials[0]!;
    expect(trial.outcome.status).toBe("infra_error");
    expect(trial.outcome.task_resolved).toBe(false);
    expect(trial.safety).toMatchObject({
      main_unchanged: true,
      forbidden_files_unchanged: true,
      canary_unchanged: true,
      secret_redaction_ok: true,
      host_isolation: "unsupported",
    });
    expect(trial.evidence.infra_errors.join("\n")).toMatch(/LLM request failed|ECONNREFUSED|fetch failed|network|connect/i);
  }, 60_000);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-eval-test-"));
  tempDirs.push(root);
  return root;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function infraGraderLike(): import("../src/types.ts").GraderResult {
  return {
    status: "infra_error",
    task_resolved: false,
    f2p: false,
    p2p: false,
    typecheck: false,
    forbidden_files_unchanged: false,
    canary_unchanged: false,
    duration_ms: 0,
    details: [],
    error: "injected",
  };
}

function okSafety(): SafetyResult {
  return {
    main_unchanged: true,
    forbidden_files_unchanged: true,
    canary_unchanged: true,
    hidden_grader_unexposed: true,
    merge_policy_ok: true,
    secret_redaction_ok: true,
    host_isolation: "unsupported",
  };
}

function trialReport(
  caseId: string,
  family: TrialReport["identity"]["family"],
  status: TrialReport["outcome"]["status"],
  resolved: boolean,
): TrialReport {
  return {
    schema_version: "xio-eval-trial.v1",
    identity: {
      suite_id: "trusted-local",
      suite_version: "1",
      suite_sha: "a".repeat(64),
      evaluator_sha: "b".repeat(64),
      fixture_sha: "c".repeat(64),
      prompt_sha: "d".repeat(64),
      grader_sha: "e".repeat(64),
      oracle_sha: "f".repeat(64),
      eval_id: "eval-test",
      series_id: "series-test",
      case_id: caseId,
      family,
      candidate_revision: "rev",
      candidate_label: "candidate",
      system_prompt_sha: null,
    },
    environment: {
      provider: "stub",
      exact_model_id: "deterministic-oracle",
      inference_settings: { temperature: "provider-default", seed: "unsupported" },
      node: process.version,
      os: process.platform,
      arch: process.arch,
      turn_budget: 10,
      timeout_ms: 90_000,
      price_table_version: null,
    },
    outcome: {
      status,
      task_resolved: resolved,
      f2p: resolved,
      p2p: resolved,
      typecheck: resolved,
    },
    safety: okSafety(),
    efficiency: {
      wall_ms: 1,
      agent_ms: 1,
      grader_ms: 1,
      turns: 0,
      tool_calls: 0,
      tool_errors: 0,
    },
    usage: emptyUsage(),
    evidence: {
      run_id: null,
      trajectory_path: null,
      patch_summary: "",
      logs: [],
      concerns: [],
      infra_errors: status === "infra_error" ? ["injected infra failure"] : [],
      irreversible_side_effects: [],
    },
  };
}
