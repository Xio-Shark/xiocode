import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExecutionDomain } from "@xioflow/kernel";

import { kernelProcessFlag } from "./kernel-process-flag.ts";
import { mapKernelTermination } from "./kernel-result.ts";
import { KernelSession } from "./kernel-session.ts";
import { defineSupervisorContract } from "./supervisor-contract.testkit.ts";
import type { OutputChunkProjection } from "./output-collector.ts";

const SMALL = { headBytes: 1_024, tailBytes: 0, hardCapBytes: 64_000 } as const;

type Harness = Readonly<{ session: KernelSession; workspace: string; domainPath: string; dispose: () => void }>;

async function openTemp(
  sessionId = "test-session",
  extra: Partial<Parameters<typeof KernelSession.open>[0]> = {},
): Promise<Harness> {
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-kernel-session-")));
  const workspace = path.join(tempDir, "ws");
  fs.mkdirSync(workspace);
  const domainPath = path.join(tempDir, "domain");
  const session = await KernelSession.open({ sessionId, workspaceRoot: workspace, domainPath, ...extra });
  return {
    session,
    workspace,
    domainPath,
    dispose: () => {
      session.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Reads the domain a session left behind (after close) without going through the session. */
function inspect<T>(domainPath: string, domainId: string, read: (domain: ExecutionDomain) => T): T {
  const domain = ExecutionDomain.acquire(domainPath, domainId);
  try {
    return read(domain);
  } finally {
    domain.close();
  }
}

defineSupervisorContract("KernelSession", async () => {
  const harness = await openTemp();
  return { run: (options) => harness.session.run(options), dispose: harness.dispose };
});

describe("KernelSession: product semantics", () => {
  it("passes stdin through a one-shot pipe", async () => {
    const h = await openTemp();
    try {
      const result = await h.session.run({
        command: process.execPath,
        args: [
          "-e",
          "const c=[];process.stdin.on('data',(b)=>c.push(b));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(c).toString('utf8').toUpperCase()))",
        ],
        cwd: h.workspace,
        stdin: "adapter stdin",
        timeoutMs: 5_000,
        output: SMALL,
      });
      expect(result.termination).toBe("exited");
      expect(result.stdout).toBe("ADAPTER STDIN");
      expect(result.kernel?.domainPath).toBe(h.domainPath);
    } finally {
      h.dispose();
    }
  });

  it("keeps explicit-env semantics: whitelist only, never the host environment", async () => {
    const h = await openTemp();
    try {
      const probe = "process.stdout.write((process.env.XIO_PROBE ?? 'unset') + '|' + (process.env.PATH ? 'has-path' : 'no-path'))";
      const whitelisted = await h.session.run({
        command: process.execPath,
        args: ["-e", probe],
        cwd: h.workspace,
        env: { XIO_PROBE: "visible" },
        output: SMALL,
      });
      expect(whitelisted.stdout).toBe("visible|no-path");
    } finally {
      h.dispose();
    }
  });

  it("maps a binary that never started to spawn_error", async () => {
    const h = await openTemp();
    try {
      const result = await h.session.run({
        command: "/nonexistent/xiocode-adapter-probe",
        cwd: h.workspace,
        output: SMALL,
      });
      expect(result.termination).toBe("spawn_error");
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/ENOENT/);
    } finally {
      h.dispose();
    }
  });

  it("rebuilds head+tail output from the kernel spill artifact", async () => {
    const h = await openTemp();
    try {
      const result = await h.session.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('H'.repeat(4000)); process.stdout.write('T'.repeat(4000));"],
        cwd: h.workspace,
        timeoutMs: 5_000,
        output: { headBytes: 512, tailBytes: 512, hardCapBytes: 1024 * 1024 },
      });
      expect(result.stdoutTruncated).toBe(true);
      expect(result.bytesSeen.stdout).toBe(8_000);
      expect(result.stdout.startsWith("[process_output spilled: ")).toBe(true);
      expect(result.stdout).toContain("…[truncated]…");
      expect(result.stdout.endsWith("T".repeat(512))).toBe(true);
      expect(fs.statSync(result.spillPaths!.stdout!).size).toBe(8_000);
    } finally {
      h.dispose();
    }
  });

  it("projects onOutput lines and trims over-long lines", async () => {
    const h = await openTemp();
    try {
      const projections: OutputChunkProjection[] = [];
      const result = await h.session.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('line-1\\nline-2\\npartial'); process.stderr.write('err-line\\n')"],
        cwd: h.workspace,
        output: SMALL,
        onOutput: (chunk) => projections.push(chunk),
      });
      expect(projections.filter((p) => p.stream === "stdout").map((p) => p.text).join("")).toBe("line-1\nline-2\n");
      expect(projections.filter((p) => p.stream === "stderr").map((p) => p.text).join("")).toBe("err-line\n");
      expect(result.stdout).toBe("line-1\nline-2\npartial");

      const trimmed: OutputChunkProjection[] = [];
      await h.session.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('A'.repeat(100) + '\\n')"],
        cwd: h.workspace,
        output: { ...SMALL, maxLineBytes: 32 },
        onOutput: (chunk) => trimmed.push(chunk),
      });
      expect(trimmed).toEqual([{ stream: "stdout", text: `${"A".repeat(31)}\n`, droppedBytes: 69 }]);
    } finally {
      h.dispose();
    }
  });
});

