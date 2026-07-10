import { stdout as output } from "node:process";

import { MergeGate } from "../../extensions/xio-sandbox/src/index.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { ExtensionHost } from "./extension-host.ts";

import type { XioVerifyConfig } from "../cli/config-parser.ts";
import type { PreparedSession } from "./session.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { LlmClient, ModelInfo } from "./types.ts";

export function createSessionHost(model: ModelInfo): ExtensionHost {
  return new ExtensionHost({
    initialModel: model,
    ui: {
      notify(message, level) {
        output.write(`${level ? `[${level}] ` : ""}${message}\n`);
      },
      setStatus(key, text) {
        if (text) output.write(`[status:${key}] ${text}\n`);
      },
      setWidget(_key, content) {
        if (content && content.length > 0) output.write(`${content.join("\n")}\n`);
      },
    },
  });
}

export function registerMergeCommand(
  host: ExtensionHost,
  mergeGate: MergeGate,
  ask: (question: string) => Promise<boolean>,
): void {
  host.registerCommand("merge", {
    description: "Show worktree diff and merge into the main tree after confirmation.",
    handler: async () => {
      const result = await mergeGate.promptMerge(ask, (message) => output.write(`${message}\n`));
      if ("skipped" in result) return "merge skipped";
      return result.ok ? result.summary : result.error;
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
}>): PreparedSession["runPrompt"] {
  return async (prompt) => {
    const result = await runAgentLoop(prompt, {
      host: options.host,
      client: options.client,
      model: options.model.id,
      providerApi: options.providerApi,
      maxTurns: options.maxTurns,
      doneContract: options.doneContract,
      verifyRepairTurns: options.verify.repairTurns,
      onAssistantText: (text) => output.write(`\n${text}\n`),
      onToolStart: (call) => output.write(`\n→ ${call.name}(${JSON.stringify(call.arguments)})\n`),
    });
    if (result.doneContract && !result.doneContract.passed) {
      output.write(`\n${result.doneContract.summary}\n`);
    }
    return {
      text: result.finalText,
      success: result.success,
      turns: result.turns,
      toolCalls: result.toolCalls,
      toolErrors: result.toolErrors,
      usage: result.usage,
    };
  };
}

export function createSessionCloser(options: Readonly<{
  host: ExtensionHost;
  mergeGate?: MergeGate;
  ask: (question: string) => Promise<boolean>;
  retainOnReject: boolean;
}>): PreparedSession["close"] {
  return async () => {
    await options.host.emit("session_end", {});
    if (options.mergeGate) {
      await options.mergeGate.finalizeSession(
        options.ask,
        { retainOnReject: options.retainOnReject },
        (message) => output.write(`${message}\n`),
      );
    }
  };
}
