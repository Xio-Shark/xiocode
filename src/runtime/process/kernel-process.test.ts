import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionDomain } from "@xioflow/kernel";

import {
  bindKernelSession,
  closeKernelSession,
  kernelDomainPath,
  notifyKernelFallback,
  resetKernelProcessForTests,
  resolveProcessBackend,
  runSupervisedProcessGated,
  sweepOrphanedDomains,
} from "./kernel-process.ts";
import { createBuiltinTools } from "../tools/builtin.ts";
import { runDoneContract } from "../verify/done-contract.ts";

const ENV_KEYS = ["XIOCODE_PROCESS_KERNEL", "XIOCODE_KERNEL_DOMAIN_ROOT"] as const;
const SMALL = { headBytes: 512, tailBytes: 0, hardCapBytes: 64_000 } as const;
const onPosix = process.platform !== "win32";

function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function domainDatabases(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((entry) => fs.existsSync(path.join(root, entry, "domain.db")));
}

function echo(cwd: string, text: string) {
  return runSupervisedProcessGated({
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
    cwd,
    output: SMALL,
  });
}

afterEach(async () => {
  await closeKernelSession();
  resetKernelProcessForTests();
  withEnv({});
});

describe("resolveProcessBackend", () => {
  it("uses the kernel executor by default and the built-in supervisor when asked", () => {
    expect(resolveProcessBackend({}).backend).toBe(onPosix ? "kernel" : "legacy");
    expect(resolveProcessBackend({ XIOCODE_PROCESS_KERNEL: "0" })).toMatchObject({ backend: "legacy" });
  });
});

