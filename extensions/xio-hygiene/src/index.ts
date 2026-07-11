import {
  DEFAULT_AGENTS_MD_CONFIG,
  formatAgentsMdAddendum,
  loadAgentsMd,
  type AgentsMdConfig,
  type SpecBundle,
} from "./agents-md.ts";
import {
  DEFAULT_HOOKS_CONFIG,
  formatHooksSessionAddendum,
  interpretHookOutput,
  loadHooks,
  matcherMatches,
  registerHooksBridge,
  runCommandHook,
  type HooksBridgeRegistration,
  type HooksConfig,
} from "./hooks.ts";
import {
  DEFAULT_MCP_CONFIG,
  loadMcpConfigs,
  mcpToolName,
  parseServerSpec,
  registerMcpBridge,
  sanitizeMcpSegment,
  type McpBridgeRegistration,
  type McpConfig,
} from "./mcp.ts";
import {
  DEFAULT_SKILLS_CONFIG,
  createSkillTool,
  discoverSkills,
  formatSkillsCatalog,
  type SkillsConfig,
  type SkillsIndex,
} from "./skills.ts";

import type { ExtensionContext } from "../../xio-evolve/src/types.ts";
import type { ToolDefinition } from "../../../src/runtime/types.ts";

export type XioHygieneOptions = Readonly<{
  cwd: string;
  home?: string;
  agentsMd?: Partial<AgentsMdConfig>;
  skills?: Partial<SkillsConfig>;
  hooks?: Partial<HooksConfig>;
  mcp?: Partial<McpConfig>;
  /** Register extension tools (e.g. `skill`, `mcp__*`). */
  registerTool?: (tool: ToolDefinition) => void;
  warn?: (message: string) => void;
}>;

export type XioHygieneRegistration = Readonly<{
  getBundle: () => SpecBundle | undefined;
  getSkillsIndex: () => SkillsIndex | undefined;
  getHooks: () => HooksBridgeRegistration | undefined;
  getMcp: () => McpBridgeRegistration | undefined;
}>;

/**
 * Agent hygiene extension: AGENTS.md / CLAUDE.md + skills + user hooks + MCP client.
 */
export function registerXioHygiene(ctx: ExtensionContext, options: XioHygieneOptions): XioHygieneRegistration {
  const agentsConfig: AgentsMdConfig = {
    ...DEFAULT_AGENTS_MD_CONFIG,
    ...options.agentsMd,
  };
  const skillsConfig: SkillsConfig = {
    ...DEFAULT_SKILLS_CONFIG,
    ...options.skills,
  };
  const hooksConfig: HooksConfig = {
    ...DEFAULT_HOOKS_CONFIG,
    ...options.hooks,
  };
  const mcpConfig: McpConfig = {
    ...DEFAULT_MCP_CONFIG,
    ...options.mcp,
  };

  let bundle: SpecBundle | undefined;
  let skillsIndex: SkillsIndex | undefined;

  if (skillsConfig.enabled && options.registerTool) {
    options.registerTool(createSkillTool(() => skillsIndex));
  }

  const hooksBridge = hooksConfig.enabled
    ? registerHooksBridge(ctx, {
      cwd: options.cwd,
      home: options.home,
      config: hooksConfig,
      warn: options.warn,
    })
    : undefined;

  const mcpBridge = mcpConfig.enabled && options.registerTool
    ? registerMcpBridge(ctx, {
      cwd: options.cwd,
      home: options.home,
      config: mcpConfig,
      registerTool: options.registerTool,
      warn: options.warn,
    })
    : undefined;

  ctx.on?.("session_start", async () => {
    const result: Record<string, unknown> = {};

    if (!agentsConfig.enabled) {
      bundle = { text: "", sources: [], warnings: [] };
      result.agents_md = { enabled: false, sources: [] };
    } else {
      bundle = await loadAgentsMd({
        cwd: options.cwd,
        home: options.home,
        config: agentsConfig,
        warn: options.warn,
      });
      result.agents_md = {
        enabled: true,
        sources: bundle.sources.map((source) => ({
          path: source.path,
          hash: source.hash,
          truncated: source.truncated,
          bytes: source.bytes,
        })),
        warnings: bundle.warnings,
      };
    }

    if (!skillsConfig.enabled) {
      skillsIndex = { skills: [], warnings: [] };
      result.skills = { enabled: false, count: 0 };
    } else {
      skillsIndex = await discoverSkills({
        cwd: options.cwd,
        home: options.home,
        config: skillsConfig,
        warn: options.warn,
      });
      result.skills = {
        enabled: true,
        count: skillsIndex.skills.length,
        names: skillsIndex.skills.map((skill) => skill.name),
        warnings: skillsIndex.warnings,
      };
    }

    return result;
  });

  ctx.on?.("before_agent_start", async (payload, eventCtx) => {
    const parts: string[] = [];

    if (agentsConfig.enabled) {
      if (!bundle) {
        bundle = await loadAgentsMd({
          cwd: options.cwd,
          home: options.home,
          config: agentsConfig,
          warn: options.warn,
        });
      }
      const agentsAddendum = formatAgentsMdAddendum(bundle);
      if (agentsAddendum.length > 0) {
        parts.push(agentsAddendum);
      }
    }

    if (skillsConfig.enabled) {
      if (!skillsIndex) {
        skillsIndex = await discoverSkills({
          cwd: options.cwd,
          home: options.home,
          config: skillsConfig,
          warn: options.warn,
        });
      }
      const catalog = formatSkillsCatalog(skillsIndex);
      if (catalog.length > 0) {
        parts.push(catalog);
      }
    }

    // SessionStart hook context is injected by registerHooksBridge's own
    // before_agent_start handler (progressive emit on ExtensionHost).

    if (parts.length === 0) {
      return undefined;
    }

    const event = asRecord(payload);
    const base =
      eventCtx?.getSystemPrompt?.()
      ?? (typeof event.systemPrompt === "string" ? event.systemPrompt : "");
    const systemPrompt = [base, ...parts].filter((part) => part.length > 0).join("\n\n");
    return { systemPrompt };
  });

  return {
    getBundle: () => bundle,
    getSkillsIndex: () => skillsIndex,
    getHooks: () => hooksBridge,
    getMcp: () => mcpBridge,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export {
  DEFAULT_AGENTS_MD_CONFIG,
  loadAgentsMd,
  formatAgentsMdAddendum,
};
export type { AgentsMdConfig, SpecBundle, SpecSource } from "./agents-md.ts";

export {
  DEFAULT_SKILLS_CONFIG,
  discoverSkills,
  formatSkillsCatalog,
  createSkillTool,
};
export type { SkillsConfig, SkillsIndex, SkillEntry } from "./skills.ts";

export {
  DEFAULT_HOOKS_CONFIG,
  loadHooks,
  registerHooksBridge,
  formatHooksSessionAddendum,
  runCommandHook,
  matcherMatches,
  interpretHookOutput,
};
export type {
  HooksConfig,
  LoadedHooks,
  HookCommand,
  HookMatcherGroup,
  HookRunSummary,
  HooksBridgeRegistration,
} from "./hooks.ts";

export {
  DEFAULT_MCP_CONFIG,
  loadMcpConfigs,
  registerMcpBridge,
  mcpToolName,
  sanitizeMcpSegment,
  parseServerSpec,
};
export type {
  McpConfig,
  McpServerSpec,
  McpBridgeRegistration,
  LoadedMcpConfigs,
  McpConnectionStatus,
} from "./mcp.ts";
