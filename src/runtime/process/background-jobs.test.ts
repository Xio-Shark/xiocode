import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KernelSession } from "./kernel-session.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("background jobs on kernel services", () => {
  let tempDir: string;
  let workspace: string;
  let session: KernelSession;

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-bg-")));
    workspace = path.join(tempDir, "ws");
    fs.mkdirSync(workspace);
    session = await KernelSession.open({ sessionId: "bg", workspaceRoot: workspace, domainPath: path.join(tempDir, "domain") });
  });

  afterEach(async () => {
    await session.jobs.stopAll();
    session.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps a server running past the call, merges stderr into its log, and stops it with a confirmed stop", async () => {
    const pidFile = path.join(workspace, "server.pid");
    const { job, output } = await session.jobs.start({
      command: `echo $$ > ${pidFile}; echo listening; echo warn >&2; exec sleep 30`,
      cwd: workspace,
      env,
      settleMs: 500,
    });
    expect(job).toMatchObject({ id: "job-1", state: "running", cwd: workspace });
    expect(output).toContain("listening");
    expect(output).toContain("warn");
    expect(job.logPath.startsWith(session.domainPath)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);
    expect(session.jobs.list().map((j) => j.id)).toEqual(["job-1"]);

    const stopped = await session.jobs.stop("job-1");
    expect(stopped.state).toBe("stopped");
    expect(session.operationOutcome(stopped.opId)).not.toBe("indeterminate");
    expect(await waitFor(() => !isAlive(pid), 2000)).toBe(true);
  });

  it("reports a job that exits on its own with its exit code", async () => {
    const { job, output } = await session.jobs.start({ command: "echo bye; exit 3", cwd: workspace, env, settleMs: 2000 });
    expect(output).toContain("bye");
    expect(job.state).toBe("exited");
    expect(job.exit?.code).toBe(3);
    // stopping an exited job changes nothing
    expect((await session.jobs.stop(job.id)).state).toBe("exited");
  });

  it("returns the end of a long log and names the file for the rest", async () => {
    const { job } = await session.jobs.start({
      command: "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; sleep 30",
      cwd: workspace,
      env,
      settleMs: 1000,
    });
    const tail = session.jobs.output(job.id, 200);
    expect(tail).toContain("line-1999");
    expect(tail).not.toContain("line-0\n");
    expect(tail).toContain(job.logPath);
  });

  it("stops every running job at the end and refuses unknown ids by name", async () => {
    await session.jobs.start({ command: "sleep 30", cwd: workspace, env, settleMs: 100 });
    await session.jobs.start({ command: "sleep 30", cwd: workspace, env, settleMs: 100 });
    expect(await session.jobs.stopAll()).toEqual([]);
    expect(session.jobs.list().map((j) => j.state)).toEqual(["stopped", "stopped"]);
    expect(() => session.jobs.output("job-9")).toThrow(/no background job job-9 \(known: job-1, job-2\)/);
  });

  it("takes no workspace write lease: a foreground write runs while a job is up", async () => {
    await session.jobs.start({ command: "sleep 30", cwd: workspace, env, settleMs: 100 });
    const write = await session.run({ command: "/bin/sh", args: ["-c", "echo x > f.txt"], cwd: workspace, env });
    expect(write.code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "f.txt"), "utf8")).toBe("x\n");
  });
});

describe("foreground leftovers", () => {
  it("says when the kernel stopped processes a command left running", async () => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-leftover-")));
    const session = await KernelSession.open({ sessionId: "lo", workspaceRoot: tempDir, domainPath: path.join(tempDir, "domain") });
    try {
      const pidFile = path.join(tempDir, "bg.pid");
      const result = await session.run({
        command: "/bin/sh",
        args: ["-c", `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}`],
        cwd: tempDir,
        env,
      });
      expect(result.code).toBe(0);
      expect(result.leftoversStopped).toBe(true);
      expect(await waitFor(() => !isAlive(Number(fs.readFileSync(pidFile, "utf8"))), 2000)).toBe(true);

      const clean = await session.run({ command: "/bin/sh", args: ["-c", "echo ok"], cwd: tempDir, env });
      expect(clean.leftoversStopped).toBeUndefined();
    } finally {
      session.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
