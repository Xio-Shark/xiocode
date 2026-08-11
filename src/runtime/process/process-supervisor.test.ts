import { describe, expect, it } from "vitest";

import {
  createDeadlineSignal,
  forceKillProcessTree,
  runSupervisedProcess,
} from "./process-supervisor.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runSupervisedProcess", () => {
  it("returns stdout/stderr from a short command", async () => {
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi'); process.stderr.write('err')"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      output: { headBytes: 1_024, tailBytes: 1_024, hardCapBytes: 64_000 },
    });
    expect(result.termination).toBe("exited");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.stderr).toBe("err");
  });

  it("aborts descendants in the owned process group", async () => {
    if (process.platform === "win32") {
      return;
    }
    const script = [
      "import { spawn } from 'node:child_process';",
      // Stay in the supervised process group (no nested detached/setsid).
      "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setInterval(()=>{},1000);",
    ].join("");
    const controller = new AbortController();
    const running = runSupervisedProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      output: { headBytes: 1_024, tailBytes: 1_024, hardCapBytes: 64_000 },
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    const result = await running;
    expect(result.aborted || result.termination === "aborted").toBe(true);
    const descendant = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isInteger(descendant) && descendant > 0) {
      // Give reaper a moment; supervisor awaits tree gone before resolve.
      expect(isAlive(descendant)).toBe(false);
    }
  }, 10_000);

  it("cleans residual group after root exits while descendant holds pipes", async () => {
    if (process.platform === "win32") {
      return;
    }
    const script = [
      "import { spawn } from 'node:child_process';",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000)'], { stdio: ['ignore','inherit','inherit'] });",
      "process.stdout.write(String(child.pid)+'\\n');",
      "setTimeout(() => process.exit(0), 30);",
    ].join("");
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      output: { headBytes: 1_024, tailBytes: 1_024, hardCapBytes: 64_000 },
    });
    const descendant = Number.parseInt(result.stdout.trim(), 10);
    expect(result.cleanupError).toBeUndefined();
    expect(isAlive(descendant)).toBe(false);
  }, 10_000);

  it("stops unbounded yes-like output at the hard cap", async () => {
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('y'.repeat(4096)), 0)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      output: { headBytes: 256, tailBytes: 256, hardCapBytes: 8_192 },
    });
    expect(result.outputLimited || result.termination === "output_limit").toBe(true);
    expect(result.bytesSeen.stdout + result.bytesSeen.stderr).toBeGreaterThan(8_192);
    expect(result.peakRetainedBytes).toBeLessThanOrEqual(256 + 256 + 4_096);
    expect(result.durationMs).toBeLessThan(4_000);
  }, 10_000);

  it("surfaces cleanup_failed when the tree refuses to die", async () => {
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 50)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      output: { headBytes: 256, tailBytes: 256, hardCapBytes: 64_000 },
      isTreeAlive: () => true,
      terminateTree: async () => false,
      termGraceMs: 20,
      killDeadlineMs: 20,
    });
    expect(result.termination).toBe("cleanup_failed");
    expect(result.cleanupError).toMatch(/remained alive/i);
  });

  it("honors abort-before-spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", "console.log('nope')"],
      cwd: process.cwd(),
      signal: controller.signal,
      output: { headBytes: 64, tailBytes: 64, hardCapBytes: 1_000 },
    });
    expect(result.termination).toBe("aborted");
    expect(result.aborted).toBe(true);
  });
});

describe("createDeadlineSignal", () => {
  it("aborts on timeout with TimeoutError reason", async () => {
    const { signal, dispose, timedOut } = createDeadlineSignal(undefined, 30);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(timedOut()).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
    dispose();
  });
});

describe("forceKillProcessTree", () => {
  it("ignores invalid pids", () => {
    expect(() => forceKillProcessTree(null)).not.toThrow();
    expect(() => forceKillProcessTree(-1)).not.toThrow();
  });
});
