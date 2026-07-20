import type { ExtensionHost } from "./extension-host.ts";
import type {
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  LlmClient,
  ProviderToolChoice,
  ProviderToolChoiceScope,
  ToolCallEvent,
  ToolDefinition,
  ToolExecuteResult,
  TurnEndOutcome,
  TurnEndPayload,
  TurnEndToolResultSummary,
} from "./types.ts";
import { assertMessageBudget } from "./context-compaction.ts";
import { FileWriteQueue } from "./file-write-queue.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { getCachedProviderTools } from "./providers/tool-schema-cache.ts";
import { emptyTokenUsage, sumTokenUsage } from "./usage.ts";
import { formatDoneContractFeedback, runDoneContract } from "./verify/done-contract.ts";

import type { TokenUsage } from "./types.ts";
import type { DoneContract, DoneContractResult } from "./verify/done-contract.ts";
import type { RuntimeEventEmitter } from "./events/types.ts";
import {
  formatFollowUpUserMessage,
  formatSteerUserMessage,
  type SteerMailbox,
} from "./steer.ts";
import {
  createTurnSnapshot,
  type LiveConfigView,
  type TurnSnapshot,
} from "./harness/turn-snapshot.ts";

/** Tools that mutate workspace files and must not race each other by realpath. */
const WRITE_SERIAL_TOOLS = new Set(["write", "edit", "plan"]);
const DEFAULT_MAX_SESSION_MESSAGES = 80;
/** Per user-prompt agent↔model turns (provider requests). Configurable via general.max_turns. */
export const DEFAULT_MAX_TURNS = 24;
/**
 * Block identical tool name+args after this many consecutive executions.
 * 0 disables. Configurable via general.repeat_tool_limit.
 */
export const DEFAULT_REPEAT_TOOL_LIMIT = 3;

export type AgentLoopOptions = Readonly<{
  host: ExtensionHost;
  client: LlmClient;
  model: string;
  providerApi?: string;
  /** Provider name for registration lookup (maxTokens / toolChoice). */
  providerName?: string;
  systemPrompt?: string;
  maxTurns?: number;
  doneContract?: DoneContract;
  /** Extra turns allowed after a failed done contract to attempt fixes. Default 3. */
  verifyRepairTurns?: number;
  /**
   * Max consecutive identical tool+args before blocking (isError, no execute).
   * Default 3; set 0 to disable.
   */
  repeatToolLimit?: number;
  onAssistantText?: (text: string) => void;
  onAssistantDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  signal?: AbortSignal;
  /** When true (default), read/grep/glob/bash run concurrently; write/edit stay serial. */
  parallelToolCalls?: boolean;
  /** Prior session messages for multi-turn continuity. */
  priorMessages?: readonly ChatMessage[];
  /** Hard cap on retained session messages; trim inserts an explicit notice. */
  maxSessionMessages?: number;
  /** Optional override for max_tokens (else model registration). */
  maxTokens?: number;
  toolChoice?: ProviderToolChoice;
  toolChoiceScope?: ProviderToolChoiceScope;
  onCheckpoint?: (checkpoint: AgentLoopCheckpoint) => Promise<void> | void;
  /**
   * Explicit 1-based turn index for trajectory. When omitted, derived as
   * (prior user messages) + 1.
   */
  turnIndex?: number;
  /**
   * Optional RuntimeEvent.v1 bus. When set, agent loop dual-writes core events
   * (turn/text/tool/run) alongside host extension hooks and UI callbacks.
   */
  runtimeEvents?: RuntimeEventEmitter;
  /**
   * Soft/hard steer + follow-up mailbox.
   * Soft: drained at tool-batch end and after a text-only provider step.
   * Follow-up: drained only when the loop would otherwise end (no tools + soft empty).
   * Hard: applied by the outer session after abort (see session.steer).
   * Never injects into the same in-flight provider stream body.
   */
  steerMailbox?: SteerMailbox;
  /**
   * Optional shared realpath write queue. When omitted, a per-batch queue is used
   * so same-path write/edit still serialize within the batch.
   */
  fileWriteQueue?: FileWriteQueue;
  /**
   * Live config getters for per-provider-request TurnSnapshot.
   * When set (default path from session), each provider call freezes a snapshot
   * so mid-request live model/tools changes cannot mutate the in-flight request.
   * When omitted, a snapshot is built once from static options at first request
   * and reused for the rest of the loop (rollback / unit-test path).
   */
  getLiveConfig?: () => LiveConfigView;
  /**
   * When true (default), rebuild TurnSnapshot from getLiveConfig (or static options)
   * before every provider request. When false, freeze once at first request.
   */
  turnSnapshot?: boolean;
  /** Test/telemetry hook: observe each frozen snapshot. */
  onTurnSnapshot?: (snapshot: TurnSnapshot) => void;
}>;

