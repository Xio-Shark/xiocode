import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertArtifactsOmitSecret,
  buildChildEnvAllowlist,
  prepareCredentialedEvalSetup,
} from "../src/credentialed-env.ts";
import { decodeCredentialedSeries } from "../src/credentialed-series.ts";
import { parseModelRef, pinModelInConfig, resolvePinnedIdentity } from "../src/eval-identity.ts";
import { EvalRunner } from "../src/eval-runner.ts";
import { saveProviderCredential } from "../../../src/cli/credentials.ts";

import type { Server } from "node:http";

const trustedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.length = 0;
});

describe("G9 credentialed provider evidence", () => {
  it("parses and pins provider/model identity without embedding secrets", () => {
    const ref = parseModelRef("openrouter/anthropic/claude-3");
    expect(ref).toEqual({ provider: "openrouter", model: "anthropic/claude-3" });
    const config = [
      "[general]",
      'default_provider = "deepseek"',
      'default_model = "deepseek-chat"',
      "",
      "[providers.deepseek]",
      'kind = "openai"',
      'model = "deepseek-chat"',
      'api_key_env = "DEEPSEEK_API_KEY"',
      "",
    ].join("\n");
    const identity = resolvePinnedIdentity(config, "deepseek/deepseek-reasoner");
    expect(identity).toMatchObject({
      provider: "deepseek",
      exact_model_id: "deepseek-reasoner",
      provider_api: "openai-completions",
      api_key_env: "DEEPSEEK_API_KEY",
    });
    expect(identity.inference_settings).toMatchObject({
      temperature: "provider-default",
      seed: "unsupported",
      parallel_tool_calls: true,
    });
    const pinned = pinModelInConfig(config, identity);
    expect(pinned).toContain('default_model = "deepseek-reasoner"');
    expect(pinned).toContain('model = "deepseek-reasoner"');
    expect(pinned).not.toContain("sk-");
  });

  it("loads /connect credentials and discloses only the selected provider key to the child env", async () => {
    const home = await tempRoot();
    const xioHome = path.join(home, ".xiocode");
    await mkdir(xioHome, { recursive: true });
    const configPath = path.join(xioHome, "config.toml");
    await writeFile(configPath, [
      "[general]",
      'default_provider = "alpha"',
      'default_model = "alpha-1"',
      "",
      "[providers.alpha]",
      'kind = "openai"',
      'model = "alpha-1"',
      'api_key_env = "XIO_ALPHA_KEY"',
      "",
      "[providers.beta]",
      'kind = "openai"',
      'model = "beta-1"',
      'api_key_env = "XIO_BETA_KEY"',
      "",
    ].join("\n"), "utf8");
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      XIO_HOME: xioHome,
      XIO_CONFIG: configPath,
      PATH: process.env.PATH,
      OPENAI_API_KEY: "should-not-pass",
      ANTHROPIC_API_KEY: "also-secret",
    };
    await saveProviderCredential("alpha", { apiKey: "alpha-secret-key-value" }, env);
    await saveProviderCredential("beta", { apiKey: "beta-secret-key-value" }, env);

    const setup = await prepareCredentialedEvalSetup({
      env,
      modelRef: "alpha/alpha-1",
    });
    expect(setup.identity.provider).toBe("alpha");
    expect(setup.childEnv.XIO_ALPHA_KEY).toBe("alpha-secret-key-value");
    expect(setup.childEnv.XIO_BETA_KEY).toBeUndefined();
    expect(setup.childEnv.OPENAI_API_KEY).toBeUndefined();
    expect(setup.childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(setup.childEnv.XIO_CREDENTIALS).toBeUndefined();
    expect(setup.configContent).not.toContain("alpha-secret-key-value");
    expect(assertArtifactsOmitSecret(setup.secretForScan, {
      config: setup.configContent,
      argv: "xio eval smoke --model alpha/alpha-1",
    })).toEqual([]);

    const allowlist = buildChildEnvAllowlist(env, "XIO_ALPHA_KEY", "alpha-secret-key-value");
    expect(Object.keys(allowlist).sort()).toEqual(
      expect.arrayContaining(["PATH", "HOME", "XIO_HOME", "XIO_CONFIG", "XIO_ALPHA_KEY"]),
    );
  });

  it("maps missing credentials to INFRA_ERROR without stub fallback", async () => {
    const evalRoot = await tempRoot();
    const home = await tempRoot();
    const configPath = path.join(home, "config.toml");
    await writeFile(configPath, [
      "[general]",
      'default_provider = "missing"',
      'default_model = "m1"',
      "",
      "[providers.missing]",
      'kind = "openai"',
      'model = "m1"',
      'api_key_env = "XIO_MISSING_KEY"',
      "",
    ].join("\n"), "utf8");
    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      candidate_mode: "real",
      model: "missing/m1",
      eval_root: evalRoot,
      case_ids: ["local-bug-holdout"],
      env: {
        HOME: home,
        XIO_HOME: path.join(home, ".xiocode"),
        XIO_CONFIG: configPath,
        PATH: process.env.PATH,
      },
    }).smoke();
    expect(report.status).toBe("INFRA_ERROR");
    expect(report.candidates).toEqual([]);
    expect(report.errors.join("\n")).toMatch(/missing credential/);
  }, 30_000);

  it("runs fixed repeats and writes credentialed-series.v1 without leaking secrets", async () => {
    const fake = await startFakeProvider({ mode: "ok" });
    const { evalRoot, env, secret } = await writeCredentialedFixture(fake.baseUrl, secretValue());
    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      candidate_root: trustedRoot,
      candidate_mode: "real",
      model: "fake/fake-model",
      repeat: 2,
      eval_root: evalRoot,
      case_ids: ["local-bug-holdout"],
      env,
    }).smoke();

    expect(report.status).toBe("PASS_WITH_CONCERNS");
    expect(report.candidates[0]?.trials).toHaveLength(2);
    for (const trial of report.candidates[0]!.trials) {
      expect(trial.environment).toMatchObject({
        provider: "fake",
        exact_model_id: "fake-model",
      });
      expect(trial.environment.inference_settings).toMatchObject({
        provider_api: "openai-completions",
        temperature: "provider-default",
        seed: "unsupported",
      });
      expect(JSON.stringify(trial)).not.toContain(secret);
    }
    const seriesPath = path.join(evalRoot, "series", report.series_id, "credentialed-series.json");
    const series = decodeCredentialedSeries(JSON.parse(await readFile(seriesPath, "utf8")) as unknown);
    expect(series).toMatchObject({
      schema_version: "credentialed-series.v1",
      candidate_mode: "real",
      repeat: 2,
      identity: {
        provider: "fake",
        exact_model_id: "fake-model",
      },
      aggregate: {
        trial_count: 2,
      },
    });
    expect(JSON.stringify(series)).not.toContain(secret);
    expect(JSON.stringify(series)).not.toContain("prompt");
  }, 120_000);

  it("maps auth failures to INFRA_ERROR outside the resolved denominator", async () => {
    const fake = await startFakeProvider({ mode: "auth" });
    const { evalRoot, env } = await writeCredentialedFixture(fake.baseUrl, secretValue());
    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      candidate_mode: "real",
      model: "fake/fake-model",
      eval_root: evalRoot,
      case_ids: ["local-bug-holdout"],
      env,
    }).smoke();
    expect(report.status).toBe("INFRA_ERROR");
    expect(report.candidates[0]).toMatchObject({
      resolved: 0,
      attempted: 0,
      infra_errors: 1,
      safety_ok: true,
    });
    const infra = report.candidates[0]!.trials[0]!.evidence.infra_errors.join("\n");
    expect(infra).toMatch(/401|LLM request failed/i);
    expect(infra).not.toContain("sk-should-not-echo");
    expect(JSON.stringify(report)).not.toContain("sk-should-not-echo");
  }, 60_000);

  it("maps network failures to INFRA_ERROR without stub fallback", async () => {
    const fake = await startFakeProvider({ mode: "network" });
    const { evalRoot, env, secret } = await writeCredentialedFixture(fake.baseUrl, secretValue());
    const report = await new EvalRunner({
      trusted_root: trustedRoot,
      candidate_mode: "real",
      model: "fake/fake-model",
      eval_root: evalRoot,
      case_ids: ["local-bug-holdout"],
      env,
    }).smoke();
    expect(report.status).toBe("INFRA_ERROR");
    expect(report.candidates[0]).toMatchObject({
      resolved: 0,
      attempted: 0,
      infra_errors: 1,
      safety_ok: true,
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  }, 60_000);

  it("maps provider timeouts to INFRA_ERROR outside the resolved denominator", async () => {
    const fake = await startFakeProvider({ mode: "hang" });
    const { env, secret } = await writeCredentialedFixture(fake.baseUrl, secretValue());
    const setup = await prepareCredentialedEvalSetup({
      env,
      modelRef: "fake/fake-model",
    });
    const suite = await (await import("../src/suite-loader.ts")).loadTrustedSuite(trustedRoot);
    const fixture = suite.fixtures.find((item) => item.id === "local-bug-holdout");
    expect(fixture).toBeDefined();
    const trialRoot = await tempRoot();
    const fixtureRoot = await (await import("../src/fixture-materializer.ts")).materializeFixture(
      fixture!,
      trialRoot,
    );
    const { executeCandidate } = await import("../src/candidate-executor.ts");
    const executed = await executeCandidate({
      trusted_root: trustedRoot,
      candidate_root: trustedRoot,
      fixture_root: fixtureRoot,
      trial_root: trialRoot,
      fixture: { ...fixture!, wall_timeout_ms: 600 },
      mode: "real",
      child_env: setup.childEnv,
      config_content: setup.configContent,
      pinned_provider: setup.identity.provider,
      pinned_model: setup.identity.exact_model_id,
      secret_for_scan: secret,
    });
    expect(executed.result.status).toBe("timeout");
    expect(executed.result.error).toMatch(/timed out/i);
    expect(JSON.stringify(executed.result)).not.toContain(secret);
  }, 30_000);

  it("fails closed before spawn when a real candidate lacks the selected-key child env", async () => {
    const suite = await (await import("../src/suite-loader.ts")).loadTrustedSuite(trustedRoot);
    const fixture = suite.fixtures.find((item) => item.id === "local-bug-holdout")!;
    const trialRoot = await tempRoot();
    const fixtureRoot = await (await import("../src/fixture-materializer.ts")).materializeFixture(
      fixture,
      trialRoot,
    );
    const { executeCandidate } = await import("../src/candidate-executor.ts");
    const executed = await executeCandidate({
      trusted_root: trustedRoot,
      candidate_root: trustedRoot,
      fixture_root: fixtureRoot,
      trial_root: trialRoot,
      fixture,
      mode: "real",
      config_content: [
        "[general]",
        'default_provider = "fake"',
        'default_model = "fake-model"',
        "",
        "[providers.fake]",
        'kind = "openai"',
        'model = "fake-model"',
        'api_key_env = "XIO_FAKE_KEY"',
        "",
      ].join("\n"),
      pinned_provider: "fake",
      pinned_model: "fake-model",
    });
    expect(executed.result).toMatchObject({
      status: "infra_error",
      error: expect.stringMatching(/missing selected-provider child environment/),
    });
  });
});

