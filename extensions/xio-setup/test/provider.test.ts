import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseXioConfig } from "../../../src/cli/config-parser.ts";
import { runSetupCli } from "../src/setup-cli.ts";
import {
  applyProviderPreset,
  formatProviderPresetList,
  listSetupProviderPresets,
} from "../src/provider-setup.ts";
import { findProviderPreset } from "../../../src/cli/provider-catalog.ts";
import { DEFAULT_CONFIG_TOML } from "../../../src/cli/default-config.ts";

describe("provider presets", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const makeEnv = async (extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-provider-"));
    return { ...process.env, XIO_CONFIG: path.join(tmp, "config.toml"), ...extra };
  };

  it("catalog excludes custom and applying a preset parses with no plaintext key", () => {
    const presets = listSetupProviderPresets();
    expect(presets.some((preset) => preset.custom)).toBe(false);
    const openai = findProviderPreset("openai")!;
    const next = applyProviderPreset(DEFAULT_CONFIG_TOML, openai, { makeDefault: true });
    const parsed = parseXioConfig(next);
    expect(parsed.xio.general.defaultProvider).toBe("openai");
    expect(parsed.xio.general.defaultModel).toBe(openai.defaultModel);
    expect(next).toContain(`api_key_env = "${openai.apiKeyEnv}"`);
    // No key material — only the env var *name* may appear.
    expect(next).not.toMatch(/api_key\s*=/);
    expect(formatProviderPresetList()).toContain("OPENAI_API_KEY");
  });

  it("CLI adds a preset, validates, and never writes the env key value", async () => {
    const secret = "sk-test-plaintext-secret";
    const env = await makeEnv({ OPENAI_API_KEY: secret });
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);

    expect(
      await runSetupCli(["provider", "openai", "--model", "gpt-4o", "--default"], { env, write }),
    ).toBe(0);
    const content = await readFile(env.XIO_CONFIG!, "utf8");
    expect(content).toContain("[providers.openai]");
    expect(content).toContain('model = "gpt-4o"');
    expect(content).not.toContain(secret);
    const parsed = parseXioConfig(content);
    expect(parsed.xio.general.defaultProvider).toBe("openai");
    expect(parsed.xio.general.defaultModel).toBe("gpt-4o");
    expect(out.join("")).toContain("set OPENAI_API_KEY in your shell env");
  });

  it("rejects unknown presets (including custom) and lists known ids", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);
    expect(await runSetupCli(["provider", "nope"], { env, write })).toBe(1);
    expect(out.join("")).toContain("unknown provider preset: nope");
    out.length = 0;
    expect(await runSetupCli(["provider", "custom"], { env, write })).toBe(1);
  });

  it("bare provider without TTY lists presets instead of hanging", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    expect(
      await runSetupCli(["provider"], { env, write: (c) => out.push(c), isTty: false }),
    ).toBe(0);
    expect(out.join("")).toContain("provider presets");
    expect(out.join("")).toContain("deepseek");
  });

  it("interactive menu picks a preset by number with model + default prompts", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const presets = listSetupProviderPresets();
    const answers = ["2", "", "y"]; // second preset, default model, make default
    const code = await runSetupCli(["provider"], {
      env,
      write: (chunk) => out.push(chunk),
      ask: async () => answers.shift() ?? "q",
    });
    expect(code).toBe(0);
    const content = await readFile(env.XIO_CONFIG!, "utf8");
    const picked = presets[1]!;
    expect(content).toContain(`[providers.${picked.id}]`);
    expect(parseXioConfig(content).xio.general.defaultProvider).toBe(picked.id);
  });
});