describe("KernelSession: Run per turn", () => {
  it("attributes operations to the turn's Run and reports it through the completion protocol", async () => {
    const h = await openTemp("turns");
    const quick = { command: process.execPath, args: ["-e", "0"], cwd: h.workspace, output: SMALL } as const;
    const ids = { domainId: "turns", runs: [] as string[] };
    try {
      await h.session.run(quick); // before any turn → launch Run
      const ok = h.session.beginTurn("t1");
      await h.session.run(quick);
      expect(h.session.endTurn({ status: "succeeded" })).toEqual({ runId: ok, status: "succeeded" });

      const accepted = h.session.beginTurn("t2");
      h.session.endTurn({
        status: "succeeded",
        acceptance: { passed: false, summary: "done contract: FAIL [test:fail(1)]", commands: [{ name: "test", exitCode: 1, passed: false }] },
      });
      const cancelled = h.session.beginTurn("t3");
      h.session.endTurn({ status: "cancelled" });
      expect(h.session.currentRunId).toBe(h.session.launchRunId);
      ids.runs.push(ok, accepted, cancelled, h.session.launchRunId);
    } finally {
      h.session.close();
    }

    inspect(h.domainPath, ids.domainId, (domain) => {
      const store = domain.getStore();
      const [ok, accepted, cancelled, launch] = ids.runs;
      expect(store.getOperationsByRun(ok!).length).toBe(1);
      expect(store.getOperationsByRun(launch!).length).toBe(1);
      expect(store.getRun(accepted!)?.status).toBe("failed");
      expect(store.getRun(cancelled!)?.status).toBe("cancelled");
      // close() ends the launch Run instead of leaving it `running`.
      expect(store.getRun(launch!)?.status).toBe("succeeded");
      const acceptance = store.getEventsByRun(accepted!).find((e) => e.type === "XIOCODE_ACCEPTANCE");
      expect(acceptance?.payload).toMatchObject({ passed: false });
    });
    h.dispose();
  });

  it("converges Runs a crashed launch left running before opening its own", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-kernel-stale-run-"));
    const domainPath = path.join(tempDir, "domain");
    try {
      const crashed = ExecutionDomain.acquire(domainPath, "stale");
      crashed.getStore().saveTask({ id: "session-stale", domainId: "stale", name: "s", createdAt: new Date().toISOString() });
      crashed.getStore().saveRun({
        id: "session-stale-turn-old",
        taskId: "session-stale",
        domainId: "stale",
        owner: "stale",
        status: "running",
        startedAt: new Date().toISOString(),
      });
      crashed.close();

      const session = await KernelSession.open({ sessionId: "stale", workspaceRoot: tempDir, domainPath });
      try {
        const status = session.status();
        expect(status.runs.find((r) => r.id === "session-stale-turn-old")?.status).toBe("failed");
        expect(status.activeRuns.map((r) => r.id)).toEqual([session.launchRunId]);
      } finally {
        session.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("adjudicates operations a crashed owner left behind and reports them", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-kernel-recovery-"));
    const domainPath = path.join(tempDir, "domain");
    try {
      const crashed = ExecutionDomain.acquire(domainPath, "crash-session");
      const store = crashed.getStore();
      store.saveTask({ id: "session-crash-session", domainId: "crash-session", name: "c", createdAt: new Date().toISOString() });
      store.saveRun({
        id: "run-old",
        taskId: "session-crash-session",
        domainId: "crash-session",
        owner: "crash-session",
        status: "running",
        startedAt: new Date().toISOString(),
      });
      crashed.registerOperationIntent({
        id: "crashed-op-1",
        runId: "run-old",
        kind: "process",
        name: "process:/bin/sh",
        inputFingerprint: "fp",
        requiredResources: ["process:crashed-op-1"],
        status: "pending",
      });
      store.updateOperationStatus("crashed-op-1", "active", { pid: 999_999, spawnTime: new Date().toISOString() });
      crashed.close();

      const session = await KernelSession.open({ sessionId: "crash-session", workspaceRoot: tempDir, domainPath });
      try {
        expect(session.recoveryReport?.recoveredOperations).toEqual([
          { opId: "crashed-op-1", action: "marked_dead", resourcesReleased: true },
        ]);
        const after = await session.run({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"], cwd: tempDir, output: SMALL });
        expect(after.stdout).toBe("ok");
      } finally {
        session.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("KernelSession: workspace write lease", () => {
  it("queues a writer behind another writer and lets readers through", async () => {
    const h = await openTemp("lease");
    try {
      // The first writer holds the lease until the test releases it, so the
      // queueing below does not depend on how long a spawn takes.
      const marker = path.join(h.workspace, "first-started");
      const release = path.join(h.workspace, "release-first");
      const finished = path.join(h.workspace, "first-finished");
      const firstScript = [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(marker)}, '1');`,
        `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) {`,
        `  fs.writeFileSync(${JSON.stringify(finished)}, '1'); clearInterval(t); } }, 10);`,
      ].join(" ");
      const first = h.session.run({ command: process.execPath, args: ["-e", firstScript], cwd: h.workspace, output: SMALL });
      while (!fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 10));

      const reader = await h.session.run({
        command: process.execPath, args: ["-e", "process.stdout.write('r')"], cwd: h.workspace, output: SMALL, access: "read",
      });
      expect(reader.stdout).toBe("r");
      expect(reader.stderr).not.toContain("queued behind");

      const secondProbe = `process.stdout.write(require('fs').existsSync(${JSON.stringify(finished)}) ? 'after' : 'overlap')`;
      const second = h.session.run({
        command: process.execPath, args: ["-e", secondProbe], cwd: h.workspace, output: SMALL,
      });
      fs.writeFileSync(release, "1");
      const [firstResult, secondResult] = await Promise.all([first, second]);
      // The queued writer only started once the first writer had finished.
      expect(secondResult.stdout).toBe("after");
      expect(secondResult.stderr).toContain(`queued behind ${firstResult.kernel?.opId}`);
    } finally {
      h.dispose();
    }
  });

  it("refuses a writer while an indeterminate operation holds the lease, and says how to resolve it", async () => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-kernel-indet-")));
    const domainPath = path.join(tempDir, "domain");
    const lease = `workspace:write:${tempDir}`;
    try {
      const prior = ExecutionDomain.acquire(domainPath, "indet");
      const store = prior.getStore();
      store.saveTask({ id: "session-indet", domainId: "indet", name: "i", createdAt: new Date().toISOString() });
      store.saveRun({ id: "run-prior", taskId: "session-indet", domainId: "indet", owner: "indet", status: "running", startedAt: new Date().toISOString() });
      prior.registerOperationIntent({
        id: "stuck-op", runId: "run-prior", kind: "process", name: "process:/bin/sh",
        inputFingerprint: "fp", requiredResources: [lease], status: "pending",
      });
      store.recordOperationResult("stuck-op", {
        kind: "indeterminate", status: "indeterminate", reason: "stop not confirmed",
        recoveryGuidance: "inspect", durationMs: 1, completedAt: new Date().toISOString(),
      }, false);
      prior.close();

      const session = await KernelSession.open({ sessionId: "indet", workspaceRoot: tempDir, domainPath });
      try {
        const refused = await session.run({ command: process.execPath, args: ["-e", "0"], cwd: tempDir, output: SMALL });
        expect(refused.termination).toBe("spawn_error");
        expect(refused.stderr).toContain("indeterminate operation stuck-op");
        expect(refused.stderr).toContain("/kernel adjudicate stuck-op");
        expect(refused.stderr).toContain(`--domain ${domainPath}`);

        const reader = await session.run({ command: process.execPath, args: ["-e", "process.stdout.write('r')"], cwd: tempDir, output: SMALL, access: "read" });
        expect(reader.stdout).toBe("r");
      } finally {
        session.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("KernelSession: identity, snapshots, lifecycle", () => {
  it("maps an operation key to its latest operation without reusing opIds", async () => {
    const h = await openTemp("keyed");
    const run = (text: string) => h.session.run({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
      cwd: h.workspace,
      output: SMALL,
      operationKey: "call_0",
    });
    try {
      expect(h.session.getOperationByKey("call_0")).toBeUndefined();
      const first = await run("same");
      // Providers that number tool calls per response reuse ids: the second call
      // must really run (no replay of the first result, no id conflict).
      const second = await run("same");
      const third = await run("different");
      expect(new Set([first.kernel?.opId, second.kernel?.opId, third.kernel?.opId]).size).toBe(3);
      expect(second.kernel?.replayed).toBeUndefined();
      expect(third.stdout).toBe("different");

      const fact = h.session.getOperationByKey("call_0");
      expect(fact?.opId).toBe(third.kernel?.opId);
      expect(fact?.result).toMatchObject({ kind: "process", status: "succeeded", stdout: "different" });
    } finally {
      h.dispose();
    }
  });

  it("captures, rolls back and prunes workspace snapshots", async () => {
    const h = await openTemp("snap");
    const git = (args: string[]) => execFileSync("git", args, { cwd: h.workspace, encoding: "utf8" });
    try {
      git(["init", "-q", "-b", "main"]);
      git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
      fs.writeFileSync(path.join(h.workspace, "a.txt"), "v1\n");
      const snapshot = await h.session.captureSnapshot();
      fs.writeFileSync(path.join(h.workspace, "a.txt"), "v2\n");
      expect(await h.session.currentTreeAgainst(snapshot)).not.toBe(snapshot.treeFingerprint);
      // Nothing ran through the kernel since the snapshot: nothing can have escaped the roots.
      // Ignored files were not snapshotted and no manifest was taken, so the claim stops short of complete.
      const clean = await h.session.rollback(snapshot.id);
      expect(clean).toMatchObject({
        status: "restored",
        coverage: "non_ignored",
        outOfScopeEffects: "none_possible",
        ignoredFiles: "not_captured",
        coverageBasis: ["all_ops_confined", "ignored_not_captured"],
      });

      // An unconfined command since the snapshot could have written anywhere.
      await h.session.run({
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('a.txt', 'v3\\n')"],
        cwd: h.workspace,
        output: SMALL,
      });
      const rolled = await h.session.rollback(snapshot.id);
      expect(rolled.status).toBe("restored");
      expect(rolled.coverage).toBe("declared_roots");
      expect(rolled.outOfScopeEffects).toBe("possible");
      expect(rolled.coverageBasis).toEqual(["unconfined_op_since_snapshot", "ignored_not_captured"]);
      expect(fs.readFileSync(path.join(h.workspace, "a.txt"), "utf8")).toBe("v1\n");

      expect(await h.session.pruneSnapshots([snapshot.id])).toEqual([snapshot.id]);
      expect(h.session.listSnapshotIds()).toEqual([]);
      expect(git(["for-each-ref", "refs/xioflow/snapshots"])).toBe("");
    } finally {
      h.dispose();
    }
  });

  it("deletes an ephemeral domain on a clean close and refuses work afterwards", async () => {
    const h = await openTemp("ephemeral-x", { ephemeral: true });
    await h.session.run({ command: process.execPath, args: ["-e", "0"], cwd: h.workspace, output: SMALL });
    expect(h.session.close()).toBeUndefined();
    expect(fs.existsSync(h.domainPath)).toBe(false);
    await expect(h.session.run({ command: process.execPath, args: ["-e", "0"], cwd: h.workspace, output: SMALL }))
      .rejects.toThrow(/closed/);
    h.dispose();
  });
});

describe("mapKernelTermination", () => {
  it("maps every kernel stop reason onto the product vocabulary", () => {
    expect(mapKernelTermination(undefined)).toEqual({ termination: "exited" });
    expect(mapKernelTermination("user_cancelled").termination).toBe("aborted");
    expect(mapKernelTermination("timed_out").termination).toBe("timed_out");
    expect(mapKernelTermination("output_exceeded").termination).toBe("output_limit");
    for (const reason of ["memory_exceeded", "cpu_exceeded", "pids_exceeded", "resource_preempted", "crash_detected"] as const) {
      const mapped = mapKernelTermination(reason);
      expect(mapped.termination).toBe("cleanup_failed");
      expect(mapped.cleanupError).toContain(reason);
    }
  });
});

describe("kernelProcessFlag", () => {
  it("is on by default, off when explicitly disabled, and honest about why", () => {
    const byDefault = kernelProcessFlag({});
    expect(byDefault.source).toBe("default");
    expect(byDefault.enabled).toBe(process.platform !== "win32");
    const disabled = kernelProcessFlag({ XIOCODE_PROCESS_KERNEL: "0" });
    expect(disabled).toMatchObject({ enabled: false, source: "explicit" });
    expect(disabled.reason).toContain("XIOCODE_PROCESS_KERNEL=0");
    expect(kernelProcessFlag({ XIOCODE_PROCESS_KERNEL: "maybe" }).reason).toContain("not a recognized value");
  });
});
