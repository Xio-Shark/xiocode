import type { ExtensionHost } from "../extension-host.ts";
import type { XioRuntimeConfig } from "../../cli/config-parser.ts";

import {
  createExploreTool,
  EXPLORE_TOOL_NAME,
  formatPrimaryExploreAddendum,
} from "./explore-tool.ts";
import { resolveExploreConfig } from "./resolve.ts";
import { estimateExploreScale, suggestExploreConcurrency, type ExploreScaleEstimate } from "./scale.ts";
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
}>;

/**
 * Register the `explore` tool + primary-agent prompt addendum when [explore] is enabled.
 * Returns the resolved config, or undefined when disabled.
 */
export async function registerExploreCapability(
  host: ExtensionHost,
  options: RegisterExploreOptions,
): Promise<ResolvedExploreConfig | undefined> {
  const resolved = resolveExploreConfig(
    options.runtimeConfig.explore,
    options.runtimeConfig.general,
  );
  if (!resolved) {
    return undefined;
  }

  ensureExploreModelRegistered(host, resolved);

  host.registerTool(createExploreTool({
    config: resolved,
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    getProvider: (name) => host.getProvider(name),
    env: options.env,
    onNotify: options.onNotify,
  }));

  // Keep startup snappy: budget ~50ms for scale probe; fall back to default-4 band.
  let suggestedConcurrency = Math.min(4, resolved.maxConcurrency);
  let scaleNote: string | undefined;
  try {
    const scale = await estimateExploreScaleBounded(options.workspaceRoot, 50);
    if (scale) {
      suggestedConcurrency = suggestExploreConcurrency(scale, resolved.maxConcurrency);
      scaleNote = `${scale.tier} (~${scale.fileCount}${scale.capped ? "+" : ""} source-like files)`;
    } else {
      scaleNote = "default band (scale probe skipped for fast start)";
    }
  } catch {
    scaleNote = "unknown (scale probe failed; use small fan-out)";
  }

  const exploreAddendum = formatPrimaryExploreAddendum({
    maxConcurrency: resolved.maxConcurrency,
    suggestedConcurrency,
    scaleNote,
    partitionHint: resolved.partitionHint,
  });

  host.on("before_agent_start", (_payload, ctx) => {
    const base = ctx?.getSystemPrompt?.() ?? "";
    if (base.includes("## Multi-explore")) {
      return undefined;
    }
    const next = base.length > 0
      ? `${base}\n\n${exploreAddendum}`
      : exploreAddendum;
    return { systemPrompt: next };
  });

  options.onNotify?.(
    `explore enabled: ${resolved.provider}/${resolved.model} `
      + `(suggest ${suggestedConcurrency}/${resolved.maxConcurrency} parallel`
      + `${scaleNote ? `, ${scaleNote}` : ""}, ${resolved.maxTurns} turns`
      + `${resolved.partitionHint ? `, partition: ${resolved.partitionHint}` : ""})`,
  );
  return resolved;
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