export type AgentLoopCheckpoint = Readonly<{
  phase: "turn_started" | "awaiting_provider" | "tool_batch_running" | "turn_complete";
  messages: readonly ChatMessage[];
  pendingTools?: readonly Readonly<{ id: string; name: string }>[];
}>;

export type AgentLoopResult = Readonly<{
  messages: readonly ChatMessage[];
  finalText: string;
  doneContract?: DoneContractResult;
  success: boolean;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  usage: TokenUsage;
  cancelled?: boolean;
  /** When cancelled by hard steer, the steer text to continue with (session applies). */
  hardSteerText?: string;
}>;

type SegmentResult = Readonly<{
  turns: number;
  finalText: string;
  toolCalls: number;
  toolErrors: number;
  usages: readonly TokenUsage[];
  cancelled?: boolean;
  toolResults: readonly TurnEndToolResultSummary[];
}>;

type LoopProgress = SegmentResult & Readonly<{
  doneContract?: DoneContractResult;
}>;

/** Mutable collector for tool results within one user-prompt agent loop. */
type TurnToolCollector = {
  results: TurnEndToolResultSummary[];
};

export async function runAgentLoop(userPrompt: string, options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const verifyRepairTurns = options.verifyRepairTurns ?? 3;
  const repeatToolLimit = options.repeatToolLimit ?? DEFAULT_REPEAT_TOOL_LIMIT;
  let systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  options.host.setSystemPrompt(systemPrompt);
  const turnIndex = options.turnIndex ?? deriveTurnIndex(options.priorMessages);
  const toolCollector: TurnToolCollector = { results: [] };
  const bus = options.runtimeEvents;
  const turnId = `turn-${turnIndex}`;
  bus?.setTurnId(turnId);
  // First emission on a fresh bus is run.start (seq 0); multi-prompt reuses bus → skip.
  if (bus && bus.peekSeq() === 0) {
    bus.emit("run.start", { model: options.model });
  }

  const beforeStart = await options.host.emit("before_agent_start", {
    prompt: userPrompt,
    systemPrompt,
    tools: options.host.listTools().map((tool) => ({ name: tool.name })),
  });
  for (const result of beforeStart) {
    const record = asRecord(result);
    if (typeof record?.systemPrompt === "string" && record.systemPrompt.length > 0) {
      systemPrompt = record.systemPrompt;
      options.host.setSystemPrompt(systemPrompt);
    }
  }

  bus?.emit("turn.start", { prompt: userPrompt, turnIndex });
  const turnStart = await options.host.emit("turn_start", { prompt: userPrompt });
  const injectedContext = collectTurnStartContext(turnStart);

  const messages = buildMessages({
    userPrompt,
    systemPrompt,
    injectedContext,
    priorMessages: options.priorMessages,
    maxSessionMessages: Math.max(4, options.maxSessionMessages ?? DEFAULT_MAX_SESSION_MESSAGES),
  });
  await publishCheckpoint(options, { phase: "turn_started", messages });

  if (options.signal?.aborted) {
    const hardSteer = options.steerMailbox?.takeHard();
    if (!hardSteer) {
      discardFollowUpsOnAbort(options, "abort");
    }
    const cancelledPayload = {
      turnIndex,
      prompt: userPrompt,
      message: null as null,
      toolResults: toolCollector.results,
      outcome: "cancelled" as const,
      error_class: "abort",
    };
    await emitTurnEnd(options, cancelledPayload);
    bus?.emit("cancel", { phase: "before_provider", turnIndex });
    if (hardSteer) {
      bus?.emit("steer.applied", { mode: "hard", text: hardSteer.text, id: hardSteer.id });
    }
    bus?.emit("run.end", {
      success: false,
      cancelled: true,
      turns: 0,
      hard_steer: hardSteer !== undefined,
    });
    await emitCancelledEnd(options, undefined);
    return {
      messages,
      finalText: "",
      success: false,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      usage: emptyTokenUsage(),
      cancelled: true,
      ...(hardSteer ? { hardSteerText: hardSteer.text } : {}),
    };
  }

  const progress = await runSegments(messages, options, {
    maxTurns,
    repairTurns: verifyRepairTurns,
    repeatToolLimit,
    toolCollector,
  });
  await publishCheckpoint(options, { phase: "turn_complete", messages });

  const hardSteer = progress.cancelled ? options.steerMailbox?.takeHard() : undefined;
  if (progress.cancelled && !hardSteer) {
    discardFollowUpsOnAbort(options, "abort");
  }
  const success = progress.cancelled
    ? false
    : progress.doneContract
      ? progress.doneContract.passed
      : true;
  const outcome = resolveTurnOutcome({
    cancelled: progress.cancelled === true,
    success,
  });
  const turnEndPayload = {
    turnIndex,
    prompt: userPrompt,
    message: progress.finalText.length > 0 ? { content: progress.finalText } : null,
    toolResults: progress.toolResults,
    outcome,
    ...(outcome === "cancelled" ? { error_class: "abort" } : {}),
  };
  await emitTurnEnd(options, turnEndPayload);
  if (outcome === "cancelled") {
    bus?.emit("cancel", { phase: "turn", turnIndex });
  }
  if (hardSteer) {
    bus?.emit("steer.applied", { mode: "hard", text: hardSteer.text, id: hardSteer.id });
  }
  bus?.emit("run.end", {
    success,
    cancelled: progress.cancelled === true,
    turns: progress.turns,
    toolCalls: progress.toolCalls,
    hard_steer: hardSteer !== undefined,
  });
  await options.host.emit("agent_end", {
    doneContract: progress.doneContract,
    success,
    cancelled: progress.cancelled === true,
  });

  return {
    messages,
    finalText: progress.finalText,
    doneContract: progress.doneContract,
    success,
    turns: progress.turns,
    toolCalls: progress.toolCalls,
    toolErrors: progress.toolErrors,
    usage: sumTokenUsage(progress.usages),
    cancelled: progress.cancelled,
    ...(hardSteer ? { hardSteerText: hardSteer.text } : {}),
  };
}

