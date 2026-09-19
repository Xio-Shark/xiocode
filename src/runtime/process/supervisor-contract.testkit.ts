/**
 * Shared contract suite for every `runSupervisedProcess`-compatible
 * implementation: the legacy process-supervisor and the kernel adapter must
 * both satisfy these scenarios, so a switch between them is a verified
 * equivalence rather than a rewrite gamble.
 *
 * Test-only helpers (terminateTree/isTreeAlive seams, createDeadlineSignal,
 * forceKillProcessTree) stay in the legacy test file: the kernel owns its
 * driver-side stop pipeline and deliberately exposes no such seams.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessRunOptions, ProcessRunResult } from "./process-supervisor.ts";

export type SupervisorHarness = Readonly<{
  run: (options: ProcessRunOptions) => Promise<ProcessRunResult>;
  dispose?: () => void | Promise<void>;
}>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defineSupervisorContract(
  name: string,
  createHarness: () => SupervisorHarness | Promise<SupervisorHarness>,
): void {
  describe(`${name}: shared supervisor contract`, () => {
    let harness: SupervisorHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    it("returns stdout/stderr from a short command", async () => {
      const result = await harness.run({
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
      expect(result.stdoutTruncated).toBe(false);
      expect(result.spillPaths).toBeUndefined();
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
      const running = harness.run({
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
      const result = await harness.run({
        command: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        timeoutMs: 5_000,
        output: { headBytes: 1_024, tailBytes: 1_024, hardCapBytes: 64_000 },
      });
      const descendant = Number.parseInt(result.stdout.trim(), 10);
      expect(result.cleanupError).toBeUndefined();
      expect(isAlive(descendant)).toBe(false);
      // The root exited long before the timeout: no operation may hang on pipes.
      expect(result.durationMs).toBeLessThan(4_000);
    }, 10_000);

    it("stops unbounded yes-like output at the hard cap", async () => {
      const result = await harness.run({
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

    it("honors abort-before-spawn", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await harness.run({
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
}
