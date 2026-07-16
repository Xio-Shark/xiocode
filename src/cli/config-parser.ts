import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import { assertMaxSessionMessages } from "../runtime/context-compaction.ts";
import { DEFAULT_WORKTREE_CONFIG } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";

import type { WorktreeConfig, WorktreeSession } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";

export type ProviderKind = "openai" | "anthropic" | "mistral" | "google" | "google-vertex" | "bedrock" | string;
export type XioThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type XioProviderToolChoice = "auto" | "required" | "any";
export type XioProviderToolChoiceScope = "always" | "non_simple" | "never";
export type XioThinkingDisplay = "summarized" | "omitted";

export type XioGeneralConfig = Readonly<{
  defaultProvider?: string;
  defaultModel?: string;
  runRoot: string;
  /** Message budget that triggers automatic context compaction. Default 80. */
  maxSessionMessages?: number;
  /**
   * Approximate token budget that also triggers automatic compaction.
   * When unset, runtime may derive from the active model's context_window * 0.75.
   * Integer >= 1024 when set.
   */
  maxSessionTokens?: number;
  /** Default session thinking effort (off|minimal|low|medium|high|xhigh|max|ultra). */
  defaultThinkingLevel?: XioThinkingLevel;
  /**
   * Per user-prompt agent loop cap (provider requests). Default 24 when unset (agent-loop).
   * Range 1–40.
   */
  maxTurns?: number;
  /**
   * Block identical tool name+args after N consecutive calls. Default 3 when unset.
   * 0 disables. Range 0–20.
   */
  repeatToolLimit?: number;
}>;

export type XioProviderConfig = Readonly<{
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  parallelToolCalls?: boolean;
  toolChoice?: XioProviderToolChoice;
  toolChoiceScope?: XioProviderToolChoiceScope;
  thinkingDisplay?: XioThinkingDisplay;
  input?: readonly ("text" | "image")[];
  headers?: Readonly<Record<string, string>>;
  thinkingLevelMap?: Readonly<Partial<Record<XioThinkingLevel, string>>>;
  compat?: Readonly<Record<string, unknown>>;
}>;

export type XioExtensionConfig = Readonly<{
  enabled: boolean;
  options: Readonly<Record<string, unknown>>;
}>;

export type XioVerifyCommandConfig = Readonly<{
  name: string;
  argv: readonly string[];
  cwd?: string;
}>;

export type XioVerifyConfig = Readonly<{
  enabled: boolean;
  requireAllPass: boolean;
  repairTurns: number;
  commands: readonly XioVerifyCommandConfig[];
}>;

export type XioWorktreeRuntime = WorktreeConfig & Readonly<{
  session?: WorktreeSession;
}>;

export type XioAgentsMdConfig = Readonly<{
  enabled: boolean;
  readClaudeDirs: boolean;
  maxBytes: number;
  maxImportDepth: number;
}>;

export type XioSkillsConfig = Readonly<{
  enabled: boolean;
  readClaude: boolean;
  readCursor: boolean;
  maxBodyBytes: number;
}>;

export type XioHooksConfig = Readonly<{
  enabled: boolean;
  readClaude: boolean;
  timeoutMs: number;
}>;

export type XioMcpServerConfig = Readonly<{
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  url?: string;
  transport?: string;
  type?: string;
  headers?: Readonly<Record<string, string>>;
}>;

export type XioMcpConfig = Readonly<{
  enabled: boolean;
  readClaude: boolean;
  readCursor: boolean;
  failClosed: boolean;
  /** When true, skip auto-import from Claude/Cursor user configs (config/project only). */
  unknownSourceFailClosed: boolean;
  timeoutMs: number;
  servers: Readonly<Record<string, XioMcpServerConfig>>;
}>;

export type XioPermissionsConfig = Readonly<{
  /** When true, high-risk tools (exec/network/MCP) skip session ask / non-interactive deny. */
  allowHighRisk: boolean;
}>;

