import { ContextInjector } from "./context-injector.ts";
import { ResultDenoiser } from "./result-denoiser.ts";
import { collectRuntimeStatus, formatStatusWidget } from "./runtime-status.ts";
import { RunStore } from "./run-store.ts";
import { TodoEnforcer } from "./todo-enforcer.ts";
import { TrajectoryRecorder } from "./trajectory-recorder.ts";
import { classifyPrompt, type ModelRouteDecision } from "./model-router.ts";

import type { CommandHandlerContext, ExtensionContext, RunMetadata, ToolHookEvent, ToolResult } from "./types.ts";

export type XioEvolveOptions = Readonly<{
  contextInjector?: ContextInjector;
  resultDenoiser?: ResultDenoiser;
  todoEnforcer?: TodoEnforcer;
  runStore?: RunStore;
  trajectoryRecorder?: TrajectoryRecorder;
  onRunStart?: (metadata: RunMetadata) => void;
}>;

const CONTEXT_INVALIDATING_TOOLS = new Set(["bash", "edit", "write"]);

/**
 * Default evolve path: TrajectoryRecorder + RunStore + Denoiser + ContextInjector + TodoEnforcer.
 * StrategyLearner / PromptEvolver / EvalComparator / SpeculativeExecutor / optimization layers
 * are intentionally not registered.
 */
export function registerXioEvolve(ctx: ExtensionContext, options: XioEvolveOptions = {}): void {
  const contextInjector = options.contextInjector ?? new ContextInjector();
  const resultDenoiser = options.resultDenoiser ?? new ResultDenoiser();
  const todoEnforcer = options.todoEnforcer ?? new TodoEnforcer();
  const runStore = options.runStore ?? new RunStore();
  const recorder = options.trajectoryRecorder ?? new TrajectoryRecorder({
    store: runStore,
    errorTracker: contextInjector.getErrorTracker(),
  });

  let currentRun: RunMetadata | undefined;
  let lastRoute: ModelRouteDecision | undefined;
  let lastContextInjectionError: string | undefined;
  let lastBaseSystemPrompt = "";
  let currentSystemPrompt = "";

  ctx.on?.("session_start", () => {
    return recorder.start().then((metadata) => {
      currentRun = metadata;
      options.onRunStart?.(metadata);
      return metadata;
    });
  });

  ctx.on?.("before_agent_start", async (payload, eventCtx) => {
    const event = asRecord(payload);
    const latestPrompt = eventCtx?.getSystemPrompt?.();
    const candidatePrompt = latestPrompt ?? (typeof event.systemPrompt === "string" ? event.systemPrompt : "");
    const basePrompt = candidatePrompt === currentSystemPrompt ? lastBaseSystemPrompt : candidatePrompt;
    lastBaseSystemPrompt = basePrompt;

    const prompt = userPromptFromPayload(payload);
    lastRoute = prompt.length > 0 ? classifyPrompt(prompt) : undefined;
    if (lastRoute && lastRoute.taskClass !== "simple") {
      void startContextInjection(contextInjector, (error) => {
        lastContextInjectionError = error;
      });
    }

    currentSystemPrompt = [basePrompt, todoEnforcer.getSystemAddendum()].filter((part) => part.length > 0).join("\n\n");
    return { systemPrompt: currentSystemPrompt };
  });

  ctx.on?.("turn_start", async (payload) => {
    const prompt = userPromptFromPayload(payload);
    lastRoute = classifyPrompt(prompt);
    if (lastRoute.taskClass === "simple") {
      return "";
    }
    return startContextInjection(contextInjector, (error) => {
      lastContextInjectionError = error;
    }, { allowExpiredCache: true, allowMissingCache: true });
  });

  ctx.on?.("tool_call", async (payload) => {
    await recorder.recordToolCall(toToolCall(payload));
    return undefined;
  });

  ctx.on?.("tool_result", async (payload) => {
    const event = toToolHookEvent(payload);
    const result = event.result
      ? await resultDenoiser.process(event.call.name, event.result, event.call.args)
      : undefined;

    if (result?.isError && result.content) {
      contextInjector.getErrorTracker().recordError(event.call.name, textFromToolContent(result.content), event.call.args);
    }

    await recorder.recordToolResult(result ? withToolResult(payload, result) : payload);
    if (shouldInvalidateContext(event)) {
      contextInjector.invalidate();
    }
    return result;
  });

  ctx.on?.("turn_end", (payload) => recorder.recordTurnEnd(payload));
  ctx.on?.("agent_end", () => recorder.finish());

  ctx.registerCommand?.("status", {
    description: "Show XioCode runtime and run status.",
    handler: async (_args, commandCtx) => {
      const status = await collectRuntimeStatus({
        runStore,
        provider: commandCtx?.model?.provider,
        model: commandCtx?.model?.id,
        currentRun,
      });
      commandCtx?.ui?.setWidget?.("xiocode-status", formatStatusWidget(status), { placement: "above" });
      commandCtx?.ui?.notify?.(`xio status: ${status.provider}/${status.model} run=${status.runId}`, "info");
      return { ...status, lastRoute, lastContextInjectionError };
    },
  });
}

function startContextInjection(
  contextInjector: ContextInjector,
  setError: (error: string) => void,
  options?: Parameters<ContextInjector["inject"]>[0],
): Promise<string> {
  const injected = contextInjector.inject(options);
  void injected.catch((error: unknown) => {
    setError(error instanceof Error ? error.message : String(error));
  });
  return injected;
}

function toToolHookEvent(payload: unknown): ToolHookEvent {
  const record = asRecord(payload);
  return {
    call: toToolCall(payload),
    result: {
      content: record.content,
      isError: record.isError === true,
      metadata: asRecord(record.details),
    },
  };
}

function withToolResult(payload: unknown, result: ToolResult): unknown {
  const record = asRecord(payload);
  const metadata = asRecord(result.metadata);
  const next: Record<string, unknown> = { ...record, content: textFromToolContent(result.content) };
  if ("isError" in record || result.isError === true) {
    next.isError = result.isError === true;
  }
  if ("details" in record || Object.keys(metadata).length > 0) {
    next.details = metadata;
  }
  return next;
}

function textFromToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((item) => asRecord(item).text)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("\n");
    if (text.length > 0) {
      return text;
    }
  }
  return JSON.stringify(content, null, 2) ?? String(content ?? "");
}

function shouldInvalidateContext(event: ToolHookEvent): boolean {
  return event.result?.isError !== true && CONTEXT_INVALIDATING_TOOLS.has(event.call.name);
}

function toToolCall(payload: unknown) {
  const record = asRecord(payload);
  return {
    id: stringValue(record.toolCallId ?? record.id),
    name: stringValue(record.toolName ?? record.name) ?? "unknown",
    args: asRecord(record.input ?? record.args),
  };
}

function userPromptFromPayload(payload: unknown): string {
  const record = asRecord(payload);
  const content = record.content ?? record.message ?? record.prompt ?? "";
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : asRecord(item).text))
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("");
  }
  const text = asRecord(content).text;
  return typeof text === "string" ? text : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export { ContextInjector, ResultDenoiser, RunStore, TodoEnforcer, TrajectoryRecorder };
export type { ToolCall, ToolResult } from "./types.ts";
