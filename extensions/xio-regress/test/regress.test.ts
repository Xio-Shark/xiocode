import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorktreeSandbox } from "../../xio-sandbox/src/worktree-sandbox.ts";
import {
  decodePrivateRegressionCase,
  toReplayInput,
} from "../src/index.ts";
import {
  captureInput,
  createFixture as createRegressionFixture,
  git,
  gitState,
  initRepo,
} from "./fixture.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

function createFixture(status: "success" | "failed", withProvenance = true) {
  return createRegressionFixture(temporaryRoots, status, withProvenance);
}

describe("private regression capture", () => {
  it("captures versioned evidence, is idempotent, and produces replay input", async () => {
    const fixture = await createFixture("failed");
    const input = {
      ...captureInput(fixture.repo, fixture.base, "test ! -f fixed.txt"),
      base_commit: "HEAD",
    };
    const first = await fixture.capture.capture(input);
    const second = await fixture.capture.capture(input);

    expect(first.case.schema_version).toBe("private-regression-case.v1");
    expect(first.case.source.provenance_kind).toBe("recorded");
    expect(first.case.source.base_commit).toBe(fixture.base);
    expect(first.case.evidence.trajectory.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.existing).toBe(true);
    expect(second.case.case_id).toBe(first.case.case_id);
    expect(await toReplayInput(first.case)).toMatchObject({
      case_id: first.case.case_id,
      base_commit: fixture.base,
      prompt: {
        content: "repair the private failure",
        prompt_sha: fixture.promptSha,
        source: "prompt_artifact",
        artifact: {
          ref: first.case.evidence.prompt.ref,
          sha256: first.case.evidence.prompt.sha256,
        },
      },
    });
    expect(await readdir(path.dirname(first.case_path))).toEqual(["case.json"]);
    expect(await readFile(first.case_path, "utf8")).not.toContain("repair the private failure");
  });

  it("accepts success telemetry only with an explicit verdict and rejects secrets", async () => {
    const fixture = await createFixture("success");
    await expect(fixture.capture.capture({
      ...captureInput(fixture.repo, fixture.base, "false"),
      failure_statement: "",
    })).rejects.toThrow("--failure is required");
    await expect(fixture.capture.capture({
      ...captureInput(fixture.repo, fixture.base, "false"),
      failure_statement: `credential sk-${"a".repeat(48)}`,
    })).rejects.toThrow("recognized secret");

    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    expect(captured.status).toBe("CAPTURED");
  });

  it("requires explicit repo/base for legacy runs and records a concern", async () => {
    const fixture = await createFixture("failed", false);
    await expect(fixture.capture.capture({
      ...captureInput(fixture.repo, fixture.base, "false"),
      repo_root: undefined,
      base_commit: undefined,
    })).rejects.toThrow("legacy run requires explicit --repo and --base");

    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    expect(captured.case.source.provenance_kind).toBe("user_override");
    expect(captured.case.concerns).toContain("legacy_provenance_override");
    expect(captured.case.concerns).toContain("legacy_prompt_from_trajectory");
    expect(await toReplayInput(captured.case)).toMatchObject({
      prompt: {
        content: "repair the private failure",
        source: "legacy_trajectory",
      },
    });
  });

  it("fails closed when a legacy trajectory cannot identify one user prompt", async () => {
    const fixture = await createFixture("failed", false);
    await writeFile(path.join(fixture.runRoot, "run-1", "trajectory.json"), JSON.stringify({
      messages: [
        { role: "user", content: "first task" },
        { role: "user", content: "second task" },
      ],
    }));
    await expect(fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false")))
      .rejects.toThrow("exactly one replayable user prompt");
  });

  it("changes identity when the verifier changes", async () => {
    const fixture = await createFixture("failed");
    const first = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    const second = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f missing"));
    expect(second.case.case_id).not.toBe(first.case.case_id);
  });

  it("pins legacy symbolic revisions and changes identity with the base commit", async () => {
    const fixture = await createFixture("failed", false);
    const first = await fixture.capture.capture(captureInput(fixture.repo, "HEAD", "false"));
    await writeFile(path.join(fixture.repo, "next.txt"), "next\n", "utf8");
    await git(fixture.repo, ["add", "next.txt"]);
    await git(fixture.repo, ["commit", "-m", "next"]);
    const nextBase = await git(fixture.repo, ["rev-parse", "HEAD"]);
    const second = await fixture.capture.capture(captureInput(fixture.repo, "HEAD", "false"));

    expect(first.case.source.base_commit).toBe(fixture.base);
    expect(second.case.source.base_commit).toBe(nextBase);
    expect(second.case.case_id).not.toBe(first.case.case_id);
  });
});

describe("private regression preflight", () => {
  it("classifies base red without changing the source repository", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f fixed.txt"));
    const before = await gitState(fixture.repo);
    const result = await fixture.preflight.run(captured.case.case_id);

    expect(result.status).toBe("BASE_RED");
    expect(result.actual_exit).not.toBe(0);
    expect(result.source_main_unchanged).toBe(true);
    expect(result.temporary_worktree).toBeNull();
    expect(await gitState(fixture.repo)).toEqual(before);
  });

  it("rejects a verifier that is already green", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f README.md"));
    const result = await fixture.preflight.run(captured.case.case_id);
    expect(result.status).toBe("INVALID_CASE");
    expect(result.actual_exit).toBe(0);
  });

  it("reports timeout and artifact tampering as infrastructure errors", async () => {
    const fixture = await createFixture("failed");
    const timeoutCase = await fixture.capture.capture({
      ...captureInput(fixture.repo, fixture.base, "sleep 1"),
      timeout_ms: 25,
    });
    const timeout = await fixture.preflight.run(timeoutCase.case.case_id);
    expect(timeout.status).toBe("INFRA_ERROR");
    expect(timeout.errors).toContain("verifier timed out");

    const tamperedCase = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    await writeFile(path.join(fixture.runRoot, "run-1", "summary.json"), "{}\n", "utf8");
    const tampered = await fixture.preflight.run(tamperedCase.case.case_id);
    expect(tampered.status).toBe("INFRA_ERROR");
    expect(tampered.artifact_hashes_match).toBe(false);
  });

  it("fails closed when trajectory evidence changes", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    await writeFile(path.join(fixture.runRoot, "run-1", "trajectory.json"), "{}\n", "utf8");
    const result = await fixture.preflight.run(captured.case.case_id);

    expect(result.status).toBe("INFRA_ERROR");
    expect(result.artifact_hashes_match).toBe(false);
  });

  it("fails closed when the replayable prompt artifact changes", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    await writeFile(path.join(fixture.runRoot, "run-1", "prompt.json"), JSON.stringify({
      schema_version: "xio-run-prompt.v2",
      content: "tampered prompt",
      prompt_sha: "a".repeat(64),
    }));
    const result = await fixture.preflight.run(captured.case.case_id);

    expect(result.status).toBe("INFRA_ERROR");
    expect(result.artifact_hashes_match).toBe(false);
    await expect(toReplayInput(captured.case)).rejects.toThrow("prompt artifact hash mismatch");
  });

  it("classifies dirty provenance drift as infrastructure without changing source", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    await writeFile(path.join(fixture.repo, "drift.txt"), "drift\n", "utf8");
    const before = await gitState(fixture.repo);
    const result = await fixture.preflight.run(captured.case.case_id);

    expect(result.status).toBe("INFRA_ERROR");
    expect(result.concerns).toContain("source_dirty_state_changed_since_run");
    expect(result.source_main_unchanged).toBe(true);
    expect(await gitState(fixture.repo)).toEqual(before);
  });

  it("cleans the worktree when verifier launch throws", async () => {
    const fixture = await createRegressionFixture(
      temporaryRoots,
      "failed",
      true,
      { SHELL: "/definitely/missing/xio-shell" },
    );
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    const result = await fixture.preflight.run(captured.case.case_id);

    expect(result.status).toBe("INFRA_ERROR");
    expect(result.temporary_worktree).toBeNull();
    expect(await git(fixture.repo, ["branch", "--list", "xio/regress-*"])).toBe("");
  });

  it("classifies a verifier process crash as infrastructure", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(
      fixture.repo,
      fixture.base,
      "kill -SEGV $$",
    ));
    const result = await fixture.preflight.run(captured.case.case_id);

    expect(result.status).toBe("INFRA_ERROR");
    expect(result.errors.join("\n")).toMatch(/signal|crashed/);
  });

  it("retains an auditable worktree path when cleanup fails", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    vi.spyOn(WorktreeSandbox, "remove").mockRejectedValueOnce(new Error("simulated cleanup failure"));
    const result = await fixture.preflight.run(captured.case.case_id);
    expect(result.status).toBe("INFRA_ERROR");
    expect(result.temporary_worktree).toContain(".worktrees");
    expect(result.errors.join("\n")).toContain("cleanup failed");
  });

  it("classifies missing commits and command launch failures as infrastructure", async () => {
    const fixture = await createFixture("failed");
    const missingCommand = await fixture.capture.capture(captureInput(
      fixture.repo,
      fixture.base,
      "command-that-does-not-exist-xio",
    ));
    const crashed = await fixture.preflight.run(missingCommand.case.case_id);
    expect(crashed.status).toBe("INFRA_ERROR");
    expect(crashed.errors).toContain("verifier command could not be executed");

    const missingCommit = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    await rm(fixture.repo, { recursive: true, force: true });
    await mkdir(fixture.repo, { recursive: true });
    await initRepo(fixture.repo, "replacement\n");
    const missing = await fixture.preflight.run(missingCommit.case.case_id);
    expect(missing.status).toBe("INFRA_ERROR");
    expect(missing.errors.join("\n")).toContain("base commit is unavailable");
  });

  it("fails closed on case schema and identity tampering", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    const casePath = captured.case_path;
    const raw = JSON.parse(await readFile(casePath, "utf8")) as Record<string, unknown>;
    expect(() => decodePrivateRegressionCase({ ...raw, schema_version: "private-regression-case.v2" }))
      .toThrow("unsupported schema");

    const source = raw.source as Record<string, unknown>;
    await writeFile(casePath, `${JSON.stringify({
      ...raw,
      source: { ...source, base_commit: "f".repeat(40) },
    })}\n`);
    await expect(fixture.preflight.run(captured.case.case_id)).rejects.toThrow("case identity mismatch");
  });
});