describe("runSupervisedProcessGated", () => {
  it("leaves no kernel domain behind when the executor flag is off", async () => {
    const domainRoot = makeTempDir("xio-kernel-off-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "0", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const result = await echo(process.cwd(), "legacy-path");
    expect(result.stdout).toBe("legacy-path");
    expect(result.kernel).toBeUndefined();
    expect(domainDatabases(domainRoot)).toEqual([]);
  });

  it.skipIf(!onPosix)("runs unbound callers on an ephemeral domain that a clean close removes", async () => {
    const domainRoot = makeTempDir("xio-kernel-ephemeral-");
    withEnv({ XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const result = await echo(process.cwd(), "kernel-path");
    expect(result.stdout).toBe("kernel-path");
    expect(result.kernel?.domainPath.startsWith(domainRoot)).toBe(true);
    expect(domainDatabases(domainRoot).length).toBe(1);
    await closeKernelSession();
    expect(domainDatabases(domainRoot)).toEqual([]);
  });

  it.skipIf(!onPosix)("keeps one domain per bound session regardless of each command's cwd", async () => {
    const domainRoot = makeTempDir("xio-kernel-bound-");
    const workspace = makeTempDir("xio-kernel-bound-ws-");
    fs.mkdirSync(path.join(workspace, "sub"));
    withEnv({ XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });

    const session = await bindKernelSession({ sessionId: "bound-1", workspaceRoot: workspace });
    expect(session.domainPath).toBe(kernelDomainPath(domainRoot, workspace, "bound-1"));
    const top = await echo(workspace, "top");
    const nested = await echo(path.join(workspace, "sub"), "nested");
    expect(top.kernel?.domainPath).toBe(session.domainPath);
    expect(nested.kernel?.domainPath).toBe(session.domainPath);

    // A restart of the same session reopens the same domain without id collisions.
    await closeKernelSession();
    const reopened = await bindKernelSession({ sessionId: "bound-1", workspaceRoot: workspace });
    expect(reopened.domainPath).toBe(session.domainPath);
    await expect(echo(workspace, "again").then((r) => r.stdout)).resolves.toBe("again");
    expect(domainDatabases(domainRoot).length).toBe(1);
  });

  it("emits exactly one visible notice when the default executor is unavailable", () => {
    resetKernelProcessForTests();
    const lines: string[] = [];
    const write = (line: string): void => {
      lines.push(line);
    };
    expect(notifyKernelFallback("node 20.11.1 is older than 22.13", write)).toBe(true);
    expect(notifyKernelFallback("node 20.11.1 is older than 22.13", write)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kernel process executor unavailable");
    expect(lines[0]).toContain("XIOCODE_PROCESS_KERNEL=0");
  });
});

describe("sweepOrphanedDomains", () => {
  it.skipIf(!onPosix)("recovers domains whose owner died and leaves live owners alone", async () => {
    const root = makeTempDir("xio-kernel-sweep-");
    const workspace = makeTempDir("xio-kernel-sweep-ws-");

    // A crashed launch: intent registered, process active, owner gone, lock left behind.
    const crashedPath = kernelDomainPath(root, workspace, "crashed");
    const crashed = ExecutionDomain.acquire(crashedPath, "crashed");
    crashed.getStore().saveTask({ id: "t", domainId: "crashed", name: "t", createdAt: new Date().toISOString() });
    crashed.getStore().saveRun({ id: "r", taskId: "t", domainId: "crashed", owner: "x", status: "running", startedAt: new Date().toISOString() });
    crashed.registerOperationIntent({
      id: "orphan-op", runId: "r", kind: "process", name: "process:/bin/sh",
      inputFingerprint: "fp", requiredResources: [], status: "pending",
    });
    crashed.getStore().updateOperationStatus("orphan-op", "active", { pid: 999_999, spawnTime: new Date().toISOString() });
    crashed.close();
    fs.writeFileSync(path.join(crashedPath, "domain.lock"), JSON.stringify({
      domainId: "crashed", ownerPid: 999_999, acquiredAt: new Date().toISOString(), hostname: os.hostname(),
    }));

    // A live session in the same workspace must not be touched.
    const live = await bindKernelSession({ sessionId: "live", workspaceRoot: workspace, env: { XIOCODE_KERNEL_DOMAIN_ROOT: root } });

    const results = await sweepOrphanedDomains({ root, workspaceRoot: workspace, exclude: live.domainPath });
    expect(results).toEqual([{
      domainPath: crashedPath,
      sameWorkspace: true,
      recovered: [{ opId: "orphan-op", action: "marked_dead", resourcesReleased: true }],
    }]);
    expect(fs.existsSync(path.join(crashedPath, "domain.lock"))).toBe(false);
    // Nothing left to do on a second pass.
    expect(await sweepOrphanedDomains({ root, workspaceRoot: workspace })).toEqual([]);
  });
});

describe("call sites on the kernel executor", () => {
  it.skipIf(!onPosix)("runs the bash tool keyed by its tool call id, leasing only for non-allowlisted commands", async () => {
    const workspace = makeTempDir("xio-kernel-bash-");
    const domainRoot = makeTempDir("xio-kernel-bash-domain-");
    withEnv({ XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const session = await bindKernelSession({ sessionId: "bash-1", workspaceRoot: workspace });

    const bash = createBuiltinTools({ cwd: workspace, workspaceRoot: workspace }).find((tool) => tool.name === "bash")!;
    const read = await bash.execute("call-read", { command: "ls" });
    expect(read.isError).not.toBe(true);
    const write = await bash.execute("call-write", { command: "touch made-by-bash.txt && echo wrote" });
    expect(write.content.map((part) => part.text).join("")).toContain("wrote");

    const ops = session.status().operations;
    const readOp = ops.find((op) => op.id === session.getOperationByKey("call-read")?.opId);
    const writeOp = ops.find((op) => op.id === session.getOperationByKey("call-write")?.opId);
    expect(readOp?.requiredResources).toEqual([]);
    expect(writeOp?.requiredResources).toEqual([`workspace:write:${workspace}`]);
  });

  it.skipIf(!onPosix)("runs the done contract through the bound session", async () => {
    const workspace = makeTempDir("xio-kernel-done-");
    const domainRoot = makeTempDir("xio-kernel-done-domain-");
    withEnv({ XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const session = await bindKernelSession({ sessionId: "done-1", workspaceRoot: workspace });

    const contract = await runDoneContract(
      {
        commands: [
          { name: "ok", argv: [process.execPath, "-e", "process.exit(0)"] },
          { name: "bad", argv: [process.execPath, "-e", "process.exit(3)"] },
        ],
      },
      { cwd: workspace },
    );
    expect(contract.results.map((r) => r.exitCode)).toEqual([0, 3]);
    expect(contract.passed).toBe(false);
    expect(session.status().operations.length).toBe(2);
  });
});
