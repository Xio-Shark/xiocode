import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { CommandHandlerContext, ExtensionContext } from "../../xio-evolve/src/types.ts";

export type HooksConfig = Readonly<{
  enabled: boolean;
  readClaude: boolean;
  timeoutMs: number;
}>;

export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
  enabled: true,
  readClaude: true,
  timeoutMs: 5_000,
};

export const SUPPORTED_HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] as const;
export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number];

export type HookCommand = Readonly<{
  type: "command";
  command: string;
  timeoutMs?: number;
}>;

export type HookMatcherGroup = Readonly<{
  matcher?: string;
  hooks: readonly HookCommand[];
}>;

export type LoadedHooks = Readonly<{
  events: Readonly<Record<SupportedHookEvent, readonly HookMatcherGroup[]>>;
  unsupported: readonly string[];
  warnings: readonly string[];
  sources: readonly string[];
}>;

export type CommandHookResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

export type HookRunSummary = Readonly<{
  event: SupportedHookEvent;
  command: string;
  exitCode: number;
  timedOut: boolean;
  blocked?: boolean;
  reason?: string;
  additionalContext?: string;
}>;

export type LoadHooksOptions = Readonly<{
  cwd: string;
  home?: string;
  config: HooksConfig;
  /** When false, skip project `.claude/settings*.json` (user global still loads). */
  includeProject?: boolean;
  warn?: (message: string) => void;
}>;

export type RegisterHooksBridgeOptions = Readonly<{
  cwd: string;
  home?: string;
  config: HooksConfig;
  /** When false, skip project hook settings. */
  includeProject?: boolean;
  warn?: (message: string) => void;
  /** Injectable runner for tests. */
  runCommand?: typeof runCommandHook;
}>;

export type HooksBridgeRegistration = Readonly<{
  getLoaded: () => LoadedHooks | undefined;
  getSessionContext: () => string;
  getLastRuns: () => readonly HookRunSummary[];
}>;

const EMPTY_EVENTS: Record<SupportedHookEvent, readonly HookMatcherGroup[]> = {
  SessionStart: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

const EXACT_MATCHER = /^[A-Za-z0-9_|]+$/;

/**
 * Load Claude-style settings.json hooks from user + project paths.
 * Later files override earlier ones per event key (project overrides user).
 */
export async function loadHooks(options: LoadHooksOptions): Promise<LoadedHooks> {
  const config = options.config;
  if (!config.enabled || !config.readClaude) {
    return { events: { ...EMPTY_EVENTS }, unsupported: [], warnings: [], sources: [] };
  }

  const home = options.home ?? homedir();
  const cwd = path.resolve(options.cwd);
  const warn = options.warn ?? (() => undefined);
  const warnings: string[] = [];
  const unsupported = new Set<string>();
  const sources: string[] = [];
  const events: Record<SupportedHookEvent, HookMatcherGroup[]> = {
    SessionStart: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };

  const candidates = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
  ];
  if (options.includeProject !== false) {
    candidates.push(
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
    );
  }

  for (const filePath of candidates) {
    const parsed = await readSettingsHooks(filePath, warn);
    if (!parsed) {
      continue;
    }
    sources.push(filePath);
    for (const name of parsed.unsupported) {
      unsupported.add(name);
      const message = `hooks: unsupported event "${name}" in ${filePath} (ignored)`;
      warnings.push(message);
      warn(message);
    }
    for (const event of SUPPORTED_HOOK_EVENTS) {
      const groups = parsed.events[event];
      if (groups !== undefined) {
        // Project/local override: replace that event's groups from this file.
        events[event] = [...groups];
      }
    }
  }

  return {
    events,
    unsupported: [...unsupported].sort(),
    warnings,
    sources,
  };
}

/**
 * Register ExtensionHost handlers that bridge Claude hooks → Xio events.
 */
