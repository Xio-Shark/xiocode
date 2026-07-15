import { readFile, writeFile } from "node:fs/promises";

import { upsertDefaultThinkingLevel } from "../cli/config-mutate.ts";
import { resolveConfigPath } from "../cli/ensure-config.ts";
import {
  availableThinkingLevels,
  clampThinkingLevel,
  cycleThinkingLevel,
  findProviderModel,
  parseThinkingLevel,
  thinkingLevelChoices,
  thinkingStatusLabel,
} from "./thinking.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { ExtensionHost } from "./extension-host.ts";
import type { ModelInfo, ThinkingLevel } from "./types.ts";
import type { SessionUiSink } from "./session-ui.ts";

export type ThinkingCommandOptions = Readonly<{
  host: ExtensionHost;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  getModel: () => ModelInfo;
  env: NodeJS.ProcessEnv;
  persist?: boolean;
  /** Fired after the session thinking level changes (e.g. ultra → auto-enable explore). */
  onThinkingLevelChanged?: (level: ThinkingLevel) => Promise<void> | void;
}>;

export function registerThinkingCommands(options: ThinkingCommandOptions): void {
  const handler = async (args?: unknown) => runThinking(options, typeof args === "string" ? args : "");
  options.host.registerCommand("thinking", {
    description: "Set thinking / reasoning effort for this session.",
    handler,
  });
  options.host.registerCommand("effort", {
    description: "Alias for /thinking.",
    handler,
  });
}

export async function applyThinkingLevel(
  options: ThinkingCommandOptions,
  level: ThinkingLevel,
): Promise<ThinkingLevel> {
  const model = options.getModel();
  const registration = options.host.getProvider(model.provider);
  const providerModel = findProviderModel(registration, model.id);
  const available = availableThinkingLevels(providerModel);
  const next = clampThinkingLevel(level, available);
  options.host.setThinkingLevel(next);
  options.sink.setStatus?.("thinking", thinkingStatusLabel(next));
  if (options.persist !== false) {
    await persistThinkingLevel(options.env, next);
  }
  await options.onThinkingLevelChanged?.(next);
  return next;
}

export async function cycleSessionThinkingLevel(
  options: ThinkingCommandOptions,
): Promise<ThinkingLevel> {
  const model = options.getModel();
  const registration = options.host.getProvider(model.provider);
  const providerModel = findProviderModel(registration, model.id);
  const available = availableThinkingLevels(providerModel);
  const next = cycleThinkingLevel(options.host.getThinkingLevel(), available);
  return applyThinkingLevel(options, next);
}

async function runThinking(options: ThinkingCommandOptions, rawArgs: string): Promise<string> {
  const model = options.getModel();
  const registration = options.host.getProvider(model.provider);
  const providerModel = findProviderModel(registration, model.id);
  const available = availableThinkingLevels(providerModel);
  const direct = rawArgs.trim();
  if (direct.length > 0) {
    const parsed = parseThinkingLevel(direct);
    if (!parsed) {
      throw new Error(`unknown thinking level: ${direct} (use ${available.join("|")})`);
    }
    if (!available.includes(parsed)) {
      throw new Error(`thinking level ${parsed} is not available for ${model.provider}/${model.id}`);
    }
    const next = await applyThinkingLevel(options, parsed);
    return `thinking level set to ${next}`;
  }

  const picked = await options.interactive.select(
    `Thinking effort (current: ${options.host.getThinkingLevel()})`,
    thinkingLevelChoices(available),
  );
  if (!picked) return "thinking cancelled";
  const parsed = parseThinkingLevel(picked);
  if (!parsed) return "thinking cancelled";
  const next = await applyThinkingLevel(options, parsed);
  return `thinking level set to ${next}`;
}

async function persistThinkingLevel(env: NodeJS.ProcessEnv, level: ThinkingLevel): Promise<void> {
  const configPath = await resolveConfigPath(env);
  const content = await readFile(configPath, "utf8");
  const next = upsertDefaultThinkingLevel(content, level);
  if (next !== content) {
    await writeFile(configPath, next, "utf8");
  }
}