/** 1-based: count prior user messages, then +1 for the current prompt. */
export function deriveTurnIndex(priorMessages?: readonly ChatMessage[]): number {
  if (!priorMessages || priorMessages.length === 0) {
    return 1;
  }
  let users = 0;
  for (const message of priorMessages) {
    if (message.role === "user") {
      users += 1;
    }
  }
  return users + 1;
}

function resolveTurnOutcome(input: Readonly<{ cancelled: boolean; success: boolean }>): TurnEndOutcome {
  if (input.cancelled) return "cancelled";
  if (!input.success) return "error";
  return "success";
}

async function emitTurnEnd(options: AgentLoopOptions, payload: TurnEndPayload): Promise<void> {
  options.runtimeEvents?.emit("turn.end", { ...payload });
  await options.host.emit("turn_end", payload);
}

function buildMessages(input: Readonly<{
  userPrompt: string;
  systemPrompt: string;
  injectedContext: string;
  priorMessages?: readonly ChatMessage[];
  maxSessionMessages: number;
}>): ChatMessage[] {
  const prior = input.priorMessages ?? [];
  let messages: ChatMessage[];
  if (prior.length === 0) {
    messages = [
      { role: "system", content: input.systemPrompt },
      ...(input.injectedContext.length > 0
        ? [{ role: "system" as const, content: input.injectedContext }]
        : []),
      { role: "user", content: input.userPrompt },
    ];
  } else {
    messages = [...prior];
    // Keep the first system prompt stable; refresh only when prior has no system.
    if (!messages.some((message) => message.role === "system")) {
      messages.unshift({ role: "system", content: input.systemPrompt });
    }
    if (input.injectedContext.length > 0) {
      messages.push({ role: "system", content: input.injectedContext });
    }
    messages.push({ role: "user", content: input.userPrompt });
  }
  assertMessageBudget(messages, input.maxSessionMessages);
  return messages;
}

function collectTurnStartContext(results: readonly unknown[]): string {
  const parts: string[] = [];
  for (const result of results) {
    if (typeof result === "string" && result.trim().length > 0) {
      parts.push(result.trim());
      continue;
    }
    const record = asRecord(result);
    if (typeof record?.context === "string" && record.context.trim().length > 0) {
      parts.push(record.context.trim());
    }
  }
  return parts.join("\n\n");
}

async function emitCancelledEnd(options: AgentLoopOptions, doneContract: DoneContractResult | undefined): Promise<void> {
  await options.host.emit("agent_end", {
    doneContract,
    success: false,
    cancelled: true,
  });
}

async function runSegments(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  budget: Readonly<{
    maxTurns: number;
    repairTurns: number;
    repeatToolLimit: number;
    toolCollector: TurnToolCollector;
  }>,
): Promise<LoopProgress> {
  const guard = createRepeatToolGuard(budget.repeatToolLimit);
  const primary = await runUntilIdle(messages, options, budget.maxTurns, guard, budget.toolCollector);
  if (primary.cancelled || !options.doneContract) {
    return primary;
  }
  const firstCheck = await runDoneContract(options.doneContract);
  const repairBudget = Math.min(budget.repairTurns, budget.maxTurns - primary.turns);
  if (firstCheck.passed || repairBudget <= 0) {
    return { ...primary, doneContract: firstCheck };
  }
  messages.push({ role: "user", content: formatDoneContractFeedback(firstCheck) });
  // Fresh guard for repair segment so verify feedback is not blocked by prior streaks.
  const repairGuard = createRepeatToolGuard(budget.repeatToolLimit);
  const repair = await runUntilIdle(messages, options, repairBudget, repairGuard, budget.toolCollector);
  return {
    turns: primary.turns + repair.turns,
    finalText: repair.finalText || primary.finalText,
    toolCalls: primary.toolCalls + repair.toolCalls,
    toolErrors: primary.toolErrors + repair.toolErrors,
    usages: [...primary.usages, ...repair.usages],
    cancelled: repair.cancelled,
    toolResults: budget.toolCollector.results,
    doneContract: repair.cancelled ? firstCheck : await runDoneContract(options.doneContract),
  };
}

