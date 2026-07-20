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
import {
  discoveryCacheKey,
  processDiscoveryCache,
} from "./discovery-cache.ts";

import type { ExtensionContext } from "../../xio-evolve/src/types.ts";
import type { ToolDefinition } from "../../../src/runtime/types.ts";

export type XioHygieneOptions = Readonly<{
  cwd: string;
  home?: string;
  agentsMd?: Partial<AgentsMdConfig>;
  skills?: Partial<SkillsConfig>;
  hooks?: Partial<HooksConfig>;
  mcp?: Partial<McpConfig>;
  /**
   * When false, skip project-local AGENTS/skills/hooks/MCP (user global still loads).
   * Used by the project trust gate for untrusted workspaces.
   */
  includeProject?: boolean;
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
  const includeProject = options.includeProject !== false;

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
      includeProject,
      warn: options.warn,
    })
    : undefined;

  const mcpBridge = mcpConfig.enabled && options.registerTool
    ? registerMcpBridge(ctx, {
      cwd: options.cwd,
      home: options.home,
      config: mcpConfig,
      includeProject,
      registerTool: options.registerTool,
      warn: options.warn,
    })
    : undefined;

  ctx.on?.("session_start", async () => {
    // AGENTS and skills are independent — load in parallel with process cache.
    const [agentsOutcome, skillsOutcome] = await Promise.all([
      loadAgentsWithCache({
        enabled: agentsConfig.enabled,
        cwd: options.cwd,
        home: options.home,
        config: agentsConfig,
        includeProject,
        warn: options.warn,
      }),
      loadSkillsWithCache({
        enabled: skillsConfig.enabled,
        cwd: options.cwd,
        home: options.home,
        config: skillsConfig,
        includeProject,
        warn: options.warn,
      }),
    ]);
    bundle = agentsOutcome.bundle;
    skillsIndex = skillsOutcome.index;

    return {
      agents_md: agentsOutcome.result,
      skills: skillsOutcome.result,
    };
  });

  ctx.on?.("before_agent_start", async (payload, eventCtx) => {
    const parts: string[] = [];

    if (agentsConfig.enabled) {
      if (!bundle) {
        const loaded = await loadAgentsWithCache({
          enabled: true,
          cwd: options.cwd,
          home: options.home,
          config: agentsConfig,
          includeProject,
          warn: options.warn,
        });
        bundle = loaded.bundle;
      }
      const agentsAddendum = formatAgentsMdAddendum(bundle);
      if (agentsAddendum.length > 0) {
        parts.push(agentsAddendum);
      }
    }

    if (skillsConfig.enabled) {
      if (!skillsIndex) {
        const loaded = await loadSkillsWithCache({
          enabled: true,
          cwd: options.cwd,
          home: options.home,
          config: skillsConfig,
          includeProject,
          warn: options.warn,
        });
        skillsIndex = loaded.index;
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

async function loadAgentsWithCache(input: Readonly<{
  enabled: boolean;
  cwd: string;
  home?: string;
  config: AgentsMdConfig;
  includeProject?: boolean;
  warn?: (message: string) => void;
}>): Promise<Readonly<{
  bundle: SpecBundle;
  result: Record<string, unknown>;
}>> {
  if (!input.enabled) {
    return {
      bundle: { text: "", sources: [], warnings: [] },
      result: { enabled: false, sources: [] },
    };
  }
  const includeProject = input.includeProject !== false;
  const key = discoveryCacheKey("agents", input.cwd, input.home, {
    ...input.config,
    includeProject,
  });
  let bundle = processDiscoveryCache.getAgents(key);
  const fromCache = bundle !== undefined;
  if (!bundle) {
    bundle = await loadAgentsMd({
      cwd: input.cwd,
      home: input.home,
      config: input.config,
      includeProject,
      warn: input.warn,
    });
    processDiscoveryCache.setAgents(key, bundle);
  }
  return {
    bundle,
    result: {
      enabled: true,
      sources: bundle.sources.map((source) => ({
        path: source.path,
        hash: source.hash,
        truncated: source.truncated,
        bytes: source.bytes,
      })),
      warnings: bundle.warnings,
      cache: fromCache ? "hit" : "miss",
      includeProject,
    },
  };
}

async function loadSkillsWithCache(input: Readonly<{
  enabled: boolean;
  cwd: string;
  home?: string;
  config: SkillsConfig;
  includeProject?: boolean;
  warn?: (message: string) => void;
}>): Promise<Readonly<{
  index: SkillsIndex;
  result: Record<string, unknown>;
}>> {
  if (!input.enabled) {
    return {
      index: { skills: [], warnings: [] },
      result: { enabled: false, count: 0 },
    };
  }
  const includeProject = input.includeProject !== false;
  const key = discoveryCacheKey("skills", input.cwd, input.home, {
    ...input.config,
    includeProject,
  });
  let index = processDiscoveryCache.getSkills(key);
  const fromCache = index !== undefined;
  if (!index) {
    index = await discoverSkills({
      cwd: input.cwd,
      home: input.home,
      config: input.config,
      includeProject,
      warn: input.warn,
    });
    processDiscoveryCache.setSkills(key, index);
  }
  return {
    index,
    result: {
      enabled: true,
      count: index.skills.length,
      names: index.skills.map((skill) => skill.name),
      warnings: index.warnings,
      cache: fromCache ? "hit" : "miss",
      includeProject,
    },
  };
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

export { processDiscoveryCache, discoveryCacheKey, DiscoveryCache } from "./discovery-cache.ts";

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
