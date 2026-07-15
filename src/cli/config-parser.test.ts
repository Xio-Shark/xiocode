import { describe, expect, it } from "vitest";

import { parseXioConfig } from "./config-parser.ts";
import { setupProviderEnv, targetApiKeyEnv } from "./env-setup.ts";

const SAMPLE_CONFIG = `
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
run_root = "~/.xiocode/runs"
max_session_messages = 40

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
    expect(parsed.runtimeConfig.general.maxSessionMessages).toBe(40);
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

  it("parses default_thinking_level including ultra", () => {
    const parsed = parseXioConfig(`
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
default_thinking_level = "ultra"
run_root = "~/.xiocode/runs"

[providers.deepseek]
kind = "openai"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"

[providers.deepseek.thinking_level_map]
ultra = "ultra"
`);
    expect(parsed.runtimeConfig.general.defaultThinkingLevel).toBe("ultra");
    expect(parsed.runtimeConfig.providers.deepseek?.thinkingLevelMap).toEqual({ ultra: "ultra" });
  });

  it("rejects unsafe or fractional max_session_messages values", () => {
    expect(() => parseXioConfig("[general]\nmax_session_messages = 3\n"))
      .toThrow("general.max_session_messages must be an integer >= 4");
    expect(() => parseXioConfig("[general]\nmax_session_messages = 4.5\n"))
      .toThrow("general.max_session_messages must be an integer >= 4");
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
    ).toThrow("providers.bad.thinking_level_map keys must be off, minimal, low, medium, high, xhigh, max, or ultra");
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
      allowDirty: false,
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
    expect(parsed.runtimeConfig.worktree).toEqual({ enabled: true, retainOnReject: false, allowDirty: false });
    expect(parsed.runtimeConfig.verify).toEqual({
      enabled: false,
      requireAllPass: true,
      repairTurns: 3,
      commands: [],
    });
    expect(parsed.runtimeConfig.agentsMd).toEqual({
      enabled: true,
      readClaudeDirs: true,
      maxBytes: 65_536,
      maxImportDepth: 3,
    });
    expect(parsed.runtimeConfig.skills).toEqual({
      enabled: true,
      readClaude: true,
      readCursor: true,
      maxBodyBytes: 32_768,
    });
    expect(parsed.runtimeConfig.hooks).toEqual({
      enabled: true,
      readClaude: true,
      timeoutMs: 5_000,
    });
    expect(parsed.runtimeConfig.explore).toEqual({
      enabled: false,
      maxTurns: 12,
      timeoutMs: 180_000,
      maxConcurrency: 4,
      maxOutputChars: 64_000,
      allowBash: false,
    });
  });

  it("parses explore multi-subagent config", () => {
    const parsed = parseXioConfig(
      `
[explore]
enabled = true
model = "deepseek-v4-flash"
provider = "opencode-go"
max_turns = 8
max_concurrency = 3
timeout_ms = 60000
max_output_chars = 8000
allow_bash = true
partition_hint = "按 API 边界划分"
`,
      { cwd: "/repo" },
    );
    expect(parsed.runtimeConfig.explore).toEqual({
      enabled: true,
      model: "deepseek-v4-flash",
      provider: "opencode-go",
      maxTurns: 8,
      timeoutMs: 60_000,
      maxConcurrency: 3,
      maxOutputChars: 8_000,
      allowBash: true,
      partitionHint: "按 API 边界划分",
    });
  });

  it("parses general.max_turns and repeat_tool_limit", () => {
    const parsed = parseXioConfig(
      `
[general]
max_turns = 18
repeat_tool_limit = 2
`,
      { cwd: "/repo" },
    );
    expect(parsed.runtimeConfig.general.maxTurns).toBe(18);
    expect(parsed.runtimeConfig.general.repeatToolLimit).toBe(2);
  });

  it("rejects invalid general.max_turns", () => {
    expect(() => parseXioConfig(`[general]\nmax_turns = 0\n`, { cwd: "/repo" }))
      .toThrow(/general\.max_turns/);
    expect(() => parseXioConfig(`[general]\nmax_turns = 41\n`, { cwd: "/repo" }))
      .toThrow(/general\.max_turns/);
  });

  it("rejects explore.max_concurrency above 16", () => {
    expect(() => parseXioConfig(
      `[explore]\nenabled = true\nmodel = "flash"\nmax_concurrency = 17\n`,
      { cwd: "/repo" },
    )).toThrow(/max_concurrency/);
  });

  it("rejects explore.enabled without model", () => {
    expect(() => parseXioConfig(`[explore]\nenabled = true\n`, { cwd: "/repo" }))
      .toThrow(/explore\.model is required/);
  });

  it("parses agents_md kill-switch and limits", () => {
    const parsed = parseXioConfig(
      `
