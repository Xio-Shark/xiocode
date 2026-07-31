/**
 * `xio-setup provider` — add a provider from the shared preset catalog.
 *
 * Reuses /connect's PROVIDER_PRESETS (src/cli/provider-catalog.ts) and the
 * config-mutate upserts — no second source of truth. API keys stay in env
 * vars; only api_key_env names are ever written to config.toml.
 */

import { writeFile } from "node:fs/promises";

import { ensureConfigFile } from "../../../src/cli/ensure-config.ts";
import { parseXioConfig } from "../../../src/cli/config-parser.ts";
import {
  findProviderPreset,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../../../src/cli/provider-catalog.ts";
import {
  upsertGeneralDefaults,
  upsertProviderBlock,
} from "../../../src/cli/config-mutate.ts";

/** Presets addable non-interactively; `custom` needs /connect's prompts. */
export function listSetupProviderPresets(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => !preset.custom);
}

export function formatProviderPresetList(): string {
  const rows = listSetupProviderPresets().map((preset, index) => {
    const id = preset.id.padEnd(12, " ");
    return ` ${String(index + 1).padStart(2, " ")}. ${id} ${preset.label} — model ${preset.defaultModel}, key env ${preset.apiKeyEnv}`;
  });
  return `provider presets (keys stay in env vars):\n${rows.join("\n")}\n`;
}

export function applyProviderPreset(
  content: string,
  preset: ProviderPreset,
  options: Readonly<{ model?: string; makeDefault?: boolean }> = {},
): string {
  const model = options.model?.trim() || preset.defaultModel;
  let next = upsertProviderBlock(content, {
    name: preset.id,
    kind: preset.kind,
    ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
    model,
    apiKeyEnv: preset.apiKeyEnv,
  });
  if (options.makeDefault) {
    next = upsertGeneralDefaults(next, { defaultProvider: preset.id, defaultModel: model });
  }
  return next;
}

export async function runProviderCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
  ask?: (question: string) => Promise<string>,
  isTty?: boolean,
): Promise<number> {
  const flags = parseProviderFlags(args);
  if (flags.error) {
    write(`xio-setup: ${flags.error}\n`);
    return 1;
  }
  if (flags.id === undefined || flags.id === "list") {
    if (flags.id === "list" || (!ask && isTty !== true)) {
      write(formatProviderPresetList());
      write("add one: xio-setup provider <id> [--model <model>] [--default]\n");
      write("custom OpenAI-compatible providers: run /connect inside a session.\n");
      return 0;
    }
    return runProviderMenu(env, write, ask);
  }
  const preset = findProviderPreset(flags.id);
  if (!preset || preset.custom) {
    write(`xio-setup: unknown provider preset: ${flags.id}\n`);
    write(`Known: ${listSetupProviderPresets().map((entry) => entry.id).join(" ")}\n`);
    return 1;
  }
  const applyOptions = {
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    makeDefault: flags.makeDefault,
  };
  return writeProviderPreset(preset, applyOptions, env, write);
}

async function runProviderMenu(
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
  askOverride?: (question: string) => Promise<string>,
): Promise<number> {
  const presets = listSetupProviderPresets();
  const { createInterface } = await import("node:readline/promises");
  const rl = askOverride
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout });
  const ask = askOverride ?? (async (question: string) => rl!.question(question));
  try {
    write(formatProviderPresetList());
    const picked = (await ask("provider [number/id], q = quit: ")).trim();
    if (picked === "q" || picked === "quit" || picked === "") return 0;
    const byIndex = /^\d+$/.test(picked) ? presets[Number(picked) - 1] : undefined;
    const preset = byIndex ?? presets.find((entry) => entry.id === picked);
    if (!preset) {
      write(`unknown provider preset: ${picked}\n`);
      return 1;
    }
    const model = (await ask(`model [${preset.defaultModel}]: `)).trim();
    const makeDefault = /^y(es)?$/i.test(
      (await ask("set as default provider? [y/N]: ")).trim(),
    );
    return writeProviderPreset(
      preset,
      { ...(model ? { model } : {}), makeDefault },
      env,
      write,
    );
  } finally {
    rl?.close();
  }
}

/** Validate with the real parser before writing — a broken config.toml is worse than no-op. */
async function writeProviderPreset(
  preset: ProviderPreset,
  options: Readonly<{ model?: string; makeDefault?: boolean }>,
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
): Promise<number> {
  const { path, content } = await ensureConfigFile(env, { write });
  const next = applyProviderPreset(content, preset, options);
  if (next === content) {
    write(`provider ${preset.id} already configured identically — nothing to write.\n`);
    return 0;
  }
  try {
    parseXioConfig(next);
  } catch (error) {
    write(`xio-setup: refusing to write — merged config fails to parse: ${String(error)}\n`);
    return 1;
  }
  await writeFile(path, next, { encoding: "utf8", mode: 0o600 });
  const model = options.model?.trim() || preset.defaultModel;
  write(`added provider ${preset.id} (model ${model}) → ${path}\n`);
  if (options.makeDefault) {
    write(`default provider/model set to ${preset.id}/${model}\n`);
  }
  write(`note: set ${preset.apiKeyEnv} in your shell env — keys are never written to config.toml\n`);
  return 0;
}

function parseProviderFlags(args: readonly string[]): Readonly<{
  id?: string;
  model?: string;
  makeDefault: boolean;
  error?: string;
}> {
  let id: string | undefined;
  let model: string | undefined;
  let makeDefault = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--model") {
      model = args[index + 1];
      if (!model) return { makeDefault, error: "--model requires a value" };
      index += 1;
    } else if (arg === "--default") {
      makeDefault = true;
    } else if (arg.startsWith("-")) {
      return { makeDefault, error: `unknown flag: ${arg}` };
    } else if (id === undefined) {
      id = arg;
    } else {
      return { makeDefault, error: `unexpected argument: ${arg}` };
    }
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {}),
    makeDefault,
  };
}
