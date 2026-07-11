import { MergeGate } from "../../extensions/xio-sandbox/src/index.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { ExtensionHost } from "./extension-host.ts";
import { createStdoutSessionUiSink } from "./session-ui.ts";

import type { XioVerifyConfig } from "../cli/config-parser.ts";
import type { PreparedSession } from "./session.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { ChatMessage, LlmClient, ModelInfo } from "./types.ts";

export function createSessionHost(model: ModelInfo, sink: SessionUiSink = createStdoutSessionUiSink()): ExtensionHost {
  return new ExtensionHost({
    initialModel: model,
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
  client: LlmClient;
  model: ModelInfo;
  providerApi: string;
  maxTurns?: number;
  doneContract?: DoneContract;
  verify: XioVerifyConfig;
  parallelToolCalls?: boolean;
  maxSessionMessages?: number;
  getSignal?: () => AbortSignal | undefined;
  beforePrompt?: () => Promise<void> | void;
  sink?: SessionUiSink;
  initialMessages?: readonly ChatMessage[];
  onMessagesChanged?: (messages: readonly ChatMessage[]) => Promise<void> | void;
}>): PreparedSession["runPrompt"] {
  let sessionMessages = options.initialMessages ? [...options.initialMessages] : undefined;
  const sink = options.sink ?? createStdoutSessionUiSink();

  return async (prompt) => {
    await options.beforePrompt?.();
    const result = await runAgentLoop(prompt, {
      host: options.host,
      client: options.client,
      model: options.model.id,
      providerApi: options.providerApi,
      maxTurns: options.maxTurns,
      doneContract: options.doneContract,
      verifyRepairTurns: options.verify.repairTurns,
      parallelToolCalls: options.parallelToolCalls,
      priorMessages: sessionMessages,
      maxSessionMessages: options.maxSessionMessages,
      signal: options.getSignal?.(),
      onAssistantDelta: (text) => sink.onAssistantDelta?.(text),
      onAssistantText: (text) => sink.onAssistantText?.(text),
      onToolStart: (call) => sink.onToolStart?.(call),
      onToolEnd: (call, toolResult) => sink.onToolEnd?.(call, toolResult),
    });
    sessionMessages = [...result.messages];
    await options.onMessagesChanged?.(sessionMessages);
    if (result.cancelled) {
      sink.onCancelled?.();
    }
    if (result.doneContract && !result.doneContract.passed) {
      sink.onDoneContract?.(result.doneContract.summary);
    }
    return {
      text: result.finalText,
      success: result.success,
      turns: result.turns,
      toolCalls: result.toolCalls,
      toolErrors: result.toolErrors,
      usage: result.usage,
      cancelled: result.cancelled,
    };
  };
}

export function createSessionCloser(options: Readonly<{
  host: ExtensionHost;
  mergeGate?: MergeGate;
  ask: (question: string) => Promise<boolean>;
  retainOnReject: boolean;
  sink?: SessionUiSink;
}>): PreparedSession["close"] {
  const sink = options.sink ?? createStdoutSessionUiSink();
  return async () => {
    await options.host.emit("session_end", {});
    if (options.mergeGate) {
      await options.mergeGate.finalizeSession(
        options.ask,
        { retainOnReject: options.retainOnReject },
        (message) => sink.notify?.(message),
      );
    }
  };
}