export function registerHooksBridge(
  ctx: ExtensionContext,
  options: RegisterHooksBridgeOptions,
): HooksBridgeRegistration {
  const config = options.config;
  const warn = options.warn ?? (() => undefined);
  const runCommand = options.runCommand ?? runCommandHook;
  let loaded: LoadedHooks | undefined;
  let sessionContext = "";
  const lastRuns: HookRunSummary[] = [];

  const record = (run: HookRunSummary): void => {
    lastRuns.push(run);
  };

  ctx.on?.("session_start", async (payload) => {
    lastRuns.length = 0;
    sessionContext = "";

    if (!config.enabled) {
      loaded = { events: { ...EMPTY_EVENTS }, unsupported: [], warnings: [], sources: [] };
      return { hooks: { enabled: false } };
    }

    loaded = await loadHooks({
      cwd: options.cwd,
      home: options.home,
      config,
      includeProject: options.includeProject,
      warn,
    });

    const source = typeof asRecord(payload).source === "string"
      ? String(asRecord(payload).source)
      : "startup";

    const contexts: string[] = [];
    for (const group of loaded.events.SessionStart) {
      if (!matcherMatches(group.matcher, source)) {
        continue;
      }
      for (const hook of group.hooks) {
        const stdin = {
          hook_event_name: "SessionStart",
          cwd: options.cwd,
          source,
        };
        const result = await runCommand({
          command: hook.command,
          cwd: options.cwd,
          stdin,
          timeoutMs: hook.timeoutMs ?? config.timeoutMs,
        });
        const parsed = interpretHookOutput("SessionStart", result);
        record({
          event: "SessionStart",
          command: hook.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          additionalContext: parsed.additionalContext,
        });
        if (result.timedOut) {
          warn(`hooks: SessionStart timed out: ${hook.command}`);
          continue;
        }
        if (parsed.additionalContext) {
          contexts.push(parsed.additionalContext);
        }
      }
    }

    sessionContext = contexts.filter((part) => part.length > 0).join("\n\n");
    return {
      hooks: {
        enabled: true,
        sources: loaded.sources,
        unsupported: loaded.unsupported,
        warnings: loaded.warnings,
        session_context_bytes: Buffer.byteLength(sessionContext, "utf8"),
        runs: lastRuns.filter((run) => run.event === "SessionStart"),
      },
    };
  });

  ctx.on?.("before_agent_start", async (payload, eventCtx) => {
    if (!config.enabled || sessionContext.length === 0) {
      return undefined;
    }
    const addendum = formatHooksSessionAddendum(sessionContext);
    const event = asRecord(payload);
    const base =
      eventCtx?.getSystemPrompt?.()
      ?? (typeof event.systemPrompt === "string" ? event.systemPrompt : "");
    const systemPrompt = [base, addendum].filter((part) => part.length > 0).join("\n\n");
    return { systemPrompt };
  });

  ctx.on?.("tool_call", async (payload) => {
    if (!config.enabled) {
      return undefined;
    }
    if (!loaded) {
      loaded = await loadHooks({
        cwd: options.cwd,
        home: options.home,
        config,
        includeProject: options.includeProject,
        warn,
      });
    }

    const event = asRecord(payload);
    const call = asRecord(event.call);
    const toolName = typeof event.toolName === "string"
      ? event.toolName
      : typeof call.name === "string"
        ? call.name
        : "";
    const toolInput = (event.input && typeof event.input === "object" && !Array.isArray(event.input)
      ? event.input
      : call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? call.args
        : {}) as Record<string, unknown>;

    for (const group of loaded.events.PreToolUse) {
      if (!matcherMatches(group.matcher, toolName)) {
        continue;
      }
      for (const hook of group.hooks) {
        const result = await runCommand({
          command: hook.command,
          cwd: options.cwd,
          stdin: {
            hook_event_name: "PreToolUse",
            cwd: options.cwd,
            tool_name: toolName,
            tool_input: toolInput,
          },
          timeoutMs: hook.timeoutMs ?? config.timeoutMs,
        });
        const parsed = interpretHookOutput("PreToolUse", result);
        record({
          event: "PreToolUse",
          command: hook.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          blocked: parsed.block === true,
          reason: parsed.reason,
        });
        if (result.timedOut) {
          warn(`hooks: PreToolUse timed out (continue): ${hook.command}`);
          continue;
        }
        if (parsed.block) {
          return {
            block: true,
            reason: parsed.reason ?? `blocked ${toolName}`,
            hooks: { event: "PreToolUse", command: hook.command, exitCode: result.exitCode },
          };
        }
      }
    }
    return undefined;
  });

  ctx.on?.("tool_result", async (payload) => {
    if (!config.enabled) {
      return undefined;
    }
    if (!loaded) {
      loaded = await loadHooks({
        cwd: options.cwd,
        home: options.home,
        config,
        includeProject: options.includeProject,
        warn,
      });
    }

    const event = asRecord(payload);
    const call = asRecord(event.call);
    const toolName = typeof call.name === "string" ? call.name : "";
    const toolInput = (call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? call.args
      : {}) as Record<string, unknown>;
    const toolResult = asRecord(event.result);

    for (const group of loaded.events.PostToolUse) {
      if (!matcherMatches(group.matcher, toolName)) {
        continue;
      }
      for (const hook of group.hooks) {
        const result = await runCommand({
          command: hook.command,
          cwd: options.cwd,
          stdin: {
            hook_event_name: "PostToolUse",
            cwd: options.cwd,
            tool_name: toolName,
            tool_input: toolInput,
            tool_response: toolResult,
          },
          timeoutMs: hook.timeoutMs ?? config.timeoutMs,
        });
        record({
          event: "PostToolUse",
          command: hook.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        });
        if (result.timedOut) {
          warn(`hooks: PostToolUse timed out (continue): ${hook.command}`);
        } else if (result.exitCode !== 0 && result.exitCode !== 2) {
          warn(`hooks: PostToolUse non-blocking error exit=${result.exitCode}: ${hook.command}`);
        }
      }
    }
    return undefined;
  });

  const runStop = async (xioEvent: string): Promise<Record<string, unknown> | undefined> => {
    if (!config.enabled) {
      return undefined;
    }
    if (!loaded) {
      loaded = await loadHooks({
        cwd: options.cwd,
        home: options.home,
        config,
        includeProject: options.includeProject,
        warn,
      });
    }

    const runs: HookRunSummary[] = [];
    for (const group of loaded.events.Stop) {
      // Stop has no matcher support in Claude; ignore matcher if present.
      for (const hook of group.hooks) {
        const result = await runCommand({
          command: hook.command,
          cwd: options.cwd,
          stdin: {
            hook_event_name: "Stop",
            cwd: options.cwd,
            xio_event: xioEvent,
          },
          timeoutMs: hook.timeoutMs ?? config.timeoutMs,
        });
        const summary: HookRunSummary = {
          event: "Stop",
          command: hook.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        };
        record(summary);
        runs.push(summary);
        if (result.timedOut) {
          warn(`hooks: Stop timed out (continue): ${hook.command}`);
        }
      }
    }
    return runs.length > 0 ? { hooks: { event: "Stop", xio_event: xioEvent, runs } } : undefined;
  };

  ctx.on?.("agent_end", async () => runStop("agent_end"));
  ctx.on?.("session_end", async () => runStop("session_end"));

  return {
    getLoaded: () => loaded,
    getSessionContext: () => sessionContext,
    getLastRuns: () => [...lastRuns],
  };
}

