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
  /** Default session thinking effort (off|minimal|low|medium|high|xhigh|max|ultra). */
  defaultThinkingLevel?: XioThinkingLevel;
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

export type XioConfig = Readonly<{
  general: XioGeneralConfig;
  providers: Readonly<Record<string, XioProviderConfig>>;
  worktree: WorktreeConfig;
  extensions: Readonly<Record<string, XioExtensionConfig>>;
  verify: XioVerifyConfig;
  agentsMd: XioAgentsMdConfig;
  skills: XioSkillsConfig;
  hooks: XioHooksConfig;
  mcp: XioMcpConfig;
  permissions: XioPermissionsConfig;
  improve: XioImproveConfig;
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
  const xio: XioConfig = {
    general,
    providers,
    worktree,
    extensions,
    verify,
    agentsMd,
    skills,
    hooks,
    mcp,
    permissions,
    improve,
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
  return {
    defaultProvider: getOptionalString(table, "default_provider"),
    defaultModel: getOptionalString(table, "default_model"),
    runRoot: getOptionalString(table, "run_root") ?? DEFAULT_RUN_ROOT,
    maxSessionMessages,
    defaultThinkingLevel: getOptionalThinkingLevel(table, "default_thinking_level"),
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