/** Dogfood defaults for `xio improve` when CLI flags are omitted. */
export type XioImproveConfig = Readonly<{
  /** Opt-in trusted capability gate before MergeGate ask. Default false. */
  capabilityGate: boolean;
  /** Optional private case id, or `"last"` for the durable last-captured pointer. */
  privateCase?: string;
}>;

/**
 * Post-task retrospective: after each full agent task, extract blockers → log → washed report
 * for the primary agent (and optional improve queue).
 */
export type XioRetrospectiveConfig = Readonly<{
  enabled: boolean;
  skipTrivial: boolean;
  minToolCalls: number;
  autoInject: boolean;
  enqueueImprove: boolean;
  /** Reserved for LLM polish; deterministic wash always runs. */
  useLlm: boolean;
}>;

/**
 * Primary→Flash multi-explore: main agent (e.g. Pro) spawns read-only Flash subagents.
 * Disabled by default; requires `enabled = true` and `model`.
 */
export type XioExploreConfig = Readonly<{
  enabled: boolean;
  /** Explore model id, or `provider/model` when provider is omitted. */
  model?: string;
  /** Provider id; defaults to general.default_provider when model has no provider prefix. */
  provider?: string;
  maxTurns: number;
  timeoutMs: number;
  /**
   * Absolute parallel ceiling (1–16). Default 16.
   * Runtime policy still caps default sessions at 4, ultra at 8+, user-requested high fan-out up to this value.
   */
  maxConcurrency: number;
  maxOutputChars: number;
  /** When true, explore subagents may use bash (host-reaching). Default false. */
  allowBash: boolean;
  /**
   * Soft wave token budget across explore workers (0 = unlimited).
   * Product default: 250_000.
   */
  maxTokens: number;
  /**
   * Soft wave cost budget in USD across explore workers (0 = unlimited).
   * Product default: 1.
   */
  maxCostUsd: number;
  /**
   * Max explore worker starts per rolling 60s (0 = unlimited). Provider-pressure limiter.
   * Product default: 24.
   */
  maxStartsPerMinute: number;
  /**
   * Optional user/project preference for how the primary splits work
   * (e.g. by API surface, feature area, package, layer). Free text.
   */
  partitionHint?: string;
}>;

export type XioConfig = Readonly<{
  general: XioGeneralConfig;
  providers: Readonly<Record<string, XioProviderConfig>>;
  worktree: WorktreeConfig;
  extensions: Readonly<Record<string, XioExtensionConfig>>;
  verify: XioVerifyConfig;
  agentsMd: XioAgentsMdConfig;
  skills: XioSkillsConfig;
  retrospective: XioRetrospectiveConfig;
  hooks: XioHooksConfig;
  mcp: XioMcpConfig;
  permissions: XioPermissionsConfig;
  improve: XioImproveConfig;
  explore: XioExploreConfig;
}>;

export type XioRuntimeConfig = Readonly<{
  providers: Readonly<Record<string, XioProviderConfig>>;
  worktree: XioWorktreeRuntime;
  extensions: Readonly<Record<string, XioExtensionConfig>>;
  general: XioGeneralConfig;
  verify: XioVerifyConfig;
  agentsMd: XioAgentsMdConfig;
  skills: XioSkillsConfig;
  hooks: XioHooksConfig;
  mcp: XioMcpConfig;
  permissions: XioPermissionsConfig;
  explore: XioExploreConfig;
  retrospective: XioRetrospectiveConfig;
}>;

export type ParsedXioConfig = Readonly<{
  xio: XioConfig;
  runtimeConfig: XioRuntimeConfig;
}>;

export type ParseConfigOptions = Readonly<{
  cwd?: string;
}>;

const DEFAULT_RUN_ROOT = "~/.xiocode/runs";
const DEFAULT_WORKSPACE_ROOT = process.cwd();
const DEFAULT_AGENTS_MD: XioAgentsMdConfig = {
  enabled: true,
  readClaudeDirs: true,
  maxBytes: 65_536,
  maxImportDepth: 3,
};

const DEFAULT_SKILLS: XioSkillsConfig = {
  enabled: true,
  readClaude: true,
  readCursor: true,
  maxBodyBytes: 32_768,
};