[agents_md]
enabled = false
read_claude_dirs = false
max_bytes = 1024
max_import_depth = 1
`,
      { cwd: "/repo" },
    );

    expect(parsed.runtimeConfig.agentsMd).toEqual({
      enabled: false,
      readClaudeDirs: false,
      maxBytes: 1024,
      maxImportDepth: 1,
    });
  });

  it("parses skills kill-switch and source flags", () => {
    const parsed = parseXioConfig(
      `
[skills]
enabled = false
read_claude = false
read_cursor = true
max_body_bytes = 4096
`,
      { cwd: "/repo" },
    );

    expect(parsed.runtimeConfig.skills).toEqual({
      enabled: false,
      readClaude: false,
      readCursor: true,
      maxBodyBytes: 4096,
    });
  });

  it("parses hooks kill-switch and timeout", () => {
    const parsed = parseXioConfig(
      `
[hooks]
enabled = false
read_claude = false
timeout_ms = 1500
`,
      { cwd: "/repo" },
    );

    expect(parsed.runtimeConfig.hooks).toEqual({
      enabled: false,
      readClaude: false,
      timeoutMs: 1500,
    });
  });

  it("defaults hooks to enabled with 5s timeout", () => {
    const parsed = parseXioConfig(SAMPLE_CONFIG, { cwd: "/repo" });
    expect(parsed.runtimeConfig.hooks).toEqual({
      enabled: true,
      readClaude: true,
      timeoutMs: 5_000,
    });
  });

  it("parses mcp kill-switch, sources, and servers", () => {
    const parsed = parseXioConfig(
      `
[mcp]
enabled = false
read_claude = false
read_cursor = true
fail_closed = true
timeout_ms = 12000

[mcp.servers.echo]
command = "node"
args = ["./echo.mjs"]

[mcp.servers.remote]
url = "http://127.0.0.1:9/mcp"
transport = "http"

[mcp.servers.remote.headers]
Authorization = "Bearer x"
`,
      { cwd: "/repo" },
    );

    expect(parsed.runtimeConfig.mcp).toEqual({
      enabled: false,
      readClaude: false,
      readCursor: true,
      failClosed: true,
      unknownSourceFailClosed: false,
      timeoutMs: 12_000,
      servers: {
        echo: {
          command: "node",
          args: ["./echo.mjs"],
          env: undefined,
          cwd: undefined,
          url: undefined,
          transport: undefined,
          type: undefined,
          headers: undefined,
        },
        remote: {
          command: undefined,
          args: undefined,
          env: undefined,
          cwd: undefined,
          url: "http://127.0.0.1:9/mcp",
          transport: "http",
          type: undefined,
          headers: { Authorization: "Bearer x" },
        },
      },
    });
  });

  it("defaults mcp to enabled fail-open", () => {
    const parsed = parseXioConfig(SAMPLE_CONFIG, { cwd: "/repo" });
    expect(parsed.runtimeConfig.mcp).toEqual({
      enabled: true,
      readClaude: true,
      readCursor: true,
      failClosed: false,
      unknownSourceFailClosed: false,
      timeoutMs: 30_000,
      servers: {},
    });
    expect(parsed.runtimeConfig.permissions).toEqual({ allowHighRisk: false });
    expect(parsed.xio.improve).toEqual({ capabilityGate: false });
  });

  it("parses permissions and mcp unknown_source_fail_closed", () => {
    const parsed = parseXioConfig(
      `
[permissions]
allow_high_risk = true

[mcp]
unknown_source_fail_closed = true
`,
      { cwd: "/repo" },
    );
    expect(parsed.runtimeConfig.permissions).toEqual({ allowHighRisk: true });
    expect(parsed.runtimeConfig.mcp.unknownSourceFailClosed).toBe(true);
  });

  it("parses improve capability_gate and private_case defaults", () => {
    const caseId = "d".repeat(64);
    const parsed = parseXioConfig(
      `
[improve]
capability_gate = true
private_case = "last"
`,
      { cwd: "/repo" },
    );
    expect(parsed.xio.improve).toEqual({ capabilityGate: true, privateCase: "last" });

    const explicit = parseXioConfig(
      `
[improve]
capability_gate = true
private_case = "${caseId}"
`,
      { cwd: "/repo" },
    );
    expect(explicit.xio.improve).toEqual({ capabilityGate: true, privateCase: caseId });

    expect(() => parseXioConfig(`[improve]\nprivate_case = "not-a-case"\n`, { cwd: "/repo" }))
      .toThrow(/improve\.private_case/);
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
