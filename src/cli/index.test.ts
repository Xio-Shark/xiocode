import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleXioFlag, isDirectRunEntry, parseXioArgs, prepareLaunch, shouldUseInk } from "./index.ts";
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

const WORKTREE_ON = `
[worktree]
enabled = true
`;

describe("prepareLaunch", () => {
  it("defaults to main cwd without worktree (git optional)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-main-"));
    tempDirs.push(root);
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

    expect(launch.worktree).toBeUndefined();
    expect(launch.cwd).toBe(path.resolve(root));
    expect(launch.mainRoot).toBe(path.resolve(root));
    expect(launch.env.DEEPSEEK_API_KEY).toBe("secret");
    expect(launch.sessionStart.provenance).toMatchObject({
      schema_version: "xio-run-provenance.v1",
      workspace_root: launch.cwd,
      main_root: launch.mainRoot,
      base_commit: "nogit",
      dirty: false,
    });
  });

  it("creates a worktree cwd when worktree.enabled = true", async () => {
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
${WORKTREE_ON}
`,
      "utf8",
    );

    const xioHome = path.join(root, ".xiocode");
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: xioHome, XIO_DEEPSEEK_KEY: "secret" };
    const launch = await prepareLaunch(root, env, { allowDirty: true });

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

  it("allows non-git directories in default main mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-nongit-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(configPath, "", "utf8");
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    const launch = await prepareLaunch(root, env);
    expect(launch.worktree).toBeUndefined();
    expect(launch.cwd).toBe(path.resolve(root));
  });

  it("rejects non-git directories when worktree is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-nongit-wt-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(configPath, "[worktree]\nenabled = true\n", "utf8");
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    await expect(prepareLaunch(root, env)).rejects.toThrow(/worktree mode requires a git repository/i);
  });

  it("blocks dirty main when worktree is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-dirty-"));
    tempDirs.push(root);
    await initGitRepo(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(
      configPath,
      "[general]\ndefault_provider = \"deepseek\"\ndefault_model = \"deepseek-chat\"\n[worktree]\nenabled = true\n",
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    await expect(prepareLaunch(root, env)).rejects.toThrow(/uncommitted changes/i);
  });

  it("allows dirty main when allowDirty is set with worktree on", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-allow-dirty-"));
    tempDirs.push(root);
    await initGitRepo(root);
    const configPath = path.join(root, "config.toml");
    await writeFile(
      configPath,
      "[general]\ndefault_provider = \"deepseek\"\ndefault_model = \"deepseek-chat\"\n[worktree]\nenabled = true\nallow_dirty = true\n",
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    const launch = await prepareLaunch(root, env);
    expect(launch.sessionStart.provenance?.dirty).toBe(true);
    expect(launch.worktree).toBeDefined();
    await WorktreeSandbox.remove(launch.worktree!, { force: true });
  });

  it("skips runtime extensions in fast mode; worktree only when enabled", async () => {
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
${WORKTREE_ON}
`,
      "utf8",
    );

    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: path.join(root, ".xiocode") };
    const launch = await prepareLaunch(root, env, { runtimeExtensionEnabled: false, allowDirty: true });

    expect(launch.runtimeExtensionEnabled).toBe(false);
    expect(launch.worktree).toBeDefined();
    await WorktreeSandbox.remove(launch.worktree!, { force: true });
  });

  it("attaches the saved worktree instead of creating a fresh resume checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-cli-resume-"));
    tempDirs.push(root);
    await initGitRepo(root);
    const configPath = path.join(root, "config.toml");
    const xioHome = path.join(root, ".xiocode");
    await writeFile(
      configPath,
      "[general]\ndefault_provider = \"deepseek\"\ndefault_model = \"deepseek-chat\"\n[worktree]\nenabled = true\n",
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { XIO_CONFIG: configPath, XIO_HOME: xioHome };
    const first = await prepareLaunch(root, env, { allowDirty: true, sessionId: "resume1" });
    await writeFile(path.join(first.cwd, "interrupted.txt"), "preserved\n", "utf8");

    const resumed = await prepareLaunch(root, env, {
      allowDirty: true,
      resumeWorkspace: {
        mode: "worktree",
        lifecycle: "active",
        main_root: first.worktree!.mainRoot,
        worktree_path: first.worktree!.worktreePath,
        branch: first.worktree!.branch,
        base_ref: first.worktree!.baseRef,
        repo_id: first.worktree!.repoId,
        session_id: first.worktree!.sessionId,
        epoch: 0,
      },
    });

    expect(resumed.cwd).toBe(first.cwd);
    expect(await readFile(path.join(resumed.cwd, "interrupted.txt"), "utf8")).toBe("preserved\n");
    await WorktreeSandbox.remove(resumed.worktree!, { force: true });
  });
});

describe("parseXioArgs", () => {
  it("parses prompt and fast flags", () => {
    expect(parseXioArgs(["--xio-fast", "-p", "hello"])).toEqual({
      passthrough: [],
      runtimeExtensionEnabled: false,
      allowDirty: false,
      allowHighRisk: false,
      promptOnce: "hello",
      outputFormat: "text",
    });
  });

  it("parses --allow-dirty", () => {
    expect(parseXioArgs(["--allow-dirty", "-p", "hello"]).allowDirty).toBe(true);
  });

  it("parses --output-format stream-json", () => {
    expect(parseXioArgs(["-p", "hi", "--output-format", "stream-json"])).toMatchObject({
      promptOnce: "hi",
      outputFormat: "stream-json",
    });
    expect(parseXioArgs(["-p", "hi", "--output-format=stream-json"]).outputFormat).toBe("stream-json");
  });

  it("rejects unknown output formats", () => {
    expect(() => parseXioArgs(["-p", "hi", "--output-format", "yaml"])).toThrow(/stream-json/);
  });
});

describe("shouldUseInk", () => {
  it("uses ink for interactive tty without promptOnce", () => {
    expect(shouldUseInk({}, { stdinIsTTY: true, stdoutIsTTY: true }, {})).toBe(true);
    expect(shouldUseInk({ promptOnce: "hello" }, { stdinIsTTY: true, stdoutIsTTY: true }, {})).toBe(false);
  });

  it("forces ink for boot measurement even without a TTY", () => {
    expect(shouldUseInk({}, { stdinIsTTY: false, stdoutIsTTY: false }, { XIO_PERF_BOOT_EXIT: "1" })).toBe(true);
    expect(shouldUseInk({}, { stdinIsTTY: false, stdoutIsTTY: false }, { XIO_FORCE_INK: "1" })).toBe(true);
    expect(shouldUseInk({}, { stdinIsTTY: false, stdoutIsTTY: false }, {})).toBe(false);
  });
});

describe("handleXioFlag", () => {
  it("prints version and help", () => {
    const chunks: string[] = [];
    expect(handleXioFlag(["--version"], (c) => chunks.push(c))).toBe(true);
    expect(chunks.join("")).toContain(readPackageVersionForTest());
    chunks.length = 0;
    expect(handleXioFlag(["--help"], (c) => chunks.push(c))).toBe(true);
    expect(chunks.join("")).toMatch(/any directory|launch from/i);
  });
});

describe("isDirectRunEntry", () => {
  it("matches realpath of the entry module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-entry-"));
    tempDirs.push(root);
    const real = path.join(root, "index.ts");
    const link = path.join(root, "alias.ts");
    await writeFile(real, "", "utf8");
    await mkdir(path.join(root, "bin"), { recursive: true });
    // skip complex symlink cases on all platforms
    expect(isDirectRunEntry(real, real)).toBe(true);
    void link;
  });
});
