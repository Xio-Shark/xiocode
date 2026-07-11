import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixture } from "../../extensions/xio-regress/test/fixture.ts";
import { parseRegressArgs, runRegressCli } from "./regress-cli.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

describe("xio regress CLI", () => {
  it("parses the stable create contract", () => {
    expect(parseRegressArgs([
      "create",
      "--run", "run-1",
      "--repo", "/tmp/repo",
      "--base", "abc123",
      "--failure-type", "user_task_failure",
      "--failure", "behavior missing",
      "--verify", "npm test",
      "--expect-exit", "0",
      "--timeout-ms", "5000",
      "--json",
    ])).toMatchObject({
      command: "create",
      json: true,
      capture: {
        run_id: "run-1",
        failure_type: "user_task_failure",
        verifier_command: "npm test",
        expected_exit: 0,
        timeout_ms: 5000,
      },
    });
  });

  it("requires the user verdict and verifier", async () => {
    const chunks: string[] = [];
    const code = await runRegressCli(["create", "--run", "run-1"], {
      write: (chunk) => chunks.push(chunk),
    });
    expect(code).toBe(2);
    expect(chunks.join("")).toContain("INVALID_CASE");
    expect(chunks.join("")).toContain("--failure-type is required");
  });

  it("keeps invalid JSON-mode errors machine-readable and secret-safe", async () => {
    const secret = `sk-${"a".repeat(48)}`;
    const chunks: string[] = [];
    const code = await runRegressCli(["create", "--json", secret], {
      write: (chunk) => chunks.push(chunk),
    });
    const output = chunks.join("");

    expect(code).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ status: "INVALID_CASE" });
    expect(output).not.toContain(secret);
    expect(output).toContain("REDACTED");
  });

  it("classifies unavailable run evidence as an invalid case", async () => {
    const chunks: string[] = [];
    const code = await runRegressCli([
      "create",
      "--run", "missing-run",
      "--failure-type", "user_task_failure",
      "--failure", "behavior missing",
      "--verify", "false",
      "--json",
    ], {
      runRoot: "/definitely/missing/xio-runs",
      write: (chunk) => chunks.push(chunk),
    });

    expect(code).toBe(2);
    expect(JSON.parse(chunks.join(""))).toMatchObject({ status: "INVALID_CASE" });
  });

  it("captures and preflights a private case through the CLI", async () => {
    const fixture = await createFixture(temporaryRoots, "success");
    const chunks: string[] = [];
    const code = await runRegressCli([
      "create",
      "--run", "run-1",
      "--repo", fixture.repo,
      "--base", fixture.base,
      "--failure-type", "user_task_failure",
      "--failure", "behavior missing",
      "--verify", "false",
      "--json",
    ], {
      env: { SHELL: "/bin/sh" },
      runRoot: fixture.runRoot,
      store: fixture.store,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      write: (chunk) => chunks.push(chunk),
    });
    const output = JSON.parse(chunks.join("")) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(output).toMatchObject({
      status: "BASE_RED",
      capture_status: "CAPTURED",
      preflight_status: "BASE_RED",
      identity_hashes: { prompt: fixture.promptSha },
    });
    expect((output.identity_hashes as Record<string, unknown>).prompt_artifact)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(chunks.join("")).not.toContain("messages");
  });

  it("parses preflight without accepting unrelated flags", () => {
    expect(parseRegressArgs(["preflight", "--case", "a".repeat(64), "--json"])).toEqual({
      command: "preflight",
      json: true,
      noPreflight: false,
      caseId: "a".repeat(64),
    });
    expect(() => parseRegressArgs(["preflight", "--case", "id", "--verify", "true"]))
      .toThrow("unknown argument");
  });

  it("compares a candidate through the CLI and returns FIXED", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const captured = await fixture.capture.capture({
      run_id: "run-1",
      repo_root: fixture.repo,
      base_commit: fixture.base,
      failure_type: "user_task_failure",
      failure_statement: "the requested behavior is missing",
      verifier_command: "test -f fixed.txt",
    });
    const candidate = path.join(fixture.root, "candidate");
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "fixed.txt"), "ok\n", "utf8");
    const chunks: string[] = [];
    const code = await runRegressCli([
      "compare",
      "--case", captured.case.case_id,
      "--candidate", candidate,
      "--json",
    ], {
      env: { SHELL: "/bin/sh" },
      store: fixture.store,
      write: (chunk) => chunks.push(chunk),
    });
    expect(code).toBe(0);
    expect(JSON.parse(chunks.join(""))).toMatchObject({ status: "FIXED" });
  });
});
