import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  notifyKernelFallback,
  resetKernelProcessRunnerForTests,
  resolveProcessBackend,
  runSupervisedProcessGated,
  setKernelProcessSession,
} from "./kernel-process.ts";
import { createBuiltinTools } from "../tools/builtin.ts";
import { runDoneContract } from "../verify/done-contract.ts";

const ENV_KEYS = ["XIOCODE_PROCESS_KERNEL", "XIOCODE_KERNEL_DOMAIN_ROOT"] as const;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function domainDatabases(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root).filter((entry) => fs.existsSync(path.join(root, entry, "domain.db")));
}

afterEach(() => {
  setKernelProcessSession(undefined);
  resetKernelProcessRunnerForTests();
  withEnv({});
});

describe("resolveProcessBackend", () => {
  it("uses the kernel path by default where the runtime supports it", () => {
    withEnv({});
    const resolved = resolveProcessBackend(process.cwd());
    const [major = 0, minor = 0] = process.versions.node
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    const kernelCapable = process.platform !== "win32" && (major > 22 || (major === 22 && minor >= 5));
    if (kernelCapable) {
      expect(resolved.backend).toBe("kernel");
      expect(resolved.domainPath).toBeTruthy();
      return;
    }
    // Unsupported runtime: built-in supervisor, with the reason kept for the notice.
    expect(resolved.backend).toBe("legacy");
    expect(resolved.reason.length).toBeGreaterThan(0);
  });

  it("selects the kernel with an explicit domain path when the flag is on", () => {
    const root = makeTempDir("xio-kernel-flag-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: root });
    const resolved = resolveProcessBackend(process.cwd());
    if (process.platform === "win32") {
      expect(resolved.backend).toBe("legacy");
      return;
    }
    expect(resolved.backend).toBe("kernel");
    expect(resolved.domainPath?.startsWith(root)).toBe(true);
  });
});

describe("runSupervisedProcessGated", () => {
  it("leaves no kernel domain behind when the flag is off", async () => {
    const domainRoot = makeTempDir("xio-kernel-off-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "0", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const result = await runSupervisedProcessGated({
      command: process.execPath,
      args: ["-e", "process.stdout.write('legacy-path')"],
      cwd: process.cwd(),
      output: { headBytes: 512, tailBytes: 0, hardCapBytes: 64_000 },
    });
    expect(result.stdout).toBe("legacy-path");
    expect(domainDatabases(domainRoot)).toEqual([]);
  });

  it("runs through the kernel and persists an execution domain when the flag is on", async () => {
    if (process.platform === "win32") {
      return;
    }
    const domainRoot = makeTempDir("xio-kernel-on-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const result = await runSupervisedProcessGated({
      command: process.execPath,
      args: ["-e", "process.stdout.write('kernel-path')"],
      cwd: process.cwd(),
      output: { headBytes: 512, tailBytes: 0, hardCapBytes: 64_000 },
    });
    expect(result.stdout).toBe("kernel-path");
    expect(result.termination).toBe("exited");
    expect(domainDatabases(domainRoot).length).toBe(1);
  });

  it("forwards live output projections through the gate", async () => {
    if (process.platform === "win32") {
      return;
    }
    const domainRoot = makeTempDir("xio-kernel-live-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const seen: string[] = [];
    const result = await runSupervisedProcessGated({
      command: process.execPath,
      args: ["-e", "process.stdout.write('live-a\\nlive-b\\n')"],
      cwd: process.cwd(),
      output: { headBytes: 512, tailBytes: 0, hardCapBytes: 64_000 },
      onOutput: (chunk) => seen.push(chunk.text),
    });
    expect(result.stdout).toBe("live-a\nlive-b\n");
    expect(seen.join("")).toBe("live-a\nlive-b\n");
  });

  it("keys the execution domain by session so a restart can adopt it", async () => {
    if (process.platform === "win32") {
      return;
    }
    const domainRoot = makeTempDir("xio-kernel-session-");
    const workspace = makeTempDir("xio-kernel-session-ws-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    const run = () =>
      runSupervisedProcessGated({
        command: process.execPath,
        args: ["-e", "process.stdout.write('session-domain')"],
        cwd: workspace,
        output: { headBytes: 512, tailBytes: 0, hardCapBytes: 64_000 },
      });

    try {
      setKernelProcessSession("session-abc");
      await run();
      const firstSession = domainDatabases(domainRoot);
      expect(firstSession.length).toBe(1);

      // Same session reuses the same domain (the restart/adoption path).
      await run();
      expect(domainDatabases(domainRoot)).toEqual(firstSession);

      // A different session gets its own domain.
      setKernelProcessSession("session-def");
      await run();
      const bothSessions = domainDatabases(domainRoot);
      expect(bothSessions.length).toBe(2);
      expect(bothSessions).toContain(firstSession[0]);
    } finally {
      setKernelProcessSession(undefined);
    }
  });

  it("emits exactly one visible notice when the default path is unavailable", () => {
    resetKernelProcessRunnerForTests();
    const lines: string[] = [];
    const write = (line: string): void => {
      lines.push(line);
    };

    expect(notifyKernelFallback("node 20.11.1 is older than 22.5", write)).toBe(true);
    expect(notifyKernelFallback("node 20.11.1 is older than 22.5", write)).toBe(false);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("kernel process layer unavailable");
    expect(lines[0]).toContain("node 20.11.1 is older than 22.5");
    expect(lines[0]).toContain("XIOCODE_PROCESS_KERNEL=0");
  });

  it("does not collide when the same domain is reopened by a new runner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const domainRoot = makeTempDir("xio-kernel-reopen-");
    const workspace = makeTempDir("xio-kernel-reopen-ws-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
    setKernelProcessSession("reopen-session");
    const run = (): Promise<string> =>
      runSupervisedProcessGated({
        command: process.execPath,
        args: ["-e", "process.stdout.write('reopen')"],
        cwd: workspace,
        output: { headBytes: 512, tailBytes: 0, hardCapBytes: 64_000 },
      }).then((result) => result.stdout);

    await expect(run()).resolves.toBe("reopen");
    // Simulate a restart: a fresh runner over the same domain (same session key)
    // must not restart operation ids at 1 and collide with the previous run.
    resetKernelProcessRunnerForTests();
    await expect(run()).resolves.toBe("reopen");
    expect(domainDatabases(domainRoot).length).toBe(1);
  });
});

describe("flag-on call sites", () => {
  it("routes the bash tool through the kernel backend", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspace = makeTempDir("xio-kernel-bash-");
    const domainRoot = makeTempDir("xio-kernel-bash-domain-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });

    const tools = createBuiltinTools({ cwd: workspace, workspaceRoot: workspace });
    const bash = tools.find((tool) => tool.name === "bash");
    expect(bash).toBeTruthy();
    const result = await bash!.execute("call-1", { command: "echo kernel-bash" });
    const text = result.content.map((part) => part.text).join("");
    expect(text).toContain("kernel-bash");
    expect(domainDatabases(domainRoot).length).toBe(1);
  });

  it("routes the done contract through the kernel backend", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspace = makeTempDir("xio-kernel-done-");
    const domainRoot = makeTempDir("xio-kernel-done-domain-");
    withEnv({ XIOCODE_PROCESS_KERNEL: "1", XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });

    const contract = await runDoneContract(
      {
        commands: [
          { name: "ok", argv: [process.execPath, "-e", "process.exit(0)"] },
          { name: "bad", argv: [process.execPath, "-e", "process.exit(3)"] },
        ],
      },
      { cwd: workspace },
    );
    expect(contract.results[0]?.passed).toBe(true);
    expect(contract.results[1]?.exitCode).toBe(3);
    expect(contract.passed).toBe(false);
    expect(domainDatabases(domainRoot).length).toBe(1);
  });
});
