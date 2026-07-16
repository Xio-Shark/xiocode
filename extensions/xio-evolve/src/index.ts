import { createHash } from "node:crypto";

import { decodeRunProvenance } from "../../xio-regress/src/decoder.ts";
import { ContextInjector } from "./context-injector.ts";
import { ResultDenoiser } from "./result-denoiser.ts";
import { RetrospectiveRunner } from "./retrospective/runner.ts";
import type { BlockerLog, RetrospectiveConfig } from "./retrospective/types.ts";
import { collectRuntimeStatus, formatStatusWidget } from "./runtime-status.ts";
import { RunStore } from "./run-store.ts";
import { SecretRedactor } from "./secret-redactor.ts";
import { TodoEnforcer } from "./todo-enforcer.ts";
import { TrajectoryRecorder } from "./trajectory-recorder.ts";
import { classifyPrompt, type ModelRouteDecision } from "./model-router.ts";
import { pipeRuntimeEventsToTrajectory } from "../../../src/runtime/events/adapters.ts";

import type { CommandHandlerContext, ExtensionContext, RunMetadata, ToolHookEvent, ToolResult } from "./types.ts";

export type XioEvolveOptions = Readonly<{
  contextInjector?: ContextInjector;
  resultDenoiser?: ResultDenoiser;
  todoEnforcer?: TodoEnforcer;
  runStore?: RunStore;
  trajectoryRecorder?: TrajectoryRecorder;
  onRunStart?: (metadata: RunMetadata) => void;
  /** Post-task retrospective (blockers → log → washed report → inject/improve queue). */
  retrospective?: Partial<RetrospectiveConfig> & Readonly<{
    summarizeWithLlm?: (input: Readonly<{
      log: BlockerLog;
      draftMarkdown: string;
    }>) => Promise<string | undefined>;
  }>;
}>;