export function formatHooksSessionAddendum(context: string): string {
  const trimmed = context.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return `<!-- xio-hooks:session-start -->\n${trimmed}`;
}

export async function runCommandHook(options: Readonly<{
  command: string;
  cwd: string;
  stdin: unknown;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<CommandHookResult> {
  const timeoutMs = Math.max(1, options.timeoutMs);
  const payload = `${JSON.stringify(options.stdin)}\n`;

  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", options.command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const escalate = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      escalate.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      finish(code ?? (timedOut ? 124 : 1));
    });
    child.on("error", (error) => {
      stderr = stderr.length > 0 ? stderr : error.message;
      finish(1);
    });

    child.stdin.write(payload, (error) => {
      if (error) {
        stderr = stderr.length > 0 ? stderr : error.message;
      }
      child.stdin.end();
    });
  });
}

export function matcherMatches(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined || matcher.trim() === "" || matcher.trim() === "*") {
    return true;
  }
  const pattern = matcher.trim();
  if (EXACT_MATCHER.test(pattern)) {
    const alternatives = pattern.split("|").map((part) => part.trim()).filter((part) => part.length > 0);
    return alternatives.includes(value);
  }
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

export function interpretHookOutput(
  event: SupportedHookEvent,
  result: CommandHookResult,
): Readonly<{
  block?: boolean;
  reason?: string;
  additionalContext?: string;
}> {
  if (result.timedOut) {
    return {};
  }

  if (event === "PreToolUse" && result.exitCode === 2) {
    return {
      block: true,
      reason: result.stderr.trim() || "PreToolUse blocked (exit 2)",
    };
  }

  if (result.exitCode !== 0) {
    return {};
  }

  const json = tryParseJson(result.stdout);
  if (json) {
    const hookSpecific = asRecord(json.hookSpecificOutput);
    const additionalContext =
      typeof hookSpecific.additionalContext === "string"
        ? hookSpecific.additionalContext
        : typeof json.additionalContext === "string"
          ? json.additionalContext
          : undefined;

    if (event === "PreToolUse") {
      const decision = typeof hookSpecific.permissionDecision === "string"
        ? hookSpecific.permissionDecision
        : typeof json.decision === "string"
          ? json.decision
          : undefined;
      if (decision === "deny" || decision === "block") {
        const reason =
          (typeof hookSpecific.permissionDecisionReason === "string"
            ? hookSpecific.permissionDecisionReason
            : undefined)
          ?? (typeof json.reason === "string" ? json.reason : undefined)
          ?? "PreToolUse denied";
        return { block: true, reason, additionalContext };
      }
    }

    if (additionalContext) {
      return { additionalContext };
    }
  }

  // SessionStart: plain stdout (non-JSON) is added as context (Claude-compatible subset).
  if (event === "SessionStart") {
    const plain = result.stdout.trim();
    if (plain.length > 0 && !tryParseJson(result.stdout)) {
      return { additionalContext: plain };
    }
  }

  return {};
}