const DEFAULT_HOOKS: XioHooksConfig = {
  enabled: true,
  readClaude: true,
  timeoutMs: 5_000,
};

const DEFAULT_MCP: XioMcpConfig = {
  enabled: true,
  readClaude: true,
  readCursor: true,
  failClosed: false,
  unknownSourceFailClosed: false,
  timeoutMs: 30_000,
  servers: {},
};

const DEFAULT_PERMISSIONS: XioPermissionsConfig = {
  allowHighRisk: false,
};

const DEFAULT_IMPROVE: XioImproveConfig = {
  capabilityGate: false,
};

const DEFAULT_RETROSPECTIVE: XioRetrospectiveConfig = {
  enabled: true,
  skipTrivial: true,
  minToolCalls: 1,
  autoInject: true,
  enqueueImprove: true,
  useLlm: false,
};

const DEFAULT_EXPLORE: XioExploreConfig = {
  enabled: false,
  maxTurns: 12,
  timeoutMs: 180_000,
  /** Hard ceiling only; live policy: default ≤4, ultra ≥8, user-high ≤16. */
  maxConcurrency: 16,
  /** Large enough for multi-file verbatim excerpts; truncation is always marked, never silent. */
  maxOutputChars: 64_000,
  allowBash: false,
  /** Soft wave budgets — nonzero product defaults; set 0 to disable a limit. */
  maxTokens: 250_000,
  maxCostUsd: 1,
  maxStartsPerMinute: 24,
};

export function parseXioConfig(content: string, options: ParseConfigOptions = {}): ParsedXioConfig {
  const data = asTable(parse(content), "config");
  const cwd = options.cwd ?? DEFAULT_WORKSPACE_ROOT;
  void cwd;
  const general = parseGeneral(getTable(data, "general"));
  const providers = parseProviders(getTable(data, "providers"));
  const worktree = parseWorktree(getTable(data, "worktree"));
  const extensions = parseExtensions(getTable(data, "extensions"));
  const verify = parseVerify(getTable(data, "verify"));
  const agentsMd = parseAgentsMd(getTable(data, "agents_md"));
  const skills = parseSkills(getTable(data, "skills"));
  const hooks = parseHooks(getTable(data, "hooks"));
  const mcp = parseMcp(getTable(data, "mcp"));
  const permissions = parsePermissions(getTable(data, "permissions"));
  const improve = parseImprove(getTable(data, "improve"));
  const explore = parseExplore(getTable(data, "explore"));
  const retrospective = parseRetrospective(getTable(data, "retrospective"));
  const xio: XioConfig = {
    general,
    providers,
    worktree,
    extensions,
    verify,
    agentsMd,
    skills,
    retrospective,
    hooks,
    mcp,
    permissions,
    improve,
    explore,
  };
  return {
    xio,
    runtimeConfig: toRuntimeConfig(xio),
  };
}

export function toRuntimeConfig(config: XioConfig): XioRuntimeConfig {
  return {
    general: config.general,
    providers: config.providers,
    worktree: { ...config.worktree },
    extensions: config.extensions,
    verify: config.verify,
    agentsMd: config.agentsMd,
    skills: config.skills,
    hooks: config.hooks,
    mcp: config.mcp,
    permissions: config.permissions,
    explore: config.explore,
    retrospective: config.retrospective,
  };
}

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseGeneral(table: Record<string, unknown> | undefined): XioGeneralConfig {
  const maxSessionMessages = getOptionalNumber(table, "max_session_messages");
  if (maxSessionMessages !== undefined) assertMaxSessionMessages(maxSessionMessages);
  const maxSessionTokens = getOptionalNumber(table, "max_session_tokens");
  if (maxSessionTokens !== undefined) {
    if (!Number.isInteger(maxSessionTokens) || maxSessionTokens < 1024) {
      throw new Error("general.max_session_tokens must be an integer >= 1024");
    }
  }
  const maxTurns = getOptionalNumber(table, "max_turns");
  if (maxTurns !== undefined) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 40) {
      throw new Error("general.max_turns must be an integer between 1 and 40");
    }
  }
  const repeatToolLimit = getOptionalNumber(table, "repeat_tool_limit");
  if (repeatToolLimit !== undefined) {
    if (!Number.isInteger(repeatToolLimit) || repeatToolLimit < 0 || repeatToolLimit > 20) {
      throw new Error("general.repeat_tool_limit must be an integer between 0 and 20");
    }
  }
  return {
    defaultProvider: getOptionalString(table, "default_provider"),
    defaultModel: getOptionalString(table, "default_model"),
    runRoot: getOptionalString(table, "run_root") ?? DEFAULT_RUN_ROOT,
    maxSessionMessages,
    maxSessionTokens,
    defaultThinkingLevel: getOptionalThinkingLevel(table, "default_thinking_level"),
    maxTurns,
    repeatToolLimit,
  };
}