describe("private regression compare", () => {
  it("reports FIXED when the candidate satisfies the frozen verifier", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f fixed.txt"));
    const candidate = path.join(fixture.root, "candidate");
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "fixed.txt"), "ok\n", "utf8");
    const before = await gitState(fixture.repo);

    const result = await fixture.compare.evaluate({
      caseId: captured.case.case_id,
      candidateRoot: candidate,
    });

    expect(result.status).toBe("FIXED");
    expect(result.before.kind).toBe("pinned_base");
    expect(result.before.actual_exit).not.toBe(0);
    expect(result.candidate.actual_exit).toBe(0);
    expect(result.temporary_worktree).toBeNull();
    expect(result.source_main_unchanged).toBe(true);
    expect(await gitState(fixture.repo)).toEqual(before);
    expect(await readFile(path.join(candidate, "fixed.txt"), "utf8")).toBe("ok\n");
    expect(JSON.parse(await readFile(path.join(path.dirname(captured.case_path), "compare.json"), "utf8")))
      .toMatchObject({ schema_version: "private-regression-compare.v1", status: "FIXED" });
  });

  it("reports STILL_RED when the candidate remains red", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f fixed.txt"));
    const candidate = path.join(fixture.root, "candidate");
    await mkdir(candidate, { recursive: true });

    const result = await fixture.compare.evaluate({
      caseId: captured.case.case_id,
      candidateRoot: candidate,
    });

    expect(result.status).toBe("STILL_RED");
    expect(result.candidate.actual_exit).not.toBe(0);
  });

  it("reports INVALID_CASE when before is already green", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f README.md"));
    const result = await fixture.compare.evaluate({
      caseId: captured.case.case_id,
      candidateRoot: fixture.repo,
    });
    expect(result.status).toBe("INVALID_CASE");
    expect(result.before.actual_exit).toBe(0);
  });

  it("accepts an explicit before root and never removes the candidate", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "test -f fixed.txt"));
    const beforeRoot = path.join(fixture.root, "before");
    const candidate = path.join(fixture.root, "candidate");
    await mkdir(beforeRoot, { recursive: true });
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "fixed.txt"), "ok\n", "utf8");

    const result = await fixture.compare.evaluate({
      caseId: captured.case.case_id,
      candidateRoot: candidate,
      beforeRoot,
    });

    expect(result.status).toBe("FIXED");
    expect(result.before.kind).toBe("explicit");
    expect(result.before.root).toBe(await realpath(beforeRoot));
    expect(await readFile(path.join(candidate, "fixed.txt"), "utf8")).toBe("ok\n");
  });

  it("reports INFRA_ERROR for unavailable candidate paths and hash mismatches", async () => {
    const fixture = await createFixture("failed");
    const captured = await fixture.capture.capture(captureInput(fixture.repo, fixture.base, "false"));
    const missing = await fixture.compare.evaluate({
      caseId: captured.case.case_id,
      candidateRoot: path.join(fixture.root, "missing-candidate"),
    });
    expect(missing.status).toBe("INFRA_ERROR");
    expect(missing.errors.join("\n")).toContain("path is unavailable");

    await writeFile(path.join(fixture.runRoot, "run-1", "summary.json"), "{}\n", "utf8");
    const tampered = await fixture.compare.evaluate({
      caseId: captured.case.case_id,
      candidateRoot: fixture.repo,
    });
    expect(tampered.status).toBe("INFRA_ERROR");
    expect(tampered.artifact_hashes_match).toBe(false);
  });
});