async function runUntilIdle(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  maxTurns: number,
  guard: RepeatToolGuard,
  toolCollector: TurnToolCollector,
): Promise<SegmentResult> {
  let finalText = "";
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const usages: TokenUsage[] = [];
  /** When turnSnapshot=false, reuse one frozen snapshot for the whole segment. */
  let stickySnapshot: TurnSnapshot | undefined;
  for (; turns < maxTurns; turns += 1) {
    if (options.signal?.aborted) {
      return {
        turns,
        finalText,
        toolCalls,
        toolErrors,
        usages,
        cancelled: true,
        toolResults: toolCollector.results,
      };
    }
    const snapshot = resolveProviderSnapshot(options, stickySnapshot);
    if (options.turnSnapshot === false) {
      stickySnapshot = snapshot;
    }
    options.onTurnSnapshot?.(snapshot);
    let completion: ChatCompletionResponse;
    try {
      await publishCheckpoint(options, { phase: "awaiting_provider", messages });
      completion = await requestCompletion(messages, options, snapshot);
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        return {
          turns,
          finalText,
          toolCalls,
          toolErrors,
          usages,
          cancelled: true,
          toolResults: toolCollector.results,
        };
      }
      throw error;
    }
    const usage = completion.usage ?? emptyTokenUsage();
    usages.push(usage);

    if (completion.content) {
      options.onAssistantText?.(completion.content);
      // Non-stream complete path: surface final text as a single delta for event consumers.
      if (!snapshot.client.completeStream) {
        options.runtimeEvents?.emit("text.delta", { text: completion.content });
      }
      finalText = completion.content;
    }

    if (completion.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: completion.content });
      await publishCheckpoint(options, { phase: "turn_complete", messages });
      turns += 1;
      // Soft steer at provider completion boundary (not mid-stream inject).
      if (applySoftSteers(messages, options)) {
        continue;
      }
      // Follow-up only when soft is empty and the loop would otherwise end.
      if (applyFollowUp(messages, options)) {
        continue;
      }
      break;
    }

    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });
    await publishCheckpoint(options, {
      phase: "tool_batch_running",
      messages,
      pendingTools: completion.toolCalls.map(({ id, name }) => ({ id, name })),
    });

    const metrics = await appendToolResults(messages, options, completion.toolCalls, guard, toolCollector);
    toolCalls += metrics.calls;
    toolErrors += metrics.errors;
    if (metrics.cancelled) {
      return {
        turns: turns + 1,
        finalText,
        toolCalls,
        toolErrors,
        usages,
        cancelled: true,
        toolResults: toolCollector.results,
      };
    }
    // Soft steer after tool batch — safe boundary.
    applySoftSteers(messages, options);
  }
  return {
    turns,
    finalText,
    toolCalls,
    toolErrors,
    usages,
    toolResults: toolCollector.results,
  };
}

/** @returns true when at least one soft steer was applied (caller should continue the loop). */
function applySoftSteers(messages: ChatMessage[], options: AgentLoopOptions): boolean {
  const soft = options.steerMailbox?.drainSoft() ?? [];
  if (soft.length === 0) return false;
  for (const request of soft) {
    messages.push({
      role: "user",
      content: formatSteerUserMessage(request.text, "soft"),
    });
    options.runtimeEvents?.emit("steer.applied", {
      mode: "soft",
      text: request.text,
      id: request.id,
    });
  }
  emitQueueUpdated(options);
  return true;
}

/**
 * Drain one follow-up at natural end (no tool calls + soft empty).
 * @returns true when a follow-up was applied (caller should continue the loop).
 */
function applyFollowUp(messages: ChatMessage[], options: AgentLoopOptions): boolean {
  // Soft already drained by caller; hard pending means abort/steer owns the path.
  if (options.steerMailbox?.hasHard()) return false;
  const next = options.steerMailbox?.takeFollowUp();
  if (!next) return false;
  messages.push({
    role: "user",
    content: formatFollowUpUserMessage(next.text),
  });
  options.runtimeEvents?.emit("follow_up.applied", {
    text: next.text,
    id: next.id,
  });
  emitQueueUpdated(options);
  return true;
}

function discardFollowUpsOnAbort(
  options: AgentLoopOptions,
  reason: "abort",
): void {
  const discarded = options.steerMailbox?.clearFollowUp() ?? [];
  for (const item of discarded) {
    options.runtimeEvents?.emit("follow_up.discarded", {
      text: item.text,
      id: item.id,
      reason,
    });
  }
  if (discarded.length > 0) {
    emitQueueUpdated(options);
  }
}