function parseProviders(table: Record<string, unknown> | undefined): Readonly<Record<string, XioProviderConfig>> {
  if (!table) {
    return {};
  }
  const providers: Record<string, XioProviderConfig> = {};
  for (const [name, value] of Object.entries(table)) {
    const provider = asTable(value, `providers.${name}`);
    providers[name] = {
      name,
      kind: getRequiredString(provider, "kind", `providers.${name}`),
      baseUrl: getOptionalString(provider, "base_url"),
      model: getOptionalString(provider, "model"),
      apiKeyEnv: getOptionalString(provider, "api_key_env"),
      reasoning: getOptionalBoolean(provider, "reasoning"),
      contextWindow: getOptionalNumber(provider, "context_window"),
      maxTokens: getOptionalNumber(provider, "max_tokens"),
      parallelToolCalls: getOptionalBoolean(provider, "parallel_tool_calls"),
      toolChoice: getProviderToolChoice(provider.tool_choice, `providers.${name}.tool_choice`),
      toolChoiceScope: getProviderToolChoiceScope(provider.tool_choice_scope, `providers.${name}.tool_choice_scope`),
      thinkingDisplay: getThinkingDisplay(provider.thinking_display, `providers.${name}.thinking_display`),
      input: getInputTypes(provider.input, `providers.${name}.input`),
      headers: getStringRecord(provider.headers, `providers.${name}.headers`),
      thinkingLevelMap: getThinkingLevelMap(provider.thinking_level_map, `providers.${name}.thinking_level_map`),
      compat: getRecord(provider.compat, `providers.${name}.compat`),
    };
  }
  return providers;
}

function parseWorktree(table: Record<string, unknown> | undefined): WorktreeConfig {
  return {
    enabled: getOptionalBoolean(table, "enabled") ?? DEFAULT_WORKTREE_CONFIG.enabled,
    retainOnReject: getOptionalBoolean(table, "retain_on_reject") ?? DEFAULT_WORKTREE_CONFIG.retainOnReject,
    allowDirty: getOptionalBoolean(table, "allow_dirty") ?? DEFAULT_WORKTREE_CONFIG.allowDirty,
  };
}

function parseExtensions(table: Record<string, unknown> | undefined): Readonly<Record<string, XioExtensionConfig>> {
  const defaults: Record<string, XioExtensionConfig> = {
    evolve: { enabled: true, options: {} },
    sandbox: { enabled: true, options: {} },
  };
  if (!table) {
    return defaults;
  }
  for (const [name, value] of Object.entries(table)) {
    if (name === "ace-tool") {
      continue;
    }
    const extension = asTable(value, `extensions.${name}`);
    const enabled = getOptionalBoolean(extension, "enabled") ?? defaults[name]?.enabled ?? true;
    defaults[name] = { enabled, options: stripEnabled(extension) };
  }
  return defaults;
}

function parseVerify(table: Record<string, unknown> | undefined): XioVerifyConfig {
  const enabled = getOptionalBoolean(table, "enabled") ?? false;
  const requireAllPass = getOptionalBoolean(table, "require_all_pass") ?? true;
  const repairTurns = getOptionalNumber(table, "repair_turns") ?? 3;
  const commands = parseVerifyCommands(table?.commands);
  return { enabled, requireAllPass, repairTurns, commands };
}

