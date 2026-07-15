import type {
  ChatCompletionRequest,
  JsonSchema,
  ProviderRegistration,
  ProviderToolChoice,
  ProviderToolChoiceScope,
} from "../types.ts";

export type ToolChoiceWire =
  | Readonly<{ kind: "openai"; value: "auto" | "required" | "none" }>
  | Readonly<{ kind: "anthropic"; value: { type: "auto" | "any" | "none" } }>
  | Readonly<{ kind: "omitted"; reason: string }>;

export type ResolvedRequestControls = Readonly<{
  maxTokens: number | undefined;
  toolChoiceWire: ToolChoiceWire;
  promptCache: boolean;
  attrs: Readonly<Record<string, string | number | boolean | null>>;
}>;

/**
 * Resolve max_tokens / tool_choice / prompt-cache for a provider request.
 * Unsupported combinations are omitted with an explicit reason — never guessed.
 */
export function resolveRequestControls(input: Readonly<{
  registration?: ProviderRegistration;
  modelId: string;
  request: Pick<
    ChatCompletionRequest,
    "maxTokens" | "toolChoice" | "toolChoiceScope" | "tools" | "promptCache"
  >;
}>): ResolvedRequestControls {
  const model = input.registration?.models.find((entry) => entry.id === input.modelId)
    ?? input.registration?.models[0];
  const maxTokens = input.request.maxTokens ?? model?.maxTokens;
  const api = input.registration?.api ?? "openai-completions";
  const configuredChoice = input.request.toolChoice ?? input.registration?.toolChoice;
  const scope: ProviderToolChoiceScope = input.request.toolChoiceScope
    ?? input.registration?.toolChoiceScope
    ?? (configuredChoice ? "always" : "never");
  const tools = input.request.tools ?? [];
  const applyChoice = shouldApplyToolChoice(scope, tools);
  const toolChoiceWire = applyChoice && configuredChoice
    ? mapToolChoiceToWire(api, configuredChoice)
    : configuredChoice && !applyChoice
    ? { kind: "omitted" as const, reason: `tool_choice_scope=${scope}` }
    : configuredChoice
    ? mapToolChoiceToWire(api, configuredChoice)
    : { kind: "omitted" as const, reason: "not_configured" };

  const compat = model?.compat ?? {};
  const promptCacheExplicit = input.request.promptCache;
  const compatCache = compat.prompt_cache;
  const promptCache = promptCacheExplicit !== undefined
    ? promptCacheExplicit
    : compatCache === false
    ? false
    : api === "anthropic-messages";

  return {
    maxTokens,
    toolChoiceWire,
    promptCache,
    attrs: {
      max_tokens: maxTokens ?? null,
      tool_choice: toolChoiceWire.kind === "omitted"
        ? `omitted:${toolChoiceWire.reason}`
        : toolChoiceWire.kind === "openai"
        ? toolChoiceWire.value
        : toolChoiceWire.value.type,
      prompt_cache: promptCache
        ? (api === "anthropic-messages" ? "anthropic-ephemeral" : "compat")
        : "none",
    },
  };
}

export function shouldApplyToolChoice(
  scope: ProviderToolChoiceScope,
  tools: readonly Readonly<{ function: { parameters: JsonSchema } }>[],
): boolean {
  if (scope === "never") return false;
  if (tools.length === 0) return false;
  if (scope === "always") return true;
  // non_simple: multiple tools or nested object schemas
  if (tools.length > 1) return true;
  return tools.some((tool) => schemaIsNested(tool.function.parameters));
}

export function mapToolChoiceToWire(api: string, choice: ProviderToolChoice): ToolChoiceWire {
  if (api === "openai-completions" || api === "mistral-conversations") {
    if (choice === "auto") return { kind: "openai", value: "auto" };
    // OpenAI has no "any"; map required/any → required
    return { kind: "openai", value: "required" };
  }
  if (api === "anthropic-messages") {
    if (choice === "auto") return { kind: "anthropic", value: { type: "auto" } };
    return { kind: "anthropic", value: { type: "any" } };
  }
  return {
    kind: "omitted",
    reason: `unsupported_api:${api}`,
  };
}

function schemaIsNested(schema: JsonSchema | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  const props = schema.properties;
  if (!props) return false;
  for (const value of Object.values(props)) {
    if (!value || typeof value !== "object") continue;
    if (value.type === "object" || value.properties || value.items) return true;
  }
  return false;
}