function emitQueueUpdated(options: AgentLoopOptions): void {
  const mailbox = options.steerMailbox;
  if (!mailbox) return;
  options.runtimeEvents?.emit("queue_updated", {
    soft: mailbox.list().filter((item) => item.mode === "soft").length,
    hard: mailbox.list().filter((item) => item.mode === "hard").length,
    follow_up: mailbox.listFollowUp().length,
  });
}

async function requestCompletion(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  snapshot: TurnSnapshot,
): Promise<ChatCompletionResponse> {
  const { getGlobalTracer, classifyUnknownError } = await import("./perf/index.ts");
  const tracer = getGlobalTracer();
  const api = snapshot.providerApi;
  const registration = resolveRegistration(options, snapshot);
  const cached = getCachedProviderTools(api, snapshot.tools);
  const maxTokens = snapshot.maxTokens
    ?? registration?.models.find((model) => model.id === snapshot.modelId)?.maxTokens
    ?? registration?.models[0]?.maxTokens;
  const toolChoice = snapshot.toolChoice ?? registration?.toolChoice;
  const toolChoiceScope = snapshot.toolChoiceScope ?? registration?.toolChoiceScope;
  const requestSpan = tracer?.start("provider.request", {
    attrs: {
      model: snapshot.modelId,
      stream: Boolean(snapshot.client.completeStream),
      max_tokens: maxTokens ?? null,
      tool_choice: toolChoice ?? "unset",
      tool_schema_cache: cached.cache,
      snapshot_id: snapshot.id,
    },
  });
  options.runtimeEvents?.emit("provider.request", {
    model: snapshot.modelId,
    stream: Boolean(snapshot.client.completeStream),
    snapshot_id: snapshot.id,
  });
  const providerTools = cached.tools;
  const providerPayload = {
    model: snapshot.modelId,
    messages,
    tools: providerTools,
    parallelToolCalls: snapshot.parallelToolCalls,
    maxTokens,
    toolChoice,
    toolChoiceScope,
  };
  try {
    const enhanced = await options.host.emit("before_provider_request", { payload: providerPayload });
    const request = asRecord(enhanced.at(-1)) ?? providerPayload;
    const requestedModel = typeof request.model === "string" ? request.model : snapshot.modelId;
    const requestMessages = (Array.isArray(request.messages) ? request.messages : messages) as ChatMessage[];
    const requestTools = Array.isArray(request.tools) ? request.tools as typeof providerTools : providerTools;
    const parallelToolCalls = typeof request.parallelToolCalls === "boolean"
      ? request.parallelToolCalls
      : snapshot.parallelToolCalls;
    const requestMaxTokens = typeof request.maxTokens === "number" ? request.maxTokens : maxTokens;
    const requestToolChoice = (typeof request.toolChoice === "string"
      ? request.toolChoice
      : toolChoice) as ProviderToolChoice | undefined;
    const requestToolChoiceScope = (typeof request.toolChoiceScope === "string"
      ? request.toolChoiceScope
      : toolChoiceScope) as ProviderToolChoiceScope | undefined;

    const completionRequest = {
      model: requestedModel,
      messages: requestMessages,
      tools: requestTools,
      parallelToolCalls,
      thinkingLevel: options.host.getThinkingLevel(),
      maxTokens: requestMaxTokens,
      toolChoice: requestToolChoice,
      toolChoiceScope: requestToolChoiceScope,
    };

    let completion: ChatCompletionResponse;
    if (snapshot.client.completeStream) {
      completion = await consumeStream(snapshot.client, completionRequest, options, requestSpan?.span_id);
    } else {
      const completionSpan = tracer?.start("provider.completion", { parentId: requestSpan?.span_id });
      try {
        completion = await snapshot.client.complete(completionRequest, { signal: options.signal });
        tracer?.end(completionSpan, "success", { usage: completion.usage ?? emptyTokenUsage() });
      } catch (error) {
        const classified = classifyUnknownError(error);
        tracer?.end(completionSpan, classified.outcome, { error_class: classified.error_class });
        throw error;
      }
    }

    await options.host.emit("provider_response", {
      providerApi: snapshot.providerApi,
      model: requestedModel,
      usage: completion.usage ?? emptyTokenUsage(),
    });
    tracer?.end(requestSpan, "success", {
      usage: completion.usage ?? emptyTokenUsage(),
      attrs: {
        tool_calls: completion.toolCalls.length,
        tool_schema_cache: cached.cache,
        max_tokens: requestMaxTokens ?? null,
        snapshot_id: snapshot.id,
      },
    });
    return completion;
  } catch (error) {
    const classified = classifyUnknownError(error);
    tracer?.end(requestSpan, classified.outcome, { error_class: classified.error_class });
    throw error;
  }
}

/**
 * Freeze live config for this provider request.
 * Live changes after this returns do not mutate the in-flight snapshot.
 */