function parseAgentsMd(table: Record<string, unknown> | undefined): XioAgentsMdConfig {
  return {
    enabled: getOptionalBoolean(table, "enabled") ?? DEFAULT_AGENTS_MD.enabled,
    readClaudeDirs: getOptionalBoolean(table, "read_claude_dirs") ?? DEFAULT_AGENTS_MD.readClaudeDirs,
    maxBytes: getOptionalNumber(table, "max_bytes") ?? DEFAULT_AGENTS_MD.maxBytes,
    maxImportDepth: getOptionalNumber(table, "max_import_depth") ?? DEFAULT_AGENTS_MD.maxImportDepth,
  };
}

function parseSkills(table: Record<string, unknown> | undefined): XioSkillsConfig {
  return {
    enabled: getOptionalBoolean(table, "enabled") ?? DEFAULT_SKILLS.enabled,
    readClaude: getOptionalBoolean(table, "read_claude") ?? DEFAULT_SKILLS.readClaude,
    readCursor: getOptionalBoolean(table, "read_cursor") ?? DEFAULT_SKILLS.readCursor,
    maxBodyBytes: getOptionalNumber(table, "max_body_bytes") ?? DEFAULT_SKILLS.maxBodyBytes,
  };
}

function parseHooks(table: Record<string, unknown> | undefined): XioHooksConfig {
  return {
    enabled: getOptionalBoolean(table, "enabled") ?? DEFAULT_HOOKS.enabled,
    readClaude: getOptionalBoolean(table, "read_claude") ?? DEFAULT_HOOKS.readClaude,
    timeoutMs: getOptionalNumber(table, "timeout_ms") ?? DEFAULT_HOOKS.timeoutMs,
  };
}

function parseMcp(table: Record<string, unknown> | undefined): XioMcpConfig {
  return {
    enabled: getOptionalBoolean(table, "enabled") ?? DEFAULT_MCP.enabled,
    readClaude: getOptionalBoolean(table, "read_claude") ?? DEFAULT_MCP.readClaude,
    readCursor: getOptionalBoolean(table, "read_cursor") ?? DEFAULT_MCP.readCursor,
    failClosed: getOptionalBoolean(table, "fail_closed") ?? DEFAULT_MCP.failClosed,
    unknownSourceFailClosed:
      getOptionalBoolean(table, "unknown_source_fail_closed") ?? DEFAULT_MCP.unknownSourceFailClosed,
    timeoutMs: getOptionalNumber(table, "timeout_ms") ?? DEFAULT_MCP.timeoutMs,
    servers: parseMcpServers(table ? getTable(table, "servers") : undefined),
  };
}

function parsePermissions(table: Record<string, unknown> | undefined): XioPermissionsConfig {
  return {
    allowHighRisk: getOptionalBoolean(table, "allow_high_risk") ?? DEFAULT_PERMISSIONS.allowHighRisk,
  };
}

function parseImprove(table: Record<string, unknown> | undefined): XioImproveConfig {
  const privateCase = getOptionalString(table, "private_case")?.trim();
  if (privateCase !== undefined && privateCase.length === 0) {
    throw new Error("improve.private_case must be a non-empty string when set");
  }
  if (privateCase !== undefined && privateCase !== "last" && !/^[a-f0-9]{64}$/.test(privateCase)) {
    throw new Error('improve.private_case must be "last" or a 64-char hex case id');
  }
  return {
    capabilityGate: getOptionalBoolean(table, "capability_gate") ?? DEFAULT_IMPROVE.capabilityGate,
    ...(privateCase ? { privateCase } : {}),
  };
}

