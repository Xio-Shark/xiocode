import type { ProviderRegistration } from "../types.ts";

/** Request formats a provider client can speak; `[providers.*].model_apis` values. */
export const WIRE_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type WireApi = typeof WIRE_APIS[number];

export function isWireApi(value: string): value is WireApi {
  return (WIRE_APIS as readonly string[]).includes(value);
}

/** The endpoint each wire API posts to, for listings (`xio models`, web settings). */
export function wireApiEndpoint(api: string): string {
  if (api === "openai-responses") return "/responses";
  if (api === "anthropic-messages") return "/messages";
  return "/chat/completions";
}

export function isOpenCodeHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/**
 * OpenCode Zen / Go serve each model family on one protocol and reject the others
 * with `ModelProtocolUnsupported` (https://opencode.ai/docs/go/#endpoints). Families
 * rather than ids, so a new version of a model works without a release.
 */
const OPENCODE_FAMILIES: ReadonlyArray<readonly [RegExp, WireApi]> = [
  [/^(gpt-|grok-|muse-spark-)/, "openai-responses"],
  [/^(minimax-|qwen\d|claude-)/, "anthropic-messages"],
];

/**
 * Which request format to use for one model: `model_apis` from the config first,
 * then the OpenCode family table for opencode.ai endpoints, then the provider's own.
 */
export function resolveModelApi(registration: ProviderRegistration, modelId: string): string {
  const configured = registration.modelApis?.[modelId];
  if (configured) return configured;
  if (isOpenCodeHost(registration.baseUrl)) {
    const family = OPENCODE_FAMILIES.find(([pattern]) => pattern.test(modelId));
    if (family) return family[1];
  }
  return registration.api;
}
