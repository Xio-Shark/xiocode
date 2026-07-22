import type { ChatToolCall, ToolExecuteResult } from "./types.ts";
import { FileWriteQueue } from "./file-write-queue.ts";

/** Tools that mutate workspace files and must not race each other by realpath. */
export const WRITE_SERIAL_TOOLS = new Set(["write", "edit", "plan"]);

export function isWriteSerialTool(name: string): boolean {
  return WRITE_SERIAL_TOOLS.has(name);
}

export type OrderedToolResult = Readonly<{
  call: ChatToolCall;
  result: ToolExecuteResult;
}>;

export type StreamingToolSchedulerOptions = Readonly<{
  /**
   * Execute one tool call. `signal` aborts when the scheduler (or session) aborts.
   * Implementations should return an isError result on abort rather than throw when possible.
   */
  execute: (call: ChatToolCall, signal: AbortSignal) => Promise<ToolExecuteResult>;
  /** Shared realpath write queue; created per scheduler when omitted. */
  fileWriteQueue?: FileWriteQueue;
  /** When false, tools run strictly in enqueue order. Default true. */
  parallelToolCalls?: boolean;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  /** Session-level abort; mirrors `abort()` when fired. */
  signal?: AbortSignal;
}>;

type Entry = {
  call: ChatToolCall;
  promise: Promise<ToolExecuteResult>;
};

/**
 * Starts tool execution as soon as a complete call is enqueued (while the provider
 * stream may still be open). Results are returned in **receive / enqueue order**,
 * not completion order.
 *
 * Write/edit/plan go through {@link FileWriteQueue}; other tools may run in parallel
 * when `parallelToolCalls` is true.
 */
export class StreamingToolScheduler {
  readonly #execute: StreamingToolSchedulerOptions["execute"];
  readonly #writeQueue: FileWriteQueue;
  readonly #parallel: boolean;
  readonly #onToolStart?: (call: ChatToolCall) => void;
  readonly #onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  readonly #controller = new AbortController();
  readonly #entries: Entry[] = [];
  readonly #abortBarrier: Promise<ToolExecuteResult>;
  #resolveAbortBarrier: ((result: ToolExecuteResult) => void) | undefined;
  #serialTail: Promise<void> = Promise.resolve();
  #aborted = false;
  #abortReason = "AbortSignal aborted";
  #externalAbortHandler: (() => void) | undefined;

  constructor(options: StreamingToolSchedulerOptions) {
    this.#execute = options.execute;
    this.#writeQueue = options.fileWriteQueue ?? new FileWriteQueue();
    this.#parallel = options.parallelToolCalls !== false;
    this.#onToolStart = options.onToolStart;
    this.#onToolEnd = options.onToolEnd;
    this.#abortBarrier = new Promise<ToolExecuteResult>((resolve) => {
      this.#resolveAbortBarrier = resolve;
    });

    if (options.signal) {
      if (options.signal.aborted) {
        this.abort("AbortSignal aborted");
      } else {
        this.#externalAbortHandler = () => {
          this.abort("AbortSignal aborted");
        };
        options.signal.addEventListener("abort", this.#externalAbortHandler, { once: true });
      }
    }
  }

  /** Number of calls enqueued so far. */
  get size(): number {
    return this.#entries.length;
  }

  /** True after {@link abort} or external signal abort. */
  get aborted(): boolean {
    return this.#aborted;
  }

  /**
   * Enqueue a complete tool call and start execution immediately (subject to
   * serial / write-queue constraints). Safe to call while a provider stream is open.
   */
  enqueue(call: ChatToolCall): void {
    if (this.#aborted || this.#controller.signal.aborted) {
      const result = cancelledToolResult(this.#abortReason);
      this.#entries.push({ call, promise: Promise.resolve(result) });
      this.#onToolStart?.(call);
      this.#onToolEnd?.(call, result);
      return;
    }

    const run = (): Promise<ToolExecuteResult> => this.#runOne(call);

    let promise: Promise<ToolExecuteResult>;
    if (!this.#parallel) {
      const next = this.#serialTail.then(run, run);
      this.#serialTail = next.then(
        () => undefined,
        () => undefined,
      );
      promise = next;
    } else if (isWriteSerialTool(call.name)) {
      const filePath = typeof call.arguments.path === "string" ? String(call.arguments.path) : "";
      const queueKey = filePath.length > 0 ? filePath : `__anon_write_${call.id}`;
      promise = this.#writeQueue.run(queueKey, run);
    } else {
      promise = run();
    }

    this.#entries.push({ call, promise });
  }

  /**
   * Wait until every enqueued call has a result, in enqueue order.
   * Does not start new work after abort — incomplete calls already have synthesized results.
   */
  async waitAllOrdered(): Promise<readonly OrderedToolResult[]> {
    const results = await Promise.all(this.#entries.map((entry) => entry.promise));
    return this.#entries.map((entry, index) => ({
      call: entry.call,
      result: results[index]!,
    }));
  }

  /**
   * Abort in-flight / not-yet-started work. Pending execute calls see an aborted signal;
   * any call that has not produced a result yet settles with an isError tool_result.
   */
  abort(reason = "AbortSignal aborted"): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#abortReason = reason;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort();
    }
    this.#resolveAbortBarrier?.(cancelledToolResult(reason));
    this.#resolveAbortBarrier = undefined;
  }

  async #runOne(call: ChatToolCall): Promise<ToolExecuteResult> {
    if (this.#aborted || this.#controller.signal.aborted) {
      const result = cancelledToolResult(this.#abortReason);
      this.#onToolStart?.(call);
      this.#onToolEnd?.(call, result);
      return result;
    }

    this.#onToolStart?.(call);
    try {
      // Race so waitAllOrdered settles even when execute ignores the abort signal.
      const result = await Promise.race([
        this.#execute(call, this.#controller.signal),
        this.#abortBarrier,
      ]);
      this.#onToolEnd?.(call, result);
      return result;
    } catch (error) {
      if (this.#aborted || this.#controller.signal.aborted) {
        const result = cancelledToolResult(this.#abortReason);
        this.#onToolEnd?.(call, result);
        return result;
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: ToolExecuteResult = {
        content: [{ type: "text", text: `tool error: ${message}` }],
        isError: true,
      };
      this.#onToolEnd?.(call, result);
      return result;
    }
  }
}

function cancelledToolResult(reason: string): ToolExecuteResult {
  return {
    content: [{ type: "text", text: `tool cancelled: ${reason}` }],
    isError: true,
  };
}
