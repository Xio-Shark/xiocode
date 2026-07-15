import type { ExtensionHost } from "../extension-host.ts";
import type { XioRuntimeConfig } from "../../cli/config-parser.ts";

import {
  createExploreTool,
  EXPLORE_TOOL_NAME,
  formatPrimaryExploreAddendum,
  stripMultiExploreAddendum,
} from "./explore-tool.ts";
import {
  detectUserExploreFanoutRequest,
  resolveExploreConcurrencyBudget,
} from "./policy.ts";
import { exploreFallbackModelRef, resolveExploreConfig } from "./resolve.ts";
import { estimateExploreScale, type ExploreScaleEstimate } from "./scale.ts";
import { withModelId } from "./subagent.ts";

import type { ResolvedExploreConfig } from "./types.ts";

/** Race scale probe against a tight budget so session start stays interactive. */
async function estimateExploreScaleBounded(
  root: string,
  budgetMs: number,
): Promise<ExploreScaleEstimate | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      estimateExploreScale(root),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type RegisterExploreOptions = Readonly<{
  runtimeConfig: XioRuntimeConfig;
  cwd: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  onNotify?: (message: string) => void;
  onStatus?: (key: string, text: string | undefined) => void;
}>;

export type ExploreCapabilityHandle = Readonly<{
  /** True after the explore tool is registered. */
  isRegistered: () => boolean;
  /**
   * Ensure explore is installed. `ultra` force-enables even when config is off.
   * Idempotent. Returns resolved config or undefined when no model identity exists.
   */
  ensure: (reason: "config" | "ultra") => Promise<ResolvedExploreConfig | undefined>;
  getResolved: () => ResolvedExploreConfig | undefined;
}>;

/**
 * Register multi-explore capability.
 * - `[explore] enabled = true` → install at session start
 * - thinking=`ultra` → auto force-enable (even if config disabled), using explore.model
 *   or the session primary model as worker model
 */
export async function registerExploreCapability(
  host: ExtensionHost,
  options: RegisterExploreOptions,
): Promise<ExploreCapabilityHandle> {
  let registered = false;
  let resolved: ResolvedExploreConfig | undefined;
  let lastUserPrompt = "";
  let scale: ExploreScaleEstimate | undefined;
  let scaleNote: string | undefined;
  let scaleProbed = false;

  const probeScale = async (): Promise<void> => {
    if (scaleProbed) return;
    scaleProbed = true;
    try {
      scale = await estimateExploreScaleBounded(options.workspaceRoot, 50);
      if (scale) {
        scaleNote = `${scale.tier} (~${scale.fileCount}${scale.capped ? "+" : ""} source-like files)`;
      } else {
        scaleNote = "default band (scale probe skipped for fast start)";
      }
    } catch {
      scaleNote = "unknown (scale probe failed; use small fan-out)";
    }
  };

  const fallbackModel = (): string | undefined => {
    const session = host.model;
    return exploreFallbackModelRef({
      exploreModel: options.runtimeConfig.explore.model,
      sessionProvider: session?.provider,
      sessionModel: session?.id,
      defaultProvider: options.runtimeConfig.general.defaultProvider,
      defaultModel: options.runtimeConfig.general.defaultModel,
    });
  };

  const tryResolve = (forceEnable: boolean): ResolvedExploreConfig | undefined =>
    resolveExploreConfig(
      options.runtimeConfig.explore,
      options.runtimeConfig.general,
      {
        forceEnable,
        fallbackModel: fallbackModel(),
      },
    );

  const install = async (reason: "config" | "ultra"): Promise<ResolvedExploreConfig | undefined> => {
    if (registered && resolved) {
      return resolved;
    }

    const next = tryResolve(reason === "ultra" || options.runtimeConfig.explore.enabled);
    if (!next) {
      if (reason === "ultra") {
        options.onNotify?.(
          "ultra multi-explore unavailable: set [explore].model or general.default_model / connect a provider model",
        );
      }
      return undefined;
    }

    await probeScale();
    ensureExploreModelRegistered(host, next);

    if (!registered) {
      host.registerTool(createExploreTool({
        config: next,
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        getProvider: (name) => host.getProvider(name),
        env: options.env,
        onNotify: options.onNotify,
        onStatus: options.onStatus,
        getThinkingLevel: () => host.getThinkingLevel(),
        getUserPrompt: () => lastUserPrompt,
      }));

      host.on("before_agent_start", (payload, ctx) => {
        if (!resolved) return undefined;
        const record = payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : undefined;
        if (typeof record?.prompt === "string") {
          lastUserPrompt = record.prompt;
        }

        const userRequest = detectUserExploreFanoutRequest(lastUserPrompt);
        const budget = resolveExploreConcurrencyBudget({
          thinkingLevel: host.getThinkingLevel(),
          configMax: resolved.maxConcurrency,
          userRequest,
          scale,
          signal: {
            userText: lastUserPrompt,
            exploreRequested: userRequest.highFanout || /\bexplore\b/i.test(lastUserPrompt),
          },
        });

        const base = stripMultiExploreAddendum(ctx?.getSystemPrompt?.() ?? "");
        const exploreAddendum = formatPrimaryExploreAddendum({
          maxConcurrency: resolved.maxConcurrency,
          suggestedConcurrency: budget.suggested,
          effectiveMax: budget.effectiveMax,
          mode: budget.mode,
          lane: budget.lane,
          scaleNote,
          partitionHint: resolved.partitionHint,
          thinkingLevel: host.getThinkingLevel(),
        });
        const prompt = base.length > 0
          ? `${base}\n\n${exploreAddendum}`
          : exploreAddendum;
        return { systemPrompt: prompt };
      });
      registered = true;
    }

    resolved = next;
    const initialBudget = resolveExploreConcurrencyBudget({
      thinkingLevel: host.getThinkingLevel(),
      configMax: resolved.maxConcurrency,
      userRequest: { highFanout: false },
      scale,
    });
    const auto = reason === "ultra" && !options.runtimeConfig.explore.enabled;
    options.onNotify?.(
      (auto ? "ultra auto-enabled multi-explore: " : "subagent explore ready: ")
        + `${resolved.provider}/${resolved.model} `
        + `(lane=${initialBudget.lane ?? "standard"} cap≤${initialBudget.effectiveMax}; `
        + `deep ceiling ≤${Math.max(8, initialBudget.suggested)}; `
        + `user-high ≤${resolved.maxConcurrency}; `
        + `${scaleNote ? `${scaleNote}, ` : ""}${resolved.maxTurns} turns`
        + `${resolved.partitionHint ? `, partition: ${resolved.partitionHint}` : ""})`
        + (auto
          ? " — primary MUST call `explore` for repo work (see UI: ⊹ subagent / subs:N)"
          : " — primary must call `explore` for workers to appear in the UI"),
    );
    return resolved;
  };

  // Config opt-in, or session already on ultra (default_thinking_level / resume).
  if (options.runtimeConfig.explore.enabled || host.getThinkingLevel() === "ultra") {
    await install(options.runtimeConfig.explore.enabled ? "config" : "ultra");
  }

  return {
    isRegistered: () => registered,
    ensure: install,
    getResolved: () => resolved,
  };
}

function ensureExploreModelRegistered(
  host: ExtensionHost,
  resolved: ResolvedExploreConfig,
): void {
  const existing = host.getProvider(resolved.provider);
  if (!existing) {
    return;
  }
  if (existing.models.some((model) => model.id === resolved.model)) {
    return;
  }
  host.registerProvider(resolved.provider, withModelId(existing, resolved.model));
}

export { EXPLORE_TOOL_NAME, resolveExploreConfig };