function parseRetrospective(table: Record<string, unknown> | undefined): XioRetrospectiveConfig {
  const minToolCalls = getOptionalNumber(table, "min_tool_calls") ?? DEFAULT_RETROSPECTIVE.minToolCalls;
  if (!Number.isInteger(minToolCalls) || minToolCalls < 0 || minToolCalls > 100) {
    throw new Error("retrospective.min_tool_calls must be an integer between 0 and 100");
  }
  return {
    enabled: getOptionalBoolean(table, "enabled") ?? DEFAULT_RETROSPECTIVE.enabled,
    skipTrivial: getOptionalBoolean(table, "skip_trivial") ?? DEFAULT_RETROSPECTIVE.skipTrivial,
    minToolCalls,
    autoInject: getOptionalBoolean(table, "auto_inject") ?? DEFAULT_RETROSPECTIVE.autoInject,
    enqueueImprove: getOptionalBoolean(table, "enqueue_improve") ?? DEFAULT_RETROSPECTIVE.enqueueImprove,
    useLlm: getOptionalBoolean(table, "use_llm") ?? DEFAULT_RETROSPECTIVE.useLlm,
  };
}

function parseExplore(table: Record<string, unknown> | undefined): XioExploreConfig {
  const maxTurns = getOptionalNumber(table, "max_turns") ?? DEFAULT_EXPLORE.maxTurns;
  const timeoutMs = getOptionalNumber(table, "timeout_ms") ?? DEFAULT_EXPLORE.timeoutMs;
  const maxConcurrency = getOptionalNumber(table, "max_concurrency") ?? DEFAULT_EXPLORE.maxConcurrency;
  const maxOutputChars = getOptionalNumber(table, "max_output_chars") ?? DEFAULT_EXPLORE.maxOutputChars;
  const maxTokens = getOptionalNumber(table, "max_tokens") ?? DEFAULT_EXPLORE.maxTokens;
  const maxCostUsd = getOptionalNumber(table, "max_cost_usd") ?? DEFAULT_EXPLORE.maxCostUsd;
  const maxStartsPerMinute =
    getOptionalNumber(table, "max_starts_per_minute") ?? DEFAULT_EXPLORE.maxStartsPerMinute;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 40) {
    throw new Error("explore.max_turns must be an integer between 1 and 40");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("explore.timeout_ms must be an integer >= 1000");
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    throw new Error("explore.max_concurrency must be an integer between 1 and 16");
  }
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1_000) {
    throw new Error("explore.max_output_chars must be an integer >= 1000");
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new Error("explore.max_tokens must be an integer >= 0 (0 = unlimited)");
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error("explore.max_cost_usd must be a number >= 0 (0 = unlimited)");
  }
  if (!Number.isInteger(maxStartsPerMinute) || maxStartsPerMinute < 0) {
    throw new Error("explore.max_starts_per_minute must be an integer >= 0 (0 = unlimited)");
  }
  const enabled = getOptionalBoolean(table, "enabled") ?? DEFAULT_EXPLORE.enabled;
  const model = getOptionalString(table, "model")?.trim();
  const provider = getOptionalString(table, "provider")?.trim();
  const partitionHint = getOptionalString(table, "partition_hint")?.trim();
  if (enabled && (!model || model.length === 0)) {
    throw new Error("explore.model is required when explore.enabled = true");
  }
  if (partitionHint !== undefined && partitionHint.length === 0) {
    throw new Error("explore.partition_hint must be non-empty when set");
  }
  return {
    enabled,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    maxTurns,
    timeoutMs,
    maxConcurrency,
    maxOutputChars,
    allowBash: getOptionalBoolean(table, "allow_bash") ?? DEFAULT_EXPLORE.allowBash,
    maxTokens,
    maxCostUsd,
    maxStartsPerMinute,
    ...(partitionHint ? { partitionHint } : {}),
  };
}

function parseMcpServers(table: Record<string, unknown> | undefined): Readonly<Record<string, XioMcpServerConfig>> {
  if (!table) {
    return {};
  }
  const servers: Record<string, XioMcpServerConfig> = {};
  for (const [name, value] of Object.entries(table)) {
    const server = asTable(value, `mcp.servers.${name}`);
    const args = getStringArray(server.args, `mcp.servers.${name}.args`);
    const envTable = getTable(server, "env");
    const headersTable = getTable(server, "headers");
    servers[name] = {
      command: getOptionalString(server, "command"),
      args,
      env: envTable ? stringRecord(envTable, `mcp.servers.${name}.env`) : undefined,
      cwd: getOptionalString(server, "cwd"),
      url: getOptionalString(server, "url"),
      transport: getOptionalString(server, "transport"),
      type: getOptionalString(server, "type"),
      headers: headersTable ? stringRecord(headersTable, `mcp.servers.${name}.headers`) : undefined,
    };
  }
  return servers;
}

