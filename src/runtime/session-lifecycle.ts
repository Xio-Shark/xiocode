import { MergeGate } from "../../extensions/xio-sandbox/src/index.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { ContextCompactionController, SessionHistory } from "./context-compaction.ts";
import { ExtensionHost } from "./extension-host.ts";
import { createStdoutSessionUiSink } from "./session-ui.ts";
import { sumTokenUsage } from "./usage.ts";

import type { XioVerifyConfig } from "../cli/config-parser.ts";
import type { PreparedSession } from "./session.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { WorktreeDisposition } from "../../extensions/xio-sandbox/src/merge-gate.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { AgentLoopCheckpoint } from "./agent-loop.ts";
import type { ChatMessage, LlmClient, ModelInfo, TokenUsage } from "./types.ts";

export function createSessionHost(
  model: ModelInfo,
  sink: SessionUiSink = createStdoutSessionUiSink(),
  initialThinkingLevel?: import("./types.ts").ThinkingLevel,
): ExtensionHost {
  return new ExtensionHost({
    initialModel: model,
    initialThinkingLevel,
    ui: {
      notify(message, level) {
        sink.notify?.(message, level);
      },
      setStatus(key, text) {
        sink.setStatus?.(key, text);
      },
      setWidget(key, content, options) {
        sink.setWidget?.(key, content, options);
      },
    },
  });
}

export function registerMergeCommand(
  host: ExtensionHost,
  mergeGate: MergeGate,
  ask: (question: string) => Promise<boolean>,
  sink: SessionUiSink = createStdoutSessionUiSink(),
): void {
  host.registerCommand("merge", {
    description: "Show worktree diff and merge into the main tree after confirmation.",
    handler: async () => {
      const result = await mergeGate.promptMerge(ask, (message) => sink.notify?.(message));
      if ("skipped" in result) return "merge skipped";
      return result.ok ? result.summary : result.error;
    },
  });
}

export function registerRollbackCommand(
  host: ExtensionHost,
  mergeGate: MergeGate | undefined,
  ask: (question: string) => Promise<boolean>,
  sink: SessionUiSink = createStdoutSessionUiSink(),
): void {
  host.registerCommand("rollback", {
    description: "Discard session worktree changes and restore its starting commit.",
    handler: async (args) => {
      if (!mergeGate) {
        throw new Error("rollback requires an active git worktree sandbox");
      }
      if (String(args ?? "").trim() === "turn") {
        const result = await mergeGate.promptRollbackTurn(ask, (message) => sink.notify?.(message));
        return result.summary;
      }
      const result = await mergeGate.promptRollback(ask, (message) => sink.notify?.(message));
      return result.summary;
    },
  });
}

