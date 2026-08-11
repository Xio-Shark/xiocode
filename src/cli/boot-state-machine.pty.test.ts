import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_TOML } from "./default-config.ts";
import { runPtyScenario } from "./test/pty-harness.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const xioEntry = path.join(repoRoot, "src/cli/entry.ts");
const tempDirs: string[] = [];
let bundleRoot = "";
let bundledEntry = "";

beforeAll(async () => {
  // Keep the temp bundle under repo root so external packages resolve from node_modules.
  bundleRoot = await mkdtemp(path.join(repoRoot, ".xio-boot-bundle-"));
  await build({
    entryPoints: { xio: xioEntry },
    outdir: bundleRoot,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    packages: "external",
    resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
    loader: { ".ts": "ts", ".tsx": "tsx" },
    logLevel: "silent",
  });
  bundledEntry = path.join(bundleRoot, "xio.js");
});

afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe.skipIf(process.platform === "win32")("first-use boot state machine (PTY)", () => {
  it("allows trust, persists it, and reaches disconnected UI within an isolated HOME", async () => {
    const fixture = await createFixture();
    const result = await runPtyScenario({
      command: [process.execPath, bundledEntry],
      cwd: fixture.project,
      env: fixture.env,
      actions: [
        { waitFor: "Trust this project directory", send: "y", timeoutMs: 1_000 },
        { waitFor: "not connected · /connect", send: "/exit\r", timeoutMs: 5_000 },
      ],
    });

    // One cold-start case owns the absolute release gate; the remaining cases
    // replay the same startup path with extra scheduler headroom for input semantics.
    expect(result.milestonesMs[0]).toBeLessThanOrEqual(1_000);
    expect(result.exitCode).toBe(0);
    const trust = JSON.parse(
      await readFile(path.join(fixture.home, ".xiocode", "trust.json"), "utf8"),
    ) as { entries?: Record<string, { level?: string }> };
    expect(trust.entries?.[await realpath(fixture.project)]?.level).toBe("trusted");
  });

  it("denies trust but keeps /connect, /help, and /exit usable", async () => {
    const fixture = await createFixture();
    const result = await runPtyScenario({
      command: [process.execPath, bundledEntry],
      cwd: fixture.project,
      env: fixture.env,
      actions: [
        { waitFor: "Trust this project directory", send: "n", timeoutMs: 2_000 },
        { waitFor: "not connected · /connect", send: "/connect\r", timeoutMs: 5_000 },
        { waitFor: "Select a provider", send: "\x1b", timeoutMs: 2_000 },
        { waitFor: "connect cancelled", send: "/help\r", timeoutMs: 2_000 },
        { waitFor: "Commands:", send: "/exit\r", timeoutMs: 2_000 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("degraded capabilities");
    const trustPath = path.join(fixture.home, ".xiocode", "trust.json");
    const trust = await readFile(trustPath, "utf8")
      .then((raw) => JSON.parse(raw) as { entries?: Record<string, { level?: string }> })
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
    expect(trust?.entries?.[await realpath(fixture.project)]).toBeUndefined();
  });

  it("resolves trust confirmation and exits 130 on Ctrl+C", async () => {
    const fixture = await createFixture();
    const result = await runPtyScenario({
      command: [process.execPath, bundledEntry],
      cwd: fixture.project,
      env: fixture.env,
      actions: [
        { waitFor: "Trust this project directory", send: "\x03", timeoutMs: 2_000 },
      ],
      exitTimeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(130);
  });
});

async function createFixture(): Promise<Readonly<{
  home: string;
  project: string;
  env: Record<string, string>;
}>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-boot-pty-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const configPath = path.join(root, "config.toml");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    writeFile(configPath, DEFAULT_CONFIG_TOML, "utf8"),
  ]);
  expect(path.resolve(home)).not.toBe(path.resolve(os.homedir()));
  return {
    home,
    project,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SHELL: process.env.SHELL ?? "/bin/sh",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      XIO_HOME: path.join(home, ".xiocode"),
      XIO_CONFIG: configPath,
      XIO_DISABLE_UPDATE_CHECK: "1",
      XIO_TUI_FULLSCREEN: "1",
    },
  };
}
