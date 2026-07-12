/**
 * Surgical config.toml upserts — never write API keys.
 * Prefer preserving unrelated sections and comments when possible.
 */

export type ProviderUpsert = Readonly<{
  name: string;
  kind: string;
  baseUrl?: string;
  model: string;
  apiKeyEnv: string;
}>;

export type GeneralDefaultsUpsert = Readonly<{
  defaultProvider: string;
  defaultModel: string;
}>;

export function upsertProviderBlock(content: string, provider: ProviderUpsert): string {
  const block = formatProviderBlock(provider);
  const sectionRe = new RegExp(
    `\\[providers\\.${escapeRegExp(provider.name)}\\][\\s\\S]*?(?=\\n\\[|$)`,
  );
  if (sectionRe.test(content)) {
    return content.replace(sectionRe, () => `${block}\n`);
  }
  const trimmed = content.replace(/\s*$/, "");
  return `${trimmed}\n\n${block}\n`;
}

export function upsertGeneralDefaults(content: string, defaults: GeneralDefaultsUpsert): string {
  let next = ensureGeneralSection(content);
  next = upsertTomlKey(next, "general", "default_provider", defaults.defaultProvider);
  next = upsertTomlKey(next, "general", "default_model", defaults.defaultModel);
  return next;
}

export function upsertDefaultThinkingLevel(content: string, level: string): string {
  let next = ensureGeneralSection(content);
  next = upsertTomlKey(next, "general", "default_thinking_level", level);
  return next;
}

export function mutateConnectConfig(
  content: string,
  provider: ProviderUpsert,
  defaults: GeneralDefaultsUpsert = {
    defaultProvider: provider.name,
    defaultModel: provider.model,
  },
): string {
  return upsertGeneralDefaults(upsertProviderBlock(content, provider), defaults);
}

function formatProviderBlock(provider: ProviderUpsert): string {
  const lines = [
    `[providers.${provider.name}]`,
    `kind = ${tomlString(provider.kind)}`,
  ];
  if (provider.baseUrl) {
    lines.push(`base_url = ${tomlString(provider.baseUrl)}`);
  }
  lines.push(`model = ${tomlString(provider.model)}`);
  lines.push(`api_key_env = ${tomlString(provider.apiKeyEnv)}`);
  return lines.join("\n");
}

function ensureGeneralSection(content: string): string {
  if (/^\[general\]/m.test(content)) return content;
  const trimmed = content.replace(/^\s*/, "");
  return `[general]\n\n${trimmed}`;
}

function upsertTomlKey(
  content: string,
  section: string,
  key: string,
  value: string,
): string {
  const sectionRe = new RegExp(`(\\[${escapeRegExp(section)}\\][\\s\\S]*?)(?=\\n\\[|$)`);
  const match = content.match(sectionRe);
  if (!match) {
    return `${content.replace(/\s*$/, "")}\n\n[${section}]\n${key} = ${tomlString(value)}\n`;
  }
  const sectionBody = match[1] ?? "";
  const keyRe = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*=\\s*).*$`, "m");
  const updatedBody = keyRe.test(sectionBody)
    ? sectionBody.replace(keyRe, `$1${tomlString(value)}`)
    : `${sectionBody.replace(/\s*$/, "")}\n${key} = ${tomlString(value)}\n`;
  return content.replace(sectionRe, () => updatedBody);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