export function createPromptRunner(options: Readonly<{
  host: ExtensionHost;
  /** Prefer getters so /model hot-switch rebuilds take effect next turn. */
  client?: LlmClient;
  model?: ModelInfo;
  providerApi?: string;
  getClient?: () => LlmClient;
  getModel?: () => ModelInfo;
  getProviderApi?: () => string;
  maxTurns?: number;
  /** Identical tool+args consecutive cap; 0 disables. Default from agent-loop. */
  repeatToolLimit?: number;
  doneContract?: DoneContract;
  verify: XioVerifyConfig;
  parallelToolCalls?: boolean;
  getParallelToolCalls?: () => boolean;
  maxSessionMessages?: number;
  getSignal?: () => AbortSignal | undefined;
  beforePrompt?: () => Promise<unknown> | unknown;
  sink?: SessionUiSink;
  history?: SessionHistory;
  contextCompaction?: ContextCompactionController;
  initialMessages?: readonly ChatMessage[];
  onMessagesChanged?: (messages: readonly ChatMessage[]) => Promise<void> | void;
  onCheckpoint?: (checkpoint: AgentLoopCheckpoint) => Promise<void> | void;
  /** Optional current run id for post-failure private-regress nudge. */
  getRunId?: () => Promise<string | undefined> | string | undefined;
}>): PreparedSession["runPrompt"] {
  const sink = options.sink ?? createStdoutSessionUiSink();
  const history = options.history ?? new SessionHistory({
    initialMessages: options.initialMessages,
    persist: options.onMessagesChanged,
  });
  const getClient = options.getClient ?? (() => {
    if (!options.client) throw new Error("createPromptRunner requires client or getClient");
    return options.client;
  });
  const getModel = options.getModel ?? (() => {
    if (!options.model) throw new Error("createPromptRunner requires model or getModel");
    return options.model;
  });
  const getProviderApi = options.getProviderApi ?? (() => {
    if (!options.providerApi) throw new Error("createPromptRunner requires providerApi or getProviderApi");
    return options.providerApi;
  });

  return async (prompt) => {
    await options.beforePrompt?.();
    const signal = options.getSignal?.();
    let compactionUsage: TokenUsage | undefined;
    if (options.contextCompaction?.needsAutomaticCompaction()) {
      const compacted = await options.contextCompaction.compact("automatic", undefined, signal);
      if (compacted.compacted) compactionUsage = compacted.usage;
    }
    const model = getModel();
    const result = await runAgentLoop(prompt, {
      host: options.host,
      client: getClient(),
      model: model.id,
      providerApi: getProviderApi(),
      maxTurns: options.maxTurns,
      repeatToolLimit: options.repeatToolLimit,
      doneContract: options.doneContract,
      verifyRepairTurns: options.verify.repairTurns,
      parallelToolCalls: options.getParallelToolCalls?.() ?? options.parallelToolCalls,
      priorMessages: history.getMessages(),
      maxSessionMessages: options.maxSessionMessages,
      signal,
      onAssistantDelta: (text) => sink.onAssistantDelta?.(text),
      onAssistantText: (text) => sink.onAssistantText?.(text),
      onThinkingDelta: (text) => sink.onThinkingDelta?.(text),
      onToolStart: (call) => sink.onToolStart?.(call),
      onToolEnd: (call, toolResult) => sink.onToolEnd?.(call, toolResult),
      onCheckpoint: options.onCheckpoint,
    });
    await history.replace(result.messages);
    if (result.cancelled) {
      sink.onCancelled?.();
    }
    if (result.doneContract && !result.doneContract.passed) {
      sink.onDoneContract?.(result.doneContract.summary);
    }
    if (!result.success && !result.cancelled) {
      const runId = await options.getRunId?.();
      sink.notify?.(formatRegressCaptureHint(runId), "info");
    }
    return {
      text: result.finalText,
      success: result.success,
      turns: result.turns,
      toolCalls: result.toolCalls,
      toolErrors: result.toolErrors,
      usage: compactionUsage ? sumTokenUsage([compactionUsage, result.usage]) : result.usage,
      cancelled: result.cancelled,
    };
  };
}

/** Single-line post-failure nudge toward private regression capture (no auto-prompt). */
export function formatRegressCaptureHint(runId?: string): string {
  const base = "hint: capture private regression — /regress  or  xio regress capture --last";
  if (!runId || runId === "none") return base;
  return `${base}  (run=${runId})`;
}

export function createSessionCloser(options: Readonly<{
  host: ExtensionHost;
  mergeGate?: MergeGate;
  ask: (question: string) => Promise<boolean>;
  retainOnReject: boolean;
  sink?: SessionUiSink;
  onFinalized?: (disposition: WorktreeDisposition) => Promise<void> | void;
}>): PreparedSession["close"] {
  const sink = options.sink ?? createStdoutSessionUiSink();
  return async () => {
    await options.host.emit("session_end", {});
    if (options.mergeGate) {
      const disposition = await options.mergeGate.finalizeSession(
        options.ask,
        { retainOnReject: options.retainOnReject },
        (message) => sink.notify?.(message),
        options.onFinalized,
      );
      void disposition;
    }
  };
}