async function readSettingsHooks(
  filePath: string,
  warn: (message: string) => void,
): Promise<{
  events: Partial<Record<SupportedHookEvent, readonly HookMatcherGroup[]>>;
  unsupported: readonly string[];
} | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    warn(`hooks: failed to read ${filePath}: ${errorMessage(error)}`);
    return undefined;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    warn(`hooks: invalid JSON in ${filePath}: ${errorMessage(error)}`);
    return undefined;
  }

  const root = asRecord(data);
  const hooksTable = root.hooks;
  if (hooksTable === undefined) {
    return { events: {}, unsupported: [] };
  }
  if (!hooksTable || typeof hooksTable !== "object" || Array.isArray(hooksTable)) {
    warn(`hooks: "hooks" must be an object in ${filePath}`);
    return undefined;
  }

  const events: Partial<Record<SupportedHookEvent, HookMatcherGroup[]>> = {};
  const unsupported: string[] = [];
  const supported = new Set<string>(SUPPORTED_HOOK_EVENTS);

  for (const [eventName, value] of Object.entries(hooksTable as Record<string, unknown>)) {
    if (!supported.has(eventName)) {
      unsupported.push(eventName);
      continue;
    }
    if (!Array.isArray(value)) {
      warn(`hooks: ${eventName} must be an array in ${filePath}`);
      continue;
    }
    const groups: HookMatcherGroup[] = [];
    for (const [index, item] of value.entries()) {
      const group = parseMatcherGroup(item, `${filePath}:${eventName}[${index}]`, warn);
      if (group) {
        groups.push(group);
      }
    }
    events[eventName as SupportedHookEvent] = groups;
  }

  return { events, unsupported };
}

function parseMatcherGroup(
  value: unknown,
  context: string,
  warn: (message: string) => void,
): HookMatcherGroup | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0 && (value === null || typeof value !== "object")) {
    warn(`hooks: invalid matcher group at ${context}`);
    return undefined;
  }
  const matcher = typeof record.matcher === "string" ? record.matcher : undefined;
  const hooksRaw = record.hooks;
  if (!Array.isArray(hooksRaw)) {
    warn(`hooks: missing hooks array at ${context}`);
    return undefined;
  }
  const hooks: HookCommand[] = [];
  for (const [index, item] of hooksRaw.entries()) {
    const hook = asRecord(item);
    const type = typeof hook.type === "string" ? hook.type : "command";
    if (type !== "command") {
      warn(`hooks: unsupported handler type "${type}" at ${context}.hooks[` + String(index) + "] (ignored)");
      continue;
    }
    const command = typeof hook.command === "string" ? hook.command.trim() : "";
    if (command.length === 0) {
      warn(`hooks: empty command at ${context}.hooks[` + String(index) + "]");
      continue;
    }
    // Claude settings use `timeout` in seconds; Xio also accepts `timeoutMs`.
    const timeoutMs = typeof hook.timeoutMs === "number"
      ? hook.timeoutMs
      : typeof hook.timeout === "number"
        ? Math.max(1, Math.round(hook.timeout * 1_000))
        : undefined;
    hooks.push({
      type: "command",
      command,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  return { matcher, hooks };
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
