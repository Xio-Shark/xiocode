import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { draftFixtureFromPrivateCase } from "../src/fixture-drafter.ts";
import { computeCaseId } from "../../xio-regress/src/case-identity.ts";
import { RegressionCaseStore } from "../../xio-regress/src/index.ts";
import { parseEvalArgs, runEvalCli } from "../../../src/cli/eval-cli.ts";

import type { PrivateRegressionCase } from "../../xio-regress/src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("fixture drafting from private regression cases", () => {
  it("drafts a dev+holdout template skeleton with the failure mode as review hints", () => {
    const regression = privateCase();
    const draft = draftFixtureFromPrivateCase(regression);
    expect(draft.case_id).toBe(regression.case_id);
    expect(draft.draft_ts).toContain(`turnLoopStallFixture`);
    expect(draft.draft_ts).toContain(`"turn-loop-stall-dev", "dev"`);
    expect(draft.draft_ts).toContain(`"turn-loop-stall-holdout", "holdout"`);
    expect(draft.draft_ts).toContain("agent stalls after tool error");
    expect(draft.draft_md).toContain("De-identify");
    expect(draft.draft_md).toContain("never merged automatically");
    // Drafts carry only case metadata — no prompt content exists on the case record.
    expect(draft.draft_ts).not.toContain("prompt_sha");
  });

  it("parses the draft CLI command and rejects foreign flags", () => {
    expect(parseEvalArgs(["draft", "--private-case", "last"])).toMatchObject({
      command: "draft",
      privateCaseIds: ["last"],
    });
    expect(() => parseEvalArgs(["draft"])).toThrow(/exactly one --private-case/);
    expect(() => parseEvalArgs(["draft", "--private-case", "last", "--repeat", "2"]))
      .toThrow(/only accepts --private-case and --json/);
    expect(() => parseEvalArgs(["draft", "--private-case", "a", "--before", "."]))
      .toThrow(/only accepts --private-case and --json/);
  });

  it("writes reviewed draft artifacts outside the repo via the CLI", async () => {
    const regressionRoot = await mkdtemp(path.join(os.tmpdir(), "xio-draft-regress-"));
    const evalRoot = await mkdtemp(path.join(os.tmpdir(), "xio-draft-eval-"));
    tempDirs.push(regressionRoot, evalRoot);
    const store = new RegressionCaseStore(regressionRoot);
    const regression = privateCase();
    await store.writeCase(regression);
    await store.writeLastCaseId(regression.case_id);
    const chunks: string[] = [];
    const code = await runEvalCli(["draft", "--private-case", "last", "--json"], {
      env: {
        ...process.env,
        XIO_REGRESSION_ROOT: regressionRoot,
        XIO_EVAL_ROOT: evalRoot,
      },
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(code).toBe(0);
    const output = JSON.parse(chunks.join("")) as { case_id: string; draft_ts: string; draft_md: string };
    expect(output.case_id).toBe(regression.case_id);
    expect(output.draft_ts.startsWith(path.join(evalRoot, "fixture-drafts"))).toBe(true);
    const template = await readFile(output.draft_ts, "utf8");
    expect(template).toContain("DRAFT");
    const checklist = await readFile(output.draft_md, "utf8");
    expect(checklist).toContain("Intake checklist");
  });

  it("fails closed when the case does not exist", async () => {
    const regressionRoot = await mkdtemp(path.join(os.tmpdir(), "xio-draft-missing-"));
    tempDirs.push(regressionRoot);
    const chunks: string[] = [];
    const code = await runEvalCli(["draft", "--private-case", "f".repeat(64)], {
      env: { ...process.env, XIO_REGRESSION_ROOT: regressionRoot },
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(code).toBe(3);
    expect(chunks.join("")).toMatch(/xio eval:/);
  });
});

function privateCase(): PrivateRegressionCase {
  const identity = {
    schema_version: "private-regression-case.v1" as const,
    source: {
      run_id: "run-1",
      repo_root: "/tmp/project",
      base_commit: "c".repeat(40),
      dirty: false,
      dirty_summary_sha: null,
      provenance_kind: "recorded" as const,
    },
    task: {
      prompt_sha: "a".repeat(64),
      failure_type: "Turn Loop Stall",
      failure_statement: "agent stalls after tool error\nand never resumes",
    },
    verifier: {
      command: "npm test -- --run turn-loop",
      expected_exit: 0,
      timeout_ms: 60_000,
    },
    runtime: {
      provider: null,
      model: null,
      xiocode_revision: null,
    },
    evidence: {
      prompt: { ref: "prompt.json", sha256: "b".repeat(64), source: "prompt_artifact" as const },
      metadata: { ref: "metadata.json", sha256: "b".repeat(64) },
      summary: { ref: "summary.json", sha256: "b".repeat(64) },
      trajectory: { ref: "trajectory.jsonl", sha256: "b".repeat(64) },
    },
    privacy: {
      classification: "local_private" as const,
      redaction_status: "clean" as const,
    },
    concerns: [],
  };
  return {
    ...identity,
    case_id: computeCaseId(identity),
    created_at: "2026-07-31T00:00:00.000Z",
  };
}
