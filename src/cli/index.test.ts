import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleXioFlag, isDirectRunEntry, parseXioArgs, prepareLaunch } from "./index.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";

const execFileAsync = promisify(execFile);

function readPackageVersionForTest(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "xio@test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "xio"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

describe("prepareLaunch", () => {
  it("creates a worktree cwd and writes runtime config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-"));
    tempDirs.push(root);
    await initGitRepo(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(
      configPath,
      `
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
run_root = "${root}/runs"

[providers.deepseek]
kind = "openai"
model = "deepseek-chat"
api_key_env = "XIO_DEEPSEEK_KEY"
`,
      "utf8",
    );

    const xioHome = path.join(root, ".xiocode");
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: xioHome, XIO_DEEPSEEK_KEY: "secret" };
    const launch = await prepareLaunch(root, env);

    expect(launch.runtimeConfig.general.defaultProvider).toBe("deepseek");
    expect(launch.runtimeConfigPath).toBe(path.join(xioHome, "runtime-config.json"));
    expect(launch.env.XIO_RUNTIME_CONFIG).toBe(path.join(xioHome, "runtime-config.json"));
    expect(launch.env.DEEPSEEK_API_KEY).toBe("secret");
    expect(launch.runtimeExtensionEnabled).toBe(true);
    expect(launch.worktree).toBeDefined();
    expect(launch.cwd).toBe(launch.worktree!.worktreePath);
    expect(launch.cwd).not.toBe(root);
    expect(launch.mainRoot).toBe(await WorktreeSandbox.resolveMainRoot(root));
    expect(launch.sessionStart.provenance).toMatchObject({
      schema_version: "xio-run-provenance.v1",
      workspace_root: launch.cwd,
      main_root: launch.mainRoot,
      dirty: true,
    });
    expect(launch.sessionStart.provenance?.base_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(launch.sessionStart.provenance?.dirty_summary_sha).toMatch(/^[a-f0-9]{64}$/);

    const runtime = JSON.parse(await readFile(launch.runtimeConfigPath, "utf8")) as {
      general?: { defaultProvider?: string };
      worktree?: { session?: { worktreePath?: string } };
    };
    expect(runtime.general?.defaultProvider).toBe("deepseek");
    expect(runtime.worktree?.session?.worktreePath).toBe(launch.cwd);

    await WorktreeSandbox.remove(launch.worktree!, { force: true });
  });

  it("rejects non-git directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-nongit-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(configPath, "", "utf8");
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    await expect(prepareLaunch(root, env)).rejects.toThrow(/requires a git repository/i);
  });

  it("skips runtime extensions in fast mode but still creates worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-"));
    tempDirs.push(root);
    await initGitRepo(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(
      configPath,
      `
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
run_root = "${root}/runs"
`,
      "utf8",
    );

    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    const launch = await prepareLaunch(root, env, { runtimeExtensionEnabled: false });

    expect(launch.runtimeExtensionEnabled).toBe(false);
    expect(launch.worktree).toBeDefined();
    await WorktreeSandbox.remove(launch.worktree!, { force: true });
  });
});

describe("parseXioArgs", () => {
  it("parses prompt and fast flags", () => {
    expect(parseXioArgs(["--xio-fast", "-p", "hello"])).toEqual({
      passthrough: [],
      runtimeExtensionEnabled: false,
      promptOnce: "hello",
    });
  });
});

describe("isDirectRunEntry", () => {
  it("treats npm-linked symlink entries as direct runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-"));
    tempDirs.push(root);
    const modulePath = path.join(root, "src", "cli", "index.ts");
    const linkPath = path.join(root, "bin-xio");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(modulePath, "", "utf8");
    await symlink(modulePath, linkPath);
    expect(isDirectRunEntry(linkPath, modulePath)).toBe(true);
  });
});

describe("handleXioFlag", () => {
  it("prints version without pi branding", () => {
    const chunks: string[] = [];
    expect(handleXioFlag(["--version"], (chunk) => chunks.push(chunk))).toBe(true);
    expect(chunks.join("")).toBe(`XioCode ${readPackageVersionForTest()}\n`);
  });

  it("prints help", () => {
    const chunks: string[] = [];
    expect(handleXioFlag(["--help"], (chunk) => chunks.push(chunk))).toBe(true);
    expect(chunks.join("")).toContain("local-first coding agent");
    expect(chunks.join("")).toContain("worktree");
    expect(chunks.join("")).toContain("xio regress");
    expect(chunks.join("")).not.toContain("pi-agent");
  });
});