const CONTEXT_INVALIDATING_TOOLS = new Set(["bash", "edit", "write"]);
const PROMPT_REDACTOR = new SecretRedactor();

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
  const retrospective = new RetrospectiveRunner({
    runStore,
    config: options.retrospective,
    summarizeWithLlm: options.retrospective?.summarizeWithLlm,
    notify: (message) => {
      // best-effort; command UI may not be available during agent_end
      void message;
    },
  });

  let currentRun: RunMetadata | undefined;
  let lastRoute: ModelRouteDecision | undefined;
  let lastContextInjectionError: string | undefined;
  let lastBaseSystemPrompt = "";
  let currentSystemPrompt = "";
  let promptArtifactWritten = false;

  // Prefer RuntimeEvent bus when session provides one (product multi-sink).
  // Host tool_result still runs for denoise / error tracking / context invalidate.
  const runtimeEvents = ctx.getRuntimeEvents?.();
  const recordViaRuntimeEvents = runtimeEvents !== undefined;
  if (runtimeEvents) {
    pipeRuntimeEventsToTrajectory(runtimeEvents, recorder);
  }

  ctx.on?.("session_start", async (payload) => {
    const provenance = sessionProvenance(payload);
    const identity = sessionIdentity(payload);
    const metadata = await recorder.start({
      ...(identity.provider ? { provider: identity.provider } : {}),
      ...(identity.model ? { model: identity.model } : {}),
    });
    currentRun = metadata;
    promptArtifactWritten = false;
    if (provenance) {
      await runStore.writeJson(metadata.run_id, "provenance.json", provenance);
    }
    options.onRunStart?.(metadata);
    return metadata;
  });

  ctx.on?.("model_change", async (payload) => {
    const identity = sessionIdentity(payload);
    if (!currentRun || !identity.provider || !identity.model) {
      return undefined;
    }
    if (currentRun.provider === identity.provider && currentRun.model === identity.model) {
      return undefined;
    }
    const updated = await recorder.updateRunIdentity({
      provider: identity.provider,
      model: identity.model,
    });
    if (updated) {
      currentRun = updated;
    }
    return updated;
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
    if (prompt.length > 0 && currentRun && !promptArtifactWritten) {
      const replayPrompt = redactPrompt(prompt);
      await runStore.writeJson(currentRun.run_id, "prompt.json", {
        schema_version: "xio-run-prompt.v2",
        content: replayPrompt,
        prompt_sha: createHash("sha256").update(replayPrompt).digest("hex"),
      });
      promptArtifactWritten = true;
    }
    lastRoute = classifyPrompt(prompt);
    const retroContext = retrospective.consumeInjection();
    if (lastRoute.taskClass === "simple") {
      return retroContext ?? "";
    }
    const injected = await startContextInjection(contextInjector, (error) => {
      lastContextInjectionError = error;
    }, { allowExpiredCache: true, allowMissingCache: true });
    if (retroContext && retroContext.length > 0) {
      return injected.length > 0 ? `${injected}\n\n${retroContext}` : retroContext;
    }
    return injected;
  });

  ctx.on?.("tool_call", async (payload) => {
    if (!recordViaRuntimeEvents) {
      await recorder.recordToolCall(toToolCall(payload));
    }
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

    if (!recordViaRuntimeEvents) {
      await recorder.recordToolResult(result ? withToolResult(payload, result) : payload);
    }
    if (shouldInvalidateContext(event)) {
      contextInjector.invalidate();
    }
    return result;
  });

  ctx.on?.("provider_response", (payload) => {
    if (!recordViaRuntimeEvents) {
      recorder.recordProviderUsage(payload);
    }
  });
  ctx.on?.("context_compaction", (payload) => {
    const event = asRecord(payload);
    if (event.stage === "success") recorder.recordProviderUsage({ usage: event.usage });
  });
  ctx.on?.("turn_end", (payload) => {
    if (!recordViaRuntimeEvents) {
      recorder.recordTurnEnd(payload);
    }
  });
  ctx.on?.("agent_end", async (payload) => {
    const event = asRecord(payload);
    const cancelled = event.cancelled === true;
    const agentSuccess = event.success === true;
    const summary = await recorder.finish(agentSuccess && !cancelled ? "success" : "failed");
    if (!currentRun) {
      return summary;
    }
    // Post-task "subagent": extract blockers → log → wash report for main agent / improve queue.
    await retrospective.runForFinishedTask({
      runId: currentRun.run_id,
      summary,
      agentSuccess,
      cancelled,
    });
    return summary;
  });

  ctx.registerCommand?.("retrospect", {
    description: "Show or re-run the latest post-task retrospective report.",
    handler: async (args, commandCtx) => {
      const recent = await runStore.listRecent(1);
      const run = recent[0];
      if (!run) {
        return "no runs yet";
      }
      const arg = typeof args === "string" ? args.trim() : "";
      if (arg === "rerun" || arg === "run") {
        const summaryRaw = await runStoreReadJson(runStore, run.run_id, "summary.json");
        if (!summaryRaw || typeof summaryRaw !== "object") {
          return `no summary for ${run.run_id}`;
        }
        const result = await retrospective.runForFinishedTask({
          runId: run.run_id,
          summary: summaryRaw as import("./types.ts").RunSummary,
          agentSuccess: (summaryRaw as { success?: boolean }).success === true,
        });
        if (result.skipped) {
          return `retrospective skipped: ${result.reason ?? "unknown"}`;
        }
        commandCtx?.ui?.notify?.(`retrospective refreshed for ${run.run_id}`, "info");
        return result.report?.markdown ?? "ok";
      }
      try {
        const { readFile } = await import("node:fs/promises");
        const md = await readFile(runStore.filePath(run.run_id, "retrospective-report.md"), "utf8");
        return md;
      } catch {
        return `no retrospective yet for ${run.run_id} — complete a multi-step task first, or /retrospect rerun`;
      }
    },
  });

  ctx.registerCommand?.("status", {
    description: "Show XioCode runtime and run status.",
    handler: async (_args, commandCtx) => {
      const provider = commandCtx?.model?.provider;
      const model = commandCtx?.model?.id;
      if (currentRun && provider && model && (currentRun.provider !== provider || currentRun.model !== model)) {
        const updated = await recorder.updateRunIdentity({ provider, model });
        if (updated) {
          currentRun = updated;
        }
      }
      const status = await collectRuntimeStatus({
        runStore,
        provider,
        model,
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

/**
 * Normalize tool_result payload shapes:
 * - agent-loop: `{ call: { id, name, args }, result: { content, isError, metadata } }`
 * - legacy/flat: `{ toolName, toolCallId, content, isError, input }`
 *
 * Reading only top-level `content` (legacy) against nested payloads fed empty
 * text into ResultDenoiser and wiped tool output for the model + TUI.
 */
function toToolHookEvent(payload: unknown): ToolHookEvent {
  const record = asRecord(payload);
  const nested = asRecord(record.result);
  const content = nested && "content" in nested ? nested.content : record.content;
  const isError = nested?.isError === true || record.isError === true;
  const metadata = asRecord(
    nested?.metadata ?? nested?.details ?? record.metadata ?? record.details,
  );
  return {
    call: toToolCall(payload),
    result: {
      content,
      isError,
      metadata,
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
  const nested = asRecord(record.call);
  const source = nested ?? record;
  return {
    id: stringValue(source.toolCallId ?? source.id ?? record.toolCallId ?? record.id),
    name: stringValue(source.toolName ?? source.name ?? record.toolName ?? record.name) ?? "unknown",
    args: asRecord(source.input ?? source.args ?? record.input ?? record.args),
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

function redactPrompt(prompt: string): string {
  const redacted = PROMPT_REDACTOR.redact(prompt);
  if (typeof redacted !== "string") {
    throw new Error("redacted prompt must remain a string");
  }
  return redacted;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionProvenance(payload: unknown) {
  const event = asRecord(payload);
  if (!("provenance" in event)) {
    return null;
  }
  return decodeRunProvenance(event.provenance);
}

function sessionIdentity(payload: unknown): Readonly<{ provider?: string; model?: string }> {
  const event = asRecord(payload);
  return {
    provider: stringValue(event.provider),
    model: stringValue(event.model),
  };
}

async function runStoreReadJson(
  store: RunStore,
  runId: string,
  fileName: string,
): Promise<unknown> {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(store.filePath(runId, fileName), "utf8"));
  } catch {
    return undefined;
  }
}

export { ContextInjector, ResultDenoiser, RunStore, TodoEnforcer, TrajectoryRecorder };
export { RetrospectiveRunner, loadRetrospectiveImproveGoals } from "./retrospective/runner.ts";
export { extractBlockerLog } from "./retrospective/extract.ts";
export { washRetrospectiveReport, formatInjectionContext } from "./retrospective/wash.ts";
export type { ToolCall, ToolResult } from "./types.ts";
export type {
  BlockerLog,
  RetrospectiveConfig,
  RetrospectiveReport,
} from "./retrospective/types.ts";