async function writeCredentialedFixture(
  baseUrl: string,
  secret: string,
): Promise<{ evalRoot: string; env: NodeJS.ProcessEnv; secret: string }> {
  const home = await tempRoot();
  const xioHome = path.join(home, ".xiocode");
  await mkdir(xioHome, { recursive: true });
  const configPath = path.join(xioHome, "config.toml");
  await writeFile(configPath, [
    "[general]",
    'default_provider = "fake"',
    'default_model = "fake-model"',
    "",
    "[providers.fake]",
    'kind = "openai"',
    'model = "fake-model"',
    `base_url = "${baseUrl}"`,
    'api_key_env = "XIO_FAKE_KEY"',
    "",
    "[worktree]",
    "allow_dirty = true",
    "",
  ].join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XIO_HOME: xioHome,
    XIO_CONFIG: configPath,
    PATH: process.env.PATH,
    XIO_FAKE_KEY: secret,
  };
  await saveProviderCredential("fake", { apiKey: secret }, env);
  return { evalRoot: await tempRoot(), env, secret };
}

function secretValue(): string {
  return `sk-test-${"f".repeat(48)}`;
}

async function startFakeProvider(options: Readonly<{ mode: "ok" | "auth" | "hang" | "network" }>): Promise<{
  baseUrl: string;
  server: Server;
}> {
  const server = createServer((req, res) => {
    if (options.mode === "hang") {
      return;
    }
    if (options.mode === "network") {
      req.socket.destroy();
      return;
    }
    if (options.mode === "auth") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key sk-should-not-echo" } }));
      return;
    }
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"role":"assistant","content":"cannot fix"}}]}',
      "",
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind fake provider");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-eval-g9-"));
  tempDirs.push(root);
  return root;
}
