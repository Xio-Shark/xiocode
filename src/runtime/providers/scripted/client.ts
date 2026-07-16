import { emptyTokenUsage } from "../../usage.ts";

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatToolCall,
  LlmClient,
  LlmCompleteOptions,
  StreamEvent,
  TokenUsage,
} from "../../types.ts";
import type { AgentTapeV1, ScriptedBarrierWaiter, TapeStep, TapeTurn } from "./types.ts";
import { AgentTapeError, parseAgentTape } from "./load-tape.ts";

export type ScriptedLlmClientOptions = Readonly<{
  tape: AgentTapeV1 | unknown;
  /** Optional await at barrier steps (tests can release barriers). */
  onBarrier?: ScriptedBarrierWaiter;
  /** Override sleep for hang steps (tests inject fake clock). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}>;

export type ScriptedLlmClient = LlmClient & Readonly<{
  /** How many provider turns were consumed. */
  consumedTurns: () => number;
  /** Barriers hit so far (ids). */
  barriersSeen: () => readonly string[];
  tapeName: string;
}>;

/**
 * Faux provider driven by a versioned agent tape.
 * Each `complete` / `completeStream` call consumes the next tape turn.
 */
export function createScriptedLlmClient(options: ScriptedLlmClientOptions): ScriptedLlmClient {
  const tape = parseAgentTape(options.tape);
  const sleep = options.sleep ?? defaultSleep;
  let turnIndex = 0;
  const barriers: string[] = [];

  async function takeTurn(signal?: AbortSignal): Promise<TurnPlayback> {
    if (turnIndex >= tape.turns.length) {
      throw new AgentTapeError(
        `scripted tape "${tape.name}" exhausted: requested turn ${turnIndex + 1}, have ${tape.turns.length}`,
      );
    }
    const turn = tape.turns[turnIndex]!;
    turnIndex += 1;
    return playTurn(turn, {
      sleep,
      onBarrier: options.onBarrier,
      barriers,
      signal,
    });
  }

  async function complete(
    _request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): Promise<ChatCompletionResponse> {
    const played = await takeTurn(completeOptions?.signal);
    return {
      content: played.content,
      toolCalls: played.toolCalls,
      usage: played.usage,
      raw: { tape: tape.name, turn: turnIndex - 1 },
    };
  }

  async function* completeStream(
    _request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): AsyncIterable<StreamEvent> {
    const played = await takeTurn(completeOptions?.signal);
    for (const event of played.streamEvents) {
      if (completeOptions?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      yield event;
    }
  }

  return {
    complete,
    completeStream,
    consumedTurns: () => turnIndex,
    barriersSeen: () => barriers.slice(),
    tapeName: tape.name,
  };
}

type TurnPlayback = Readonly<{
  content: string;
  toolCalls: readonly ChatToolCall[];
  usage: TokenUsage;
  streamEvents: readonly StreamEvent[];
}>;

async function playTurn(
  turn: TapeTurn,
  ctx: Readonly<{
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    onBarrier?: ScriptedBarrierWaiter;
    barriers: string[];
    signal?: AbortSignal;
  }>,
): Promise<TurnPlayback> {
  let content = "";
  const toolCalls: ChatToolCall[] = [];
  let usage: TokenUsage = emptyTokenUsage();
  const streamEvents: StreamEvent[] = [];

  for (const step of turn.steps) {
    if (ctx.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    await applyStep(step, {
      content,
      toolCalls,
      usage,
      streamEvents,
      setContent: (next) => {
        content = next;
      },
      setUsage: (next) => {
        usage = next;
      },
      sleep: ctx.sleep,
      onBarrier: ctx.onBarrier,
      barriers: ctx.barriers,
      signal: ctx.signal,
    });
  }

  // Ensure stream consumers always get a terminal done event.
  const hasDone = streamEvents.some((event) => event.type === "done");
  if (!hasDone) {
    if (toolCalls.length > 0) {
      streamEvents.push({ type: "tool_calls_done", toolCalls: [...toolCalls] });
    }
    streamEvents.push({
      type: "done",
      content,
      toolCalls: [...toolCalls],
      usage,
    });
  }

  return { content, toolCalls, usage, streamEvents };
}

async function applyStep(
  step: TapeStep,
  state: {
    content: string;
    toolCalls: ChatToolCall[];
    usage: TokenUsage;
    streamEvents: StreamEvent[];
    setContent: (content: string) => void;
    setUsage: (usage: TokenUsage) => void;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    onBarrier?: ScriptedBarrierWaiter;
    barriers: string[];
    signal?: AbortSignal;
  },
): Promise<void> {
  switch (step.type) {
    case "delta": {
      // Accumulate into a local so multi-chunk steps do not reread a stale state.content snapshot.
      let text = state.content;
      for (const chunk of step.chunks) {
        if (step.channel === "text") {
          text += chunk;
          state.streamEvents.push({ type: "text_delta", text: chunk });
        } else {
          state.streamEvents.push({ type: "thinking_delta", text: chunk });
        }
      }
      if (step.channel === "text") {
        state.setContent(text);
      }
      return;
    }
    case "tool_call": {
      state.toolCalls.push({
        id: step.id,
        name: step.name,
        arguments: step.arguments,
      });
      return;
    }
    case "usage": {
      const usage: TokenUsage = {
        inputTokens: step.inputTokens ?? null,
        outputTokens: step.outputTokens ?? null,
        cacheTokens: step.cacheTokens ?? null,
        reasoningTokens: step.reasoningTokens ?? null,
      };
      state.setUsage(usage);
      state.streamEvents.push({ type: "usage", usage });
      return;
    }
    case "error": {
      const error = new Error(step.message ?? step.class);
      error.name = step.class;
      throw error;
    }
    case "hang": {
      await state.sleep(step.ms, state.signal);
      return;
    }
    case "barrier": {
      state.barriers.push(step.id);
      await state.onBarrier?.(step.id);
      return;
    }
    case "done": {
      if (state.toolCalls.length > 0) {
        state.streamEvents.push({ type: "tool_calls_done", toolCalls: [...state.toolCalls] });
      }
      state.streamEvents.push({
        type: "done",
        content: state.content,
        toolCalls: [...state.toolCalls],
        usage: state.usage,
      });
      return;
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