function stringRecord(table: Record<string, unknown>, label: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table)) {
    if (typeof value !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

function parseVerifyCommands(value: unknown): readonly XioVerifyCommandConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("verify.commands must be an array of tables");
  }
  return value.map((item, index) => {
    const table = asTable(item, `verify.commands[${index}]`);
    const name = getOptionalString(table, "name") ?? `command_${index + 1}`;
    const argv = getStringArray(table.argv, `verify.commands[${index}].argv`);
    if (!argv || argv.length === 0) {
      throw new Error(`verify.commands[${index}].argv is required`);
    }
    return {
      name,
      argv,
      cwd: getOptionalString(table, "cwd"),
    };
  });
}

function stripEnabled(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "enabled") {
      result[key] = item;
    }
  }
  return result;
}

function getTable(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = data[key];
  if (value === undefined) {
    return undefined;
  }
  return asTable(value, key);
}

function asTable(value: unknown, name: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${name} must be a table`);
}

function getRequiredString(table: Record<string, unknown>, key: string, context: string): string {
  const value = getOptionalString(table, key);
  if (value === undefined) {
    throw new Error(`${context}.${key} is required`);
  }
  return value;
}

function getOptionalString(table: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = table?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${key} must be a string`);
}

function getOptionalBoolean(table: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = table?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${key} must be a boolean`);
}

function getOptionalNumber(table: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = table?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`${key} must be a number`);
}

function getStringArray(value: unknown, context: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error(`${context} must be a string array`);
}

function getInputTypes(value: unknown, context: string): readonly ("text" | "image")[] | undefined {
  const input = getStringArray(value, context);
  if (input === undefined) {
    return undefined;
  }
  if (input.every((item) => item === "text" || item === "image")) {
    return input;
  }
  throw new Error(`${context} must contain only text or image`);
}

function getStringRecord(value: unknown, context: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asTable(value, context);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new Error(`${context}.${key} must be a string`);
    }
  }
  return record as Record<string, string>;
}

function getThinkingLevelMap(value: unknown, context: string): Readonly<Partial<Record<XioThinkingLevel, string>>> | undefined {
  const record = getStringRecord(value, context);
  if (record === undefined) {
    return undefined;
  }
  for (const key of Object.keys(record)) {
    if (!isThinkingLevel(key)) {
      throw new Error(`${context} keys must be off, minimal, low, medium, high, xhigh, max, or ultra`);
    }
  }
  return record as Partial<Record<XioThinkingLevel, string>>;
}

function getProviderToolChoice(value: unknown, context: string): XioProviderToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "auto" || value === "required" || value === "any") {
    return value;
  }
  throw new Error(`${context} must be auto, required, or any`);
}

function getProviderToolChoiceScope(value: unknown, context: string): XioProviderToolChoiceScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "always" || value === "non_simple" || value === "never") {
    return value;
  }
  throw new Error(`${context} must be always, non_simple, or never`);
}

function getThinkingDisplay(value: unknown, context: string): XioThinkingDisplay | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "summarized" || value === "omitted") {
    return value;
  }
  throw new Error(`${context} must be summarized or omitted`);
}

function getRecord(value: unknown, context: string): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : asTable(value, context);
}

function isThinkingLevel(value: string): value is XioThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra";
}

function getOptionalThinkingLevel(
  table: Record<string, unknown> | undefined,
  key: string,
): XioThinkingLevel | undefined {
  if (!table || !(key in table)) return undefined;
  const value = table[key];
  if (typeof value !== "string" || !isThinkingLevel(value)) {
    throw new Error(`general.${key} must be off, minimal, low, medium, high, xhigh, max, or ultra`);
  }
  return value;
}
