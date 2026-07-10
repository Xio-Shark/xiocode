import type { ThinkingLevel } from "./types.ts";

export type ModelTaskClass = "simple" | "code";

export type ModelRouteConfig = Readonly<{
  defaultModel?: string;
  simpleModel?: string;
  codeModel?: string;
  simpleThinking?: ThinkingLevel;
  codeThinking?: ThinkingLevel;
}>;

export type ModelRouteDecision = Readonly<{
  taskClass: ModelTaskClass;
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  reason: string;
}>;

const CODE_HINT = /\b(bug|fix|test|refactor|implement|code|build|lint|error|file|edit|write|bash|npm|vitest|typescript|config)\b/i;

/** ≤40-line binary classifier: simple vs code; optional config model pick. */
export function classifyPrompt(prompt: string, config: ModelRouteConfig = {}): ModelRouteDecision {
  const trimmed = prompt.trim();
  const isSimple = trimmed.length < 80 && !CODE_HINT.test(trimmed);
  if (isSimple) {
    return {
      taskClass: "simple",
      model: config.simpleModel ?? config.defaultModel,
      thinkingLevel: config.simpleThinking,
      reason: "short prompt without code hints",
    };
  }
  return {
    taskClass: "code",
    model: config.codeModel ?? config.defaultModel,
    thinkingLevel: config.codeThinking,
    reason: "code or long prompt",
  };
}

/** @deprecated Prefer classifyPrompt; kept for call-site compatibility during cleanup. */
export class ModelRouter {
  private readonly config: ModelRouteConfig;

  constructor(config: ModelRouteConfig = {}) {
    this.config = config;
  }

  route(prompt: string): ModelRouteDecision {
    return classifyPrompt(prompt, this.config);
  }
}

export function resolveRouteModel(decision: ModelRouteDecision, fallback?: string): string | undefined {
  return decision.model ?? fallback;
}
