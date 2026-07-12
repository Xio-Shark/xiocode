import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCredentialsToEnv,
  loadCredentials,
  resolveCredentialsPath,
  saveProviderCredential,
} from "./credentials.ts";
import { mutateConnectConfig, upsertProviderBlock } from "./config-mutate.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempHome(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "xio-creds-"));
  tempDirs.push(home);
  return { home, env: { XIO_HOME: home } };
}

describe("credentials", () => {
  it("writes credentials.json with mode 0600 and never embeds keys in returned paths only", async () => {
    const { env, home } = await tempHome();
    const filePath = await saveProviderCredential("deepseek", {
      apiKey: "sk-test-secret-value",
      models: ["deepseek-chat"],
    }, env);
    expect(filePath).toBe(path.join(home, "credentials.json"));
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = await loadCredentials(env);
    expect(loaded.providers.deepseek?.apiKey).toBe("sk-test-secret-value");
    expect(loaded.providers.deepseek?.models).toEqual(["deepseek-chat"]);
  });

  it("applies credentials into env only when the target env is empty", async () => {
    const { env } = await tempHome();
    await saveProviderCredential("openai", { apiKey: "from-file" }, env);
    const providers = {
      openai: { name: "openai", kind: "openai", apiKeyEnv: "OPENAI_API_KEY" },
    };
    await applyCredentialsToEnv(env, providers);
    expect(env.OPENAI_API_KEY).toBe("from-file");
    env.OPENAI_API_KEY = "from-process";
    await applyCredentialsToEnv(env, providers);
    expect(env.OPENAI_API_KEY).toBe("from-process");
  });

  it("respects XIO_CREDENTIALS override", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "xio-creds-custom-"));
    tempDirs.push(dir);
    const custom = path.join(dir, "keys.json");
    const env = { XIO_CREDENTIALS: custom };
    expect(resolveCredentialsPath(env)).toBe(custom);
    await saveProviderCredential("anthropic", { apiKey: "sk-anth" }, env);
    expect(await readFile(custom, "utf8")).toContain("sk-anth");
    expect(await readFile(custom, "utf8")).not.toContain("config.toml");
  });
});

describe("config-mutate", () => {
  it("upserts provider blocks without writing secrets and preserves comments", () => {
    const original = `# keep me
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"

[providers.deepseek]
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"
`;
    const next = mutateConnectConfig(original, {
      name: "openai",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(next).toContain("# keep me");
    expect(next).toContain('[providers.openai]');
    expect(next).toContain('default_provider = "openai"');
    expect(next).toContain('default_model = "gpt-4.1"');
    expect(next).not.toContain("sk-");
    expect(next).not.toContain("api_key =");
  });

  it("replaces an existing provider section in place", () => {
    const original = `[providers.openai]
kind = "openai"
model = "old"
api_key_env = "OPENAI_API_KEY"
`;
    const next = upsertProviderBlock(original, {
      name: "openai",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(next).toContain('model = "gpt-4.1"');
    expect(next).not.toContain('model = "old"');
    expect(next.match(/\[providers\.openai\]/g)).toHaveLength(1);
  });
});
