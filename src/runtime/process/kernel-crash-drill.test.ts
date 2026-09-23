import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExecutionDomain, NodePlatformDriver } from "@xioflow/kernel";

import { KernelProcessRunner } from "./kernel-adapter.ts";

/**
 * Crash drill: a supervised command is in flight, its owner dies with SIGKILL,
 * and the next launch of the same session must adjudicate what was left behind.
 *
 * Unlike the simulated-crash test in kernel-adapter.test.ts, the process here is
 * real: bash holds the output pipe open through a background child, so the group
 * outlives the killed leader exactly like a crashed session would leave it.
 */
const sessionId = "crash-drill-session";
const runId = `run-${sessionId}-t1`;

function runnerFor(domainPath: string): KernelProcessRunner {
  return new KernelProcessRunner({ sessionId, turnId: "t1", domainPath });
}

function processGroupAlive(pid: number): boolean {
  // Zombie-aware: on Linux a reaped-by-nobody orphan stays in the process table
  // and makes kill(-pgid, 0) succeed even though it can never work again.
  try {
    process.kill(-pid, 0);
  } catch {
    return false;
  }
  try {
    const states = execFileSync("ps", ["-A", "-o", "pgid=,state="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return states.split("\n").some((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      if (!match) return false;
      const state = match[2] ?? "";
      return Number.parseInt(match[1] ?? "", 10) === pid && state.charAt(0) !== "Z";
    });
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

// This drill needs the recovery fix that ships in @xioflow/kernel 0.1.5 (zombie
// leaders are not alive, and a group whose owner died gets reaped). Against an
// older published kernel the leftover operation is parked as indeterminate on
// purpose, so the assertions below would be wrong: skip loudly instead of
// pretending it passed, and it starts running as soon as the dependency is bumped.
const kernelSupportsGroupReaping = (() => {
  try {
    const driver = new NodePlatformDriver() as { terminateGroup?: unknown };
    return typeof driver.terminateGroup === "function";
  } catch {
    return false;
  }
})();

describe.skipIf(!kernelSupportsGroupReaping || process.platform === "win32")("kernel crash drill", () => {
  it("adjudicates a real SIGKILLed owner, reaps the group, and keeps the domain usable", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "xiocode-crash-drill-"));
    const domainPath = path.join(workspace, "kernel", sessionId);
    const record = path.join(workspace, "crashed.json");
    const marker = path.join(workspace, "alive.txt");

    const owner = runnerFor(domainPath);
    let ownerStillRunning = true;
    try {
      // `$$` is the group leader (the kernel spawns detached); the background
      // child inherits the group and keeps the output pipe open.
      void owner.run({
        command: "/bin/sh",
        args: ["-c", `echo "$$" > ${marker} && sleep 30 & wait`],
        cwd: workspace,
        output: { headBytes: 1024, tailBytes: 0, hardCapBytes: 64_000 },
      }).catch(() => undefined);
      await waitForFile(marker);

      const leaderPid = Number.parseInt(readFileSync(marker, "utf8").trim(), 10);
      expect(Number.isInteger(leaderPid)).toBe(true);
      expect(processGroupAlive(leaderPid)).toBe(true);

      // Record the group identity, then lose the owner without any cleanup:
      // this is the crashed-session state (intent recorded, no terminal result).
      writeFileSync(record, JSON.stringify({ leaderPid }), "utf8");
      owner.close();
      try {
        process.kill(leaderPid, "SIGKILL");
      } catch {
        // the leader may already be gone; the group check below is the assertion
      }
      ownerStillRunning = false;
    } finally {
      if (ownerStillRunning) owner.close();
    }

    const runLeaderPid = JSON.parse(readFileSync(record, "utf8")).leaderPid as number;

    // The group outlives the killed leader: this is what recovery has to reap.
    expect(processGroupAlive(runLeaderPid)).toBe(true);

    const reopened = runnerFor(domainPath);
    try {
      const result = await reopened.run({
        command: "/bin/sh",
        args: ["-c", "echo after-recovery"],
        cwd: workspace,
        output: { headBytes: 1024, tailBytes: 0, hardCapBytes: 64_000 },
      });
      expect(result.stdout).toContain("after-recovery");

      const report = reopened.lastRecoveryReport;
      expect(report?.recoveredOperations.length).toBe(1);
      const recovered = report?.recoveredOperations[0];
      // A crashed owner must be adjudicated, not parked as "cannot determine":
      // the lease has to come back so the session can keep working.
      expect(recovered?.resourcesReleased).toBe(true);
      expect(["marked_dead", "stopped_alive_process"]).toContain(recovered?.action);

      const store = reopened.ensureDomain().getStore();
      const crashed = store.getOperation(recovered?.opId ?? "");
      expect(crashed?.status).toBe("done");
      // SIGKILL of the owner is a real termination, not an unknown.
      expect(crashed?.result?.status).not.toBe("indeterminate");

      // The Run is closed out honestly: the crash must not leave it "running".
      expect(store.getRun(runId)?.status).toBe("failed");

      // Reaping: the orphaned group must not outlive the recovery.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(processGroupAlive(runLeaderPid)).toBe(false);

      // Same session, same domain: the id-collision bug from the default switch
      // would show up here as a UNIQUE constraint failure.
      const second = await reopened.run({
        command: "/bin/sh",
        args: ["-c", "echo second"],
        cwd: workspace,
        output: { headBytes: 1024, tailBytes: 0, hardCapBytes: 64_000 },
      });
      expect(second.stdout).toContain("second");
    } finally {
      reopened.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
