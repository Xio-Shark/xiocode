import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveProviderCredential } from "../cli/credentials.ts";
import {
  SecretEnvironment,
  buildChildEnv,
  isSensitiveEnvName,
  redactWithKnownValues,
  resolveMcpEnvEntries,
} from "./secret-environment.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempHome(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "xio-secret-env-"));
  tempDirs.push(home);
  return { home, env: { XIO_HOME: home, PATH: "/usr/bin", HOME: home } };
}

describe("SecretEnvironment", () => {
  it("loads credentials without mutating the parent env", async () => {
    const { env } = await tempHome();
    await saveProviderCredential("deepseek", { apiKey: "sk-from-file-abcdefgh" }, env);
    const parent = { ...env, PATH: "/bin" };
    const before = { ...parent };
    const store = await SecretEnvironment.create({
      env: parent,
      providers: {
        deepseek: { name: "deepseek", kind: "openai", apiKeyEnv: "DEEPSEEK_API_KEY" },
      },
    });
    expect(parent).toEqual(before);
    expect(store.resolveProvider({
      name: "deepseek",
      api: "openai-completions",
      apiKey: "$DEEPSEEK_API_KEY",
      models: [],
    })).toBe("sk-from-file-abcdefgh");
    expect(JSON.stringify(store)).toBe('"[SecretEnvironment]"');
  });

  it("prefers explicit env over credentials file", async () => {
    const { env } = await tempHome();
    await saveProviderCredential("openai", { apiKey: "sk-from-file-abcdefgh" }, env);
    const parent = { ...env, OPENAI_API_KEY: "sk-from-process-xyz12345" };
    const store = await SecretEnvironment.create({
      env: parent,
      providers: {
        openai: { name: "openai", kind: "openai", apiKeyEnv: "OPENAI_API_KEY" },
      },
    });
    expect(store.resolveProvider({
      name: "openai",
      api: "openai-completions",
      apiKey: "$OPENAI_API_KEY",
      models: [],
    })).toBe("sk-from-process-xyz12345");
  });

  it("setProvider updates session store without writing env", async () => {
    const { env } = await tempHome();
    const parent = { ...env };
    const store = await SecretEnvironment.create({ env: parent, providers: {} });
    store.setProvider("OPENAI_API_KEY", "sk-connect-new-key-value");
    expect(parent.OPENAI_API_KEY).toBeUndefined();
    expect(store.resolveProvider({
      name: "openai",
      api: "openai-completions",
      apiKey: "$OPENAI_API_KEY",
      models: [],
    })).toBe("sk-connect-new-key-value");
  });

  it("isolates two concurrent session stores", async () => {
    const { env } = await tempHome();
    const a = await SecretEnvironment.create({ env, providers: {} });
    const b = await SecretEnvironment.create({ env, providers: {} });
    a.setProvider("A_KEY", "secret-value-aaaa-1111");
    b.setProvider("B_KEY", "secret-value-bbbb-2222");
    expect(a.has("B_KEY")).toBe(false);
    expect(b.has("A_KEY")).toBe(false);
    expect(a.redactProjection("x secret-value-aaaa-1111 y")).toContain("[redacted]");
    expect(a.redactProjection("x secret-value-bbbb-2222 y")).not.toContain("[redacted]");
  });
});

describe("buildChildEnv", () => {
  it("copies only the base allowlist and rejects secrets", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      DEEPSEEK_API_KEY: "sk-host-secret-abcdefgh",
      NPM_TOKEN: "npm-token-abcdefghijkl",
      CI: "true",
      NODE_OPTIONS: "--require evil",
    };
    const child = buildChildEnv(parent, {
      knownSecretValues: ["sk-host-secret-abcdefgh"],
      blockedNames: ["DEEPSEEK_API_KEY"],
    });
    expect(child.PATH).toBe("/usr/bin");
    expect(child.HOME).toBe("/home/u");
    expect(child.TMPDIR).toBe("/tmp");
    expect(child.LANG).toBe("en_US.UTF-8");
    expect(child.DEEPSEEK_API_KEY).toBeUndefined();
    expect(child.NPM_TOKEN).toBeUndefined();
    expect(child.CI).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
  });

  it("allows explicit non-secret extraNames and rejects secret names", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/bin",
      CI: "1",
      MY_TOKEN: "tokensecretvalue12",
    };
    const child = buildChildEnv(parent, {
      extraNames: ["CI", "MY_TOKEN"],
      blockedNames: [],
    });
    expect(child.CI).toBe("1");
    expect(child.MY_TOKEN).toBeUndefined();
  });
});

describe("resolveMcpEnvEntries", () => {
  it("resolves whole-string refs without copying parent env", () => {
    const resolved = resolveMcpEnvEntries(
      { API_TOKEN: "${ALLOWED}", LITERAL: "plain", ESCAPED: "$${NAME}" },
      (name) => (name === "ALLOWED" ? "allowed-value-abcdefgh" : undefined),
    );
    expect(resolved).toEqual({
      API_TOKEN: "allowed-value-abcdefgh",
      LITERAL: "plain",
      ESCAPED: "${NAME}",
    });
  });

  it("fail-closes on missing refs and partial interpolation", () => {
    expect(() => resolveMcpEnvEntries(
      { X: "${MISSING}" },
      () => undefined,
    )).toThrow(/unresolved/);
    expect(() => resolveMcpEnvEntries(
      { X: "prefix-${NAME}-suffix" },
      () => "v",
    )).toThrow(/whole-string/);
  });
});

describe("redactWithKnownValues", () => {
  it("redacts exact known values in nested payloads", () => {
    const secret = "sk-custom-provider-key-xyz";
    const out = redactWithKnownValues(
      { prompt: `use ${secret} please`, nested: [{ content: secret }] },
      [secret],
    ) as { prompt: string; nested: [{ content: string }] };
    expect(out.prompt).not.toContain(secret);
    expect(out.nested[0].content).toBe("[redacted]");
  });
});

describe("isSensitiveEnvName", () => {
  it("classifies provider and cloud secret names", () => {
    expect(isSensitiveEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveEnvName("NPM_TOKEN")).toBe(true);
    expect(isSensitiveEnvName("PATH")).toBe(false);
    expect(isSensitiveEnvName("CI")).toBe(false);
  });
});