function resolveProviderSnapshot(
  options: AgentLoopOptions,
  sticky: TurnSnapshot | undefined,
): TurnSnapshot {
  if (sticky) return sticky;
  const live = options.getLiveConfig?.() ?? liveConfigFromOptions(options);
  return createTurnSnapshot(live);
}

function liveConfigFromOptions(options: AgentLoopOptions): LiveConfigView {
  return {
    model: {
      provider: options.providerName ?? options.host.model?.provider ?? "unknown",
      id: options.model,
    },
    modelId: options.model,
    providerName: options.providerName ?? options.host.model?.provider,
    providerApi: options.providerApi ?? "unknown",
    client: options.client,
    parallelToolCalls: options.parallelToolCalls !== false,
    tools: options.host.listTools(),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    ...(options.toolChoiceScope !== undefined ? { toolChoiceScope: options.toolChoiceScope } : {}),
  };
}

function resolveRegistration(options: AgentLoopOptions, snapshot?: TurnSnapshot) {
  const name = snapshot?.providerName ?? options.providerName ?? options.host.model?.provider;
  if (!name) return undefined;
  return options.host.getProvider(name);
}

async function consumeStream(
  client: LlmClient,
  request: Parameters<LlmClient["complete"]>[0],
  options: AgentLoopOptions,
  parentSpanId?: string,
): Promise<ChatCompletionResponse> {
  if (!client.completeStream) {
    return client.complete(request, { signal: options.signal });
  }
  const { getGlobalTracer, classifyUnknownError } = await import("./perf/index.ts");
  const tracer = getGlobalTracer();
  const completionSpan = tracer?.start("provider.completion", { parentId: parentSpanId });
  let firstTokenSpan: ReturnType<NonNullable<typeof tracer>["start"]> | undefined = tracer?.start(
    "provider.first_token",
    { parentId: parentSpanId },
  );
  /** Independent of tracer so RuntimeEvent first_token still fires without a global tracer. */
  let firstTokenEmitted = false;
  let content = "";
  let toolCalls: ChatToolCall[] = [];
  let usage: TokenUsage = emptyTokenUsage();
  let raw: unknown;
  let sawDelta = false;

  const markFirstToken = (via?: string) => {
    if (firstTokenEmitted) return;
    firstTokenEmitted = true;
    if (firstTokenSpan) {
      tracer?.end(firstTokenSpan, "success", via ? { attrs: { via } } : undefined);
      firstTokenSpan = undefined;
    }
    options.runtimeEvents?.emit("provider.first_token", via ? { via } : {});
  };

  try {
    for await (const event of client.completeStream(request, { signal: options.signal })) {
      if (event.type === "thinking_delta") {
        options.onThinkingDelta?.(event.text);
        options.runtimeEvents?.emit("thinking.delta", { text: event.text });
      } else if (event.type === "text_delta") {
        markFirstToken();
        sawDelta = true;
        options.onAssistantDelta?.(event.text);
        options.runtimeEvents?.emit("text.delta", { text: event.text });
        content += event.text;
      } else if (event.type === "tool_calls_done") {
        markFirstToken("tool_calls");
        toolCalls = [...event.toolCalls];
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "done") {
        if (!firstTokenEmitted) {
          markFirstToken("done");
        } else if (firstTokenSpan) {
          tracer?.end(firstTokenSpan, "success", { attrs: { via: "done" } });
          firstTokenSpan = undefined;
        }
        content = event.content;
        toolCalls = [...event.toolCalls];
        usage = event.usage;
        raw = event.raw;
        options.runtimeEvents?.emit("provider.done", { usage: event.usage });
      }
    }
    if (!sawDelta && content.length > 0) {
      options.onAssistantDelta?.(content);
    }
    if (firstTokenSpan) {
      tracer?.end(firstTokenSpan, "success", { attrs: { via: "empty" } });
    }
    tracer?.end(completionSpan, "success", { usage });
    return { content, toolCalls, usage, raw };
  } catch (error) {
    const classified = classifyUnknownError(error);
    if (firstTokenSpan) {
      tracer?.end(firstTokenSpan, classified.outcome, { error_class: classified.error_class });
    }
    tracer?.end(completionSpan, classified.outcome, { error_class: classified.error_class });
    throw error;
  }
}

