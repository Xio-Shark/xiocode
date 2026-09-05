import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDoctorCli } from "./doctor-cli.ts";
import { DEFAULT_CONFIG_TOML } from "./default-config.ts";

describe("runDoctorCli", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "xio-doctor-"));
    env = {
      XIO_CONFIG: path.join(home, "config.toml"),
      XIO_CREDENTIALS: path.join(home, "credentials.json"),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reports missing config and missing keys with actionable fixes", async () => {
    const out: string[] = [];
    const code = await runDoctorCli({
      env,
      offline: true,
      write: (chunk) => out.push(chunk),
    });
    const text = out.join("");
    expect(code).toBe(1); // no keys is a blocking problem
    expect(text).toContain("config");
    expect(text).toContain("xio init");
    expect(text).toContain("keys");
    expect(text).toContain("/connect");
    // Node check is first per plan (installer funnel killer #1).
    const firstCheck = text.split("\n").find((line) => line.includes("node"));
    expect(firstCheck).toBeTruthy();
  });

  it("fails on old node version with an upgrade hint", async () => {
    const out: string[] = [];
    const code = await runDoctorCli({
      env,
      offline: true,
      nodeVersion: "18.19.0",
      write: (chunk) => out.push(chunk),
    });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("v18.19.0 is too old");
    expect(text).toContain("nodejs.org");
  });

  it("warns on Windows and points at WSL", async () => {
    const out: string[] = [];
    await runDoctorCli({
      env,
      offline: true,
      platform: "win32",
      write: (chunk) => out.push(chunk),
    });
    expect(out.join("")).toContain("WSL");
  });

  it("passes with valid config, env key, and reachable provider", async () => {
    await writeFile(env.XIO_CONFIG!, DEFAULT_CONFIG_TOML, "utf8");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const out: string[] = [];
    const code = await runDoctorCli({
      env: { ...env, DEEPSEEK_API_KEY: "sk-test" },
      write: (chunk) => out.push(chunk),
      fetchImpl,
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("deepseek (env DEEPSEEK_API_KEY)");
    expect(text).toContain("reachable");
    expect(text).toContain("no blocking problems");
    // Doctor output must never leak the API key.
    expect(text).not.toContain("sk-test");
  });

  it("marks provider connectivity failure with a next step", async () => {
    await writeFile(env.XIO_CONFIG!, DEFAULT_CONFIG_TOML, "utf8");
    const fetchImpl = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    const out: string[] = [];
    const code = await runDoctorCli({
      env: { ...env, DEEPSEEK_API_KEY: "sk-bad" },
      write: (chunk) => out.push(chunk),
      fetchImpl,
    });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("problem");
    expect(text).toContain("connect");
  });
});
