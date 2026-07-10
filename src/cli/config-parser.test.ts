import { describe, expect, it } from "vitest";

import { parseXioConfig } from "./config-parser.ts";
import { setupProviderEnv, targetApiKeyEnv } from "./env-setup.ts";

const SAMPLE_CONFIG = `
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
run_root = "~/.xiocode/runs"

[providers.deepseek]
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "XIO_DEEPSEEK_KEY"
reasoning = true
context_window = 64000
max_tokens = 4096
parallel_tool_calls = true
tool_choice = "required"
tool_choice_scope = "always"
thinking_display = "omitted"
input = ["text", "image"]

[providers.deepseek.headers]
X-Test = "enabled"

[providers.deepseek.thinking_level_map]
off = "none"
high = "large"

[providers.deepseek.compat]
thinkingFormat = "deepseek"

[worktree]
enabled = true
retain_on_reject = true

[extensions.ace-tool]
enabled = true
base_url_env = "ACE_TOOL_BASE_URL"

[extensions.evolve]
enabled = true
auto_evolve_after_runs = 5
strategy_report_path = "~/.xiocode/strategy/current.json"
async_model_switch = true
`;

describe("parseXioConfig", () => {
  it("maps general and providers into runtime config", () => {
    const parsed = parseXioConfig(SAMPLE_CONFIG, { cwd: "/repo" });

    expect(parsed.runtimeConfig.general.defaultProvider).toBe("deepseek");
    expect(parsed.runtimeConfig.general.defaultModel).toBe("deepseek-chat");
    expect(parsed.runtimeConfig.providers.deepseek).toMatchObject({
      name: "deepseek",
      kind: "openai",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKeyEnv: "XIO_DEEPSEEK_KEY",
      reasoning: true,
      contextWindow: 64000,
      maxTokens: 4096,
      parallelToolCalls: true,
      toolChoice: "required",
      toolChoiceScope: "always",
      thinkingDisplay: "omitted",
      input: ["text", "image"],
      headers: { "X-Test": "enabled" },
      thinkingLevelMap: { off: "none", high: "large" },
      compat: { thinkingFormat: "deepseek" },
    });
  });

  it("rejects invalid provider input types and thinking map keys", () => {
    expect(() =>
      parseXioConfig(`
[providers.bad]
kind = "openai"
model = "bad"
input = ["audio"]
`),
    ).toThrow("providers.bad.input must contain only text or image");

    expect(() =>
      parseXioConfig(`
[providers.bad]
kind = "openai"
model = "bad"

[providers.bad.thinking_level_map]
turbo = "yes"
`),
    ).toThrow("providers.bad.thinking_level_map keys must be off, minimal, low, medium, high, xhigh, or max");
  });

  it("rejects invalid provider parallel tool call settings", () => {
    expect(() =>
      parseXioConfig(`
[providers.bad]
kind = "openai"
model = "bad"
parallel_tool_calls = "yes"
`),
    ).toThrow("parallel_tool_calls must be a boolean");
  });

  it("rejects invalid provider tool choice settings", () => {
    expect(() =>
      parseXioConfig(`
[providers.bad]
kind = "openai"
model = "bad"
tool_choice = "force"
`),
    ).toThrow("providers.bad.tool_choice must be auto, required, or any");
  });

  it("rejects invalid provider tool choice scope settings", () => {
    expect(() =>
      parseXioConfig(`
[providers.bad]
kind = "openai"
model = "bad"
tool_choice_scope = "simple"
`),
    ).toThrow("providers.bad.tool_choice_scope must be always, non_simple, or never");
  });

  it("rejects invalid provider thinking display settings", () => {
    expect(() =>
      parseXioConfig(`
[providers.bad]
kind = "anthropic"
model = "claude"
thinking_display = "hidden"
`),
    ).toThrow("providers.bad.thinking_display must be summarized or omitted");
  });

  it("maps worktree config fields", () => {
    const parsed = parseXioConfig(SAMPLE_CONFIG, { cwd: "/repo" });

    expect(parsed.runtimeConfig.worktree).toEqual({
      enabled: true,
      retainOnReject: true,
    });
  });

  it("maps extension toggles and ignores removed ace-tool", () => {
    const parsed = parseXioConfig(SAMPLE_CONFIG, { cwd: "/repo" });

    expect(parsed.runtimeConfig.extensions["ace-tool"]).toBeUndefined();
    expect(parsed.runtimeConfig.extensions.evolve).toEqual({
      enabled: true,
      options: {
        async_model_switch: true,
        auto_evolve_after_runs: 5,
        strategy_report_path: "~/.xiocode/strategy/current.json",
      },
    });
  });

  it("defaults evolve and sandbox extensions on", () => {
    const parsed = parseXioConfig("", { cwd: "/repo" });

    expect(parsed.runtimeConfig.extensions.evolve).toEqual({ enabled: true, options: {} });
    expect(parsed.runtimeConfig.extensions.sandbox).toEqual({ enabled: true, options: {} });
    expect(parsed.runtimeConfig.extensions["ace-tool"]).toBeUndefined();
    expect(parsed.runtimeConfig.worktree).toEqual({ enabled: true, retainOnReject: false });
    expect(parsed.runtimeConfig.verify).toEqual({
      enabled: false,
      requireAllPass: true,
      repairTurns: 3,
      commands: [],
    });
  });

  it("parses verify done-contract commands", () => {
    const parsed = parseXioConfig(
      `
[verify]
enabled = true
require_all_pass = true
repair_turns = 2

[[verify.commands]]
name = "check"
argv = ["npm", "run", "check"]

[[verify.commands]]
name = "unit"
argv = ["npm", "run", "test:unit"]
`,
      { cwd: "/repo" },
    );

    expect(parsed.runtimeConfig.verify).toEqual({
      enabled: true,
      requireAllPass: true,
      repairTurns: 2,
      commands: [
        { name: "check", argv: ["npm", "run", "check"] },
        { name: "unit", argv: ["npm", "run", "test:unit"] },
      ],
    });
  });
});

describe("setupProviderEnv", () => {
  it("copies api_key_env to provider env aliases", () => {
    const parsed = parseXioConfig(SAMPLE_CONFIG, { cwd: "/repo" });
    const env: NodeJS.ProcessEnv = { XIO_DEEPSEEK_KEY: "secret" };
    const result = setupProviderEnv(parsed.xio.providers, env);
    const provider = parsed.xio.providers.deepseek;

    expect(provider).toBeDefined();
    expect(targetApiKeyEnv(provider!)).toBe("DEEPSEEK_API_KEY");
    expect(env.DEEPSEEK_API_KEY).toBe("secret");
    expect(result).toEqual([
      {
        provider: "deepseek",
        sourceEnv: "XIO_DEEPSEEK_KEY",
        targetEnv: "DEEPSEEK_API_KEY",
        applied: true,
      },
    ]);
  });
});