async function appendToolResults(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  calls: readonly ChatToolCall[],
  guard: RepeatToolGuard,
  toolCollector: TurnToolCollector,
): Promise<{ calls: number; errors: number; cancelled?: boolean }> {
  if (options.signal?.aborted) {
    return { calls: 0, errors: 0, cancelled: true };
  }

  const { getGlobalTracer } = await import("./perf/index.ts");
  const tracer = getGlobalTracer();
  const batchSpan = tracer?.start("tool.batch", {
    attrs: { tools: calls.length, parallel: options.parallelToolCalls !== false },
  });

  // Consume fingerprints in declaration order so parallel batches still count consecutive dups.
  const blocked = new Map<number, string>();
  for (let index = 0; index < calls.length; index += 1) {
    const reason = guard.consume(calls[index]!);
    if (reason) blocked.set(index, reason);
  }

  const parallel = options.parallelToolCalls !== false;
  const results: ToolExecuteResult[] = new Array(calls.length);
  let errors = 0;

  if (!parallel || calls.length <= 1) {
    for (let index = 0; index < calls.length; index += 1) {
      if (options.signal?.aborted) {
        await appendInterruptedResults(messages, options, calls.slice(index), toolCollector);
        tracer?.end(batchSpan, "cancelled", { error_class: "abort", attrs: { tools: calls.length } });
        return { calls: index, errors: errors + calls.length - index, cancelled: true };
      }
      const call = calls[index]!;
      options.onToolStart?.(call);
      options.runtimeEvents?.emit("tool.call", {
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      });
      const blockReason = blocked.get(index);
      const result = blockReason
        ? blockedToolCallResult(blockReason)
        : await executeToolCall(options.host, call, options.signal);
      results[index] = result;
      if (result.isError === true) {
        errors += 1;
      }
      options.onToolEnd?.(call, result);
      appendToolResult(messages, call, result);
      recordTurnToolResult(toolCollector, call, result, options.runtimeEvents);
      await publishCheckpoint(options, {
        phase: "tool_batch_running",
        messages,
        pendingTools: calls.slice(index + 1).map(({ id, name }) => ({ id, name })),
      });
    }
  } else {
    // Per-realpath serialization: different files may run concurrently; same realpath waits.
    const writeQueue = options.fileWriteQueue ?? new FileWriteQueue();

    await Promise.all(calls.map(async (call, index) => {
      if (options.signal?.aborted) {
        results[index] = {
          content: [{ type: "text", text: "tool cancelled: AbortSignal aborted" }],
          isError: true,
        };
        return;
      }

      const run = async (): Promise<ToolExecuteResult> => {
        options.onToolStart?.(call);
        options.runtimeEvents?.emit("tool.call", {
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        });
        const blockReason = blocked.get(index);
        const result = blockReason
          ? blockedToolCallResult(blockReason)
          : await executeToolCall(options.host, call, options.signal);
        options.onToolEnd?.(call, result);
        return result;
      };

      if (WRITE_SERIAL_TOOLS.has(call.name)) {
        const filePath = typeof call.arguments.path === "string" ? String(call.arguments.path) : "";
        const queueKey = filePath.length > 0 ? filePath : `__anon_write_${call.id}`;
        results[index] = await writeQueue.run(queueKey, run);
        return;
      }

      // read / grep / glob / bash (and unknown non-write tools) run concurrently
      results[index] = await run();
    }));

    for (const result of results) {
      if (result?.isError === true) {
        errors += 1;
      }
    }
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      const result = results[index] ?? interruptedToolResult(call);
      appendToolResult(messages, call, result);
      recordTurnToolResult(toolCollector, call, result, options.runtimeEvents);
      await publishCheckpoint(options, {
        phase: "tool_batch_running",
        messages,
        pendingTools: calls.slice(index + 1).map(({ id, name }) => ({ id, name })),
      });
    }
  }

  const cancelled = options.signal?.aborted === true;
  tracer?.end(batchSpan, cancelled ? "cancelled" : "success", {
    attrs: { tools: calls.length, errors },
    ...(cancelled ? { error_class: "abort" } : {}),
  });
  return {
    calls: calls.length,
    errors,
    cancelled,
  };
}

/** Cap stored tool body in turn_end payload (full body still lives in session messages / tool_result hooks). */
const TURN_END_TOOL_CONTENT_MAX = 4_000;

function recordTurnToolResult(
  collector: TurnToolCollector,
  call: ChatToolCall,
  result: ToolExecuteResult,
  bus?: RuntimeEventEmitter,
): void {
  const raw = toolContentText(result.content);
  const content = raw.length > TURN_END_TOOL_CONTENT_MAX
    ? `${raw.slice(0, TURN_END_TOOL_CONTENT_MAX)}…[truncated]`
    : raw;
  collector.results.push({
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: result.isError === true,
  });
  const isError = result.isError === true;
  bus?.emit(isError ? "tool.error" : "tool.result", {
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError,
  });
}

type RepeatToolGuard = Readonly<{
  consume: (call: ChatToolCall) => string | undefined;
}>;

function createRepeatToolGuard(limit: number): RepeatToolGuard {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { consume: () => undefined };
  }
  const max = Math.floor(limit);
  let lastKey: string | undefined;
  let count = 0;
  return {
    consume(call) {
      const key = toolCallFingerprint(call);
      if (key === lastKey) {
        count += 1;
      } else {
        lastKey = key;
        count = 1;
      }
      if (count <= max) return undefined;
      return [
        `repeated tool blocked: ${call.name} identical args called ${count} times in a row (limit ${max}).`,
        "Change arguments, use a different tool, or answer the user without re-running the same call.",
      ].join(" ");
    },
  };
}

