import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import { DEFAULT_WORKTREE_CONFIG } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";

import type { WorktreeConfig, WorktreeSession } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";

export type ProviderKind = "openai" | "anthropic" | "mistral" | "google" | "google-vertex" | "bedrock" | string;
export type XioThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type XioProviderToolChoice = "auto" | "required" | "any";
export type XioProviderToolChoiceScope = "always" | "non_simple" | "never";
export type XioThinkingDisplay = "summarized" | "omitted";

export type XioGeneralConfig = Readonly<{
  defaultProvider?: string;
  defaultModel?: string;
  runRoot: string;
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

export type XioConfig = Readonly<{
  general: XioGeneralConfig;
  providers: Readonly<Record<string, XioProviderConfig>>;
  worktree: WorktreeConfig;
  extensions: Readonly<Record<string, XioExtensionConfig>>;
  verify: XioVerifyConfig;
}>;

export type XioRuntimeConfig = Readonly<{
  providers: Readonly<Record<string, XioProviderConfig>>;
  worktree: XioWorktreeRuntime;
  extensions: Readonly<Record<string, XioExtensionConfig>>;
  general: XioGeneralConfig;
  verify: XioVerifyConfig;
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

export function parseXioConfig(content: string, options: ParseConfigOptions = {}): ParsedXioConfig {
  const data = asTable(parse(content), "config");
  const cwd = options.cwd ?? DEFAULT_WORKSPACE_ROOT;
  void cwd;
  const general = parseGeneral(getTable(data, "general"));
  const providers = parseProviders(getTable(data, "providers"));
  const worktree = parseWorktree(getTable(data, "worktree"));
  const extensions = parseExtensions(getTable(data, "extensions"));
  const verify = parseVerify(getTable(data, "verify"));
  const xio: XioConfig = { general, providers, worktree, extensions, verify };
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
  return {
    defaultProvider: getOptionalString(table, "default_provider"),
    defaultModel: getOptionalString(table, "default_model"),
    runRoot: getOptionalString(table, "run_root") ?? DEFAULT_RUN_ROOT,
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
      throw new Error(`${context} keys must be off, minimal, low, medium, high, xhigh, or max`);
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
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
