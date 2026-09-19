import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KernelProcessRunner,
  kernelProcessFlag,
  mapKernelTermination,
  runSupervisedProcessViaKernel,
} from "./kernel-adapter.ts";
import { defineSupervisorContract } from "./supervisor-contract.testkit.ts";

function createTempRunner(
  sessionId = "test-session",
): Readonly<{ runner: KernelProcessRunner; tempDir: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-kernel-adapter-"));
  const runner = new KernelProcessRunner({
    sessionId,
    turnId: "t1",
    domainPath: path.join(tempDir, ".xioflow"),
  });
  return { runner, tempDir };
}

function disposeRunner(runner: KernelProcessRunner, tempDir: string): void {
  runner.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

defineSupervisorContract("KernelProcessRunner (kernel adapter)", () => {
  const { runner, tempDir } = createTempRunner();
  return {
    run: (options) => runner.run(options),
    dispose: () => disposeRunner(runner, tempDir),
  };
});

describe("kernel adapter: product semantics", () => {
  it("passes stdin through a one-shot pipe", async () => {
    const { runner, tempDir } = createTempRunner();
    try {
      const result = await runner.run({
        command: process.execPath,
        args: [
          "-e",
          "const c=[];process.stdin.on('data',(b)=>c.push(b));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(c).toString('utf8').toUpperCase()))",
        ],
        cwd: tempDir,
        stdin: "adapter stdin",
        timeoutMs: 5_000,
        output: { headBytes: 1_024, tailBytes: 0, hardCapBytes: 64_000 },
      });
      expect(result.termination).toBe("exited");
      expect(result.stdout).toBe("ADAPTER STDIN");
    } finally {
      disposeRunner(runner, tempDir);
    }
  });

  it("keeps explicit-env semantics: whitelist only, never the host environment", async () => {
    const { runner, tempDir } = createTempRunner();
    try {
      const probe = "process.stdout.write((process.env.XIO_PROBE ?? 'unset') + '|' + (process.env.PATH ? 'has-path' : 'no-path'))";
      const whitelisted = await runner.run({
        command: process.execPath,
        args: ["-e", probe],
        cwd: tempDir,
        env: { XIO_PROBE: "visible" },
        output: { headBytes: 1_024, tailBytes: 0, hardCapBytes: 64_000 },
      });
      expect(whitelisted.stdout).toBe("visible|no-path");

      const withoutEnv = await runner.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.PATH ? 'inherited' : 'no-env')"],
        cwd: tempDir,
        output: { headBytes: 1_024, tailBytes: 0, hardCapBytes: 64_000 },
      });
      expect(withoutEnv.stdout).toBe("no-env");
    } finally {
      disposeRunner(runner, tempDir);
    }
  });

  it("maps a binary that never started to spawn_error", async () => {
    const { runner, tempDir } = createTempRunner();
    try {
      const result = await runner.run({
        command: "/nonexistent/xiocode-adapter-probe",
        args: [],
        cwd: tempDir,
        output: { headBytes: 1_024, tailBytes: 0, hardCapBytes: 64_000 },
      });
      expect(result.termination).toBe("spawn_error");
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/ENOENT/);
      expect(result.bytesSeen).toEqual({ stdout: 0, stderr: 0 });
    } finally {
      disposeRunner(runner, tempDir);
    }
  });

  it("rebuilds head+tail output from the kernel spill artifact", async () => {
    const { runner, tempDir } = createTempRunner();
    try {
      const result = await runner.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('H'.repeat(4000)); process.stdout.write('T'.repeat(4000));"],
        cwd: tempDir,
        timeoutMs: 5_000,
        output: { headBytes: 512, tailBytes: 512, hardCapBytes: 1024 * 1024 },
      });
      expect(result.termination).toBe("exited");
      expect(result.stdoutTruncated).toBe(true);
      expect(result.bytesSeen.stdout).toBe(8_000);
      expect(result.stdout.startsWith("[process_output spilled: ")).toBe(true);
      expect(result.stdout).toContain("H".repeat(512));
      expect(result.stdout).toContain("…[truncated]…");
      expect(result.stdout.endsWith("T".repeat(512))).toBe(true);

      const spillPath = result.spillPaths?.stdout;
      expect(spillPath).toBeTruthy();
      expect(fs.statSync(spillPath!).size).toBe(8_000);
    } finally {
      disposeRunner(runner, tempDir);
    }
  });

  it("keeps one Task/Run per session and refuses work after close", async () => {
    const { runner, tempDir } = createTempRunner("session-lifecycle");
    try {
      const options = {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: tempDir,
        output: { headBytes: 256, tailBytes: 0, hardCapBytes: 64_000 },
      } as const;
      await runner.run({ ...options });
      await runner.run({ ...options });

      const store = runner.ensureDomain().getStore();
      expect(store.getTask(runner.taskId)).toBeTruthy();
      expect(store.getRun(runner.runId)).toBeTruthy();
      expect(store.getOperationsByRun(runner.runId).length).toBe(2);

      runner.endTurn("succeeded");
      expect(store.getRun(runner.runId)?.status).toBe("succeeded");
    } finally {
      disposeRunner(runner, tempDir);
    }
    await expect(
      runner.run({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: tempDir,
        output: { headBytes: 256, tailBytes: 0, hardCapBytes: 64_000 },
      }),
    ).rejects.toThrow(/closed/);
  });

  it("exposes the one-shot wrapper for single commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-kernel-once-"));
    try {
      const result = await runSupervisedProcessViaKernel(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('once')"],
          cwd: tempDir,
          output: { headBytes: 256, tailBytes: 0, hardCapBytes: 64_000 },
        },
        { sessionId: "one-shot", domainPath: path.join(tempDir, ".xioflow") },
      );
      expect(result.stdout).toBe("once");
      expect(result.termination).toBe("exited");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("mapKernelTermination", () => {
  it("maps every kernel stop reason onto the product vocabulary", () => {
    expect(mapKernelTermination(undefined)).toEqual({ termination: "exited" });
    expect(mapKernelTermination("completed").termination).toBe("exited");
    expect(mapKernelTermination("user_cancelled").termination).toBe("aborted");
    expect(mapKernelTermination("timed_out").termination).toBe("timed_out");
    expect(mapKernelTermination("output_exceeded").termination).toBe("output_limit");

    const governanceReasons = [
      "memory_exceeded",
      "cpu_exceeded",
      "pids_exceeded",
      "resource_preempted",
      "crash_detected",
    ] as const;
    for (const reason of governanceReasons) {
      const mapped = mapKernelTermination(reason);
      expect(mapped.termination).toBe("cleanup_failed");
      expect(mapped.cleanupError).toContain(reason);
    }
  });
});

describe("kernelProcessFlag", () => {
  it("stays off unless explicitly enabled on a supported platform", () => {
    expect(kernelProcessFlag({}).enabled).toBe(false);
    expect(kernelProcessFlag({ XIOCODE_PROCESS_KERNEL: "0" }).enabled).toBe(false);
    expect(kernelProcessFlag({ XIOCODE_PROCESS_KERNEL: "off" }).reason).toContain("not enabled");

    const explicit = kernelProcessFlag({ XIOCODE_PROCESS_KERNEL: "1" });
    if (process.platform === "win32") {
      expect(explicit.enabled).toBe(false);
      expect(explicit.reason).toContain("Windows");
    } else {
      expect(explicit.enabled).toBe(true);
    }
  });
});