/** Exported for unit tests. */
export function toolCallFingerprint(call: Readonly<{ name: string; arguments: Record<string, unknown> }>): string {
  return `${call.name}\0${stableJson(call.arguments)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function blockedToolCallResult(reason: string): ToolExecuteResult {
  return {
    content: [{ type: "text", text: reason }],
    isError: true,
  };
}

function appendToolResult(messages: ChatMessage[], call: ChatToolCall, result: ToolExecuteResult): void {
  messages.push({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result.content.map((part) => part.text).join("\n"),
  });
}

async function appendInterruptedResults(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  calls: readonly ChatToolCall[],
  toolCollector: TurnToolCollector,
): Promise<void> {
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const result = interruptedToolResult(call);
    appendToolResult(messages, call, result);
    recordTurnToolResult(toolCollector, call, result, options.runtimeEvents);
    await publishCheckpoint(options, {
      phase: "tool_batch_running",
      messages,
      pendingTools: calls.slice(index + 1).map(({ id, name }) => ({ id, name })),
    });
  }
}

function interruptedToolResult(call: ChatToolCall): ToolExecuteResult {
  return {
    content: [{
      type: "text",
      text: `tool interrupted: completion unknown for ${call.name}; inspect workspace state before retrying`,
    }],
    isError: true,
  };
}

async function publishCheckpoint(
  options: AgentLoopOptions,
  checkpoint: AgentLoopCheckpoint,
): Promise<void> {
  await options.onCheckpoint?.({
    ...checkpoint,
    messages: checkpoint.messages.map((message) => ({
      ...message,
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) } : {}),
    })),
  });
}

async function executeToolCall(
  host: ExtensionHost,
  call: ChatToolCall,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  if (signal?.aborted) {
    return {
      content: [{ type: "text", text: "tool cancelled: AbortSignal aborted before start" }],
      isError: true,
    };
  }
  const tool = host.getTool(call.name);
  const args = tool ? stripUnknownToolArgs(tool, call.arguments) : call.arguments;
  const normalizedCall: ChatToolCall = args === call.arguments ? call : { ...call, arguments: args };
  const toolCallEvent: ToolCallEvent = { toolName: normalizedCall.name, input: normalizedCall.arguments };
  const hookResults = await host.emit("tool_call", {
    ...toolCallEvent,
    call: { id: normalizedCall.id, name: normalizedCall.name, args: normalizedCall.arguments },
  });
  const blocked = blockedToolResult(normalizedCall, hookResults);
  if (blocked) {
    return emitToolResult(host, normalizedCall, blocked);
  }
  const result = tool
    ? await runTool(tool, normalizedCall, signal)
    : { content: [{ type: "text", text: `tool not found: ${normalizedCall.name}` }], isError: true } as ToolExecuteResult;
  return emitToolResult(host, normalizedCall, result);
}

/**
 * Tolerant input: drop schema-unknown keys before execute (models often add
 * commentary fields). Does not loosen required/typed fields — those stay enforced
 * by tool logic.
 */
export function stripUnknownToolArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object") {
    return args;
  }
  const allowed = new Set(Object.keys(properties));
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (allowed.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : args;
}

function blockedToolResult(call: ChatToolCall, hookResults: readonly unknown[]): ToolExecuteResult | undefined {
  for (const hook of hookResults) {
    const record = asRecord(hook);
    if (record?.block === true) {
      return {
        content: [{ type: "text", text: String(record.reason ?? `blocked ${call.name}`) }],
        isError: true,
      };
    }
  }
  return undefined;
}

async function runTool(
  tool: ToolDefinition,
  call: ChatToolCall,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  try {
    return await tool.execute(call.id, call.arguments, { signal });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return {
        content: [{ type: "text", text: "tool cancelled: AbortSignal aborted during execution" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

async function emitToolResult(
  host: ExtensionHost,
  call: ChatToolCall,
  result: ToolExecuteResult,
): Promise<ToolExecuteResult> {
  const processed = await host.emit("tool_result", {
    call: { id: call.id, name: call.name, args: call.arguments },
    result: {
      content: result.content,
      isError: result.isError,
      metadata: result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined,
    },
  });
  const originalText = toolContentText(result.content);
  for (const item of processed) {
    const record = asRecord(item);
    if (record && Array.isArray(record.content)) {
      const nextContent = record.content as ToolExecuteResult["content"];
      const nextText = toolContentText(nextContent);
      // Refuse empty hook overwrite when the tool actually returned body
      // (guards mis-parsed evolve denoise payloads).
      if (nextText.length === 0 && originalText.length > 0) {
        continue;
      }
      return {
        content: nextContent,
        isError: record.isError === true ? true : result.isError,
        details: result.details,
      };
    }
  }
  return result;
}

function toolContentText(content: ToolExecuteResult["content"] | undefined): string {
  if (!content || content.length === 0) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError";
}
