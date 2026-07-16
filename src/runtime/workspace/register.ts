import type { ExtensionHost } from "../extension-host.ts";
import {
  createPerceptionTools,
  PERCEPTION_PROMPT_ADDENDUM,
} from "./perception-tools.ts";
import type { WorkspacePerceptionService } from "./service.ts";

export type RegisterPerceptionOptions = Readonly<{
  service: WorkspacePerceptionService;
  /** When false, skip system-prompt addendum (e.g. explore workers already have a fixed prompt). Default true. */
  injectPrompt?: boolean;
}>;

/**
 * Register product-facing workspace perception tools on a host.
 * Main session and explore subagents both call this with a shared service instance when possible.
 */
export function registerPerceptionCapability(
  host: ExtensionHost,
  options: RegisterPerceptionOptions,
): void {
  for (const tool of createPerceptionTools({ service: options.service })) {
    host.registerTool(tool);
  }

  if (options.injectPrompt === false) {
    return;
  }

  host.on("before_agent_start", (_payload, ctx) => {
    const base = ctx?.getSystemPrompt?.() ?? "";
    if (base.includes("## Workspace perception")) {
      return undefined;
    }
    const next = base.length > 0
      ? `${base}\n\n${PERCEPTION_PROMPT_ADDENDUM}`
      : PERCEPTION_PROMPT_ADDENDUM;
    return { systemPrompt: next };
  });
}
