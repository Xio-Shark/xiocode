import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resetKernelProcessRunnerForTests,
  resolveProcessBackend,
  runSupervisedProcessGated,
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
  resetKernelProcessRunnerForTests();
  withEnv({});
});

describe("resolveProcessBackend", () => {
  it("defaults to the legacy supervisor", () => {
    withEnv({});
    const resolved = resolveProcessBackend(process.cwd());
    expect(resolved.backend).toBe("legacy");
    expect(resolved.reason).toContain("XIOCODE_PROCESS_KERNEL");
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
    withEnv({ XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot });
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
