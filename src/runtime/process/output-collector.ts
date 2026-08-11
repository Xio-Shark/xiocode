/**
 * Bounded stdout/stderr collector: head + ring tail, aggregate hard cap,
 * optional private spill, streaming projections — no unbounded string +=.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { appendPrivateFile, ensurePrivateDir, writePrivateFile } from "../private-fs.ts";

export type OutputStreamName = "stdout" | "stderr";

export type OutputBudget = Readonly<{
  headBytes: number;
  tailBytes: number;
  hardCapBytes: number;
  /** Full in-memory prefix before spill; omit/`0` disables spill. */
  spillTriggerBytes?: number;
  spillDir?: string;
  maxLineBytes?: number;
}>;

export type OutputChunkProjection = Readonly<{
  stream: OutputStreamName;
  text: string;
  droppedBytes: number;
}>;

export type StreamCaptureSnapshot = Readonly<{
  text: string;
  bytesSeen: number;
  retainedBytes: number;
  truncated: boolean;
  spillPath?: string;
  spillError?: string;
}>;

export type CollectorSnapshot = Readonly<{
  stdout: StreamCaptureSnapshot;
  stderr: StreamCaptureSnapshot;
  aggregateBytesSeen: number;
  peakRetainedBytes: number;
  hardCapExceeded: boolean;
}>;

type StreamState = {
  /** Pre-spill full prefix (capped at spillTrigger or head+tail). */
  prefix: Buffer[];
  prefixBytes: number;
  head: Buffer | null;
  tail: Buffer[];
  tailBytes: number;
  bytesSeen: number;
  truncated: boolean;
  spilled: boolean;
  spillPath?: string;
  spillError?: string;
  decoder: StringDecoder;
  lineBuffer: string;
};

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

export class BoundedOutputCollector {
  private readonly budget: Readonly<{
    headBytes: number;
    tailBytes: number;
    hardCapBytes: number;
    maxLineBytes: number;
    spillTriggerBytes: number;
    spillDir?: string;
  }>;
  private readonly onOutput?: (chunk: OutputChunkProjection) => void;
  private readonly streams: Record<OutputStreamName, StreamState>;
  private aggregateBytesSeen = 0;
  private peakRetainedBytes = 0;
  private hardCapExceeded = false;
  private spillChain: Promise<void> = Promise.resolve();

  constructor(
    budget: OutputBudget,
    options: Readonly<{ onOutput?: (chunk: OutputChunkProjection) => void }> = {},
  ) {
    if (budget.headBytes < 0 || budget.tailBytes < 0 || budget.hardCapBytes < 0) {
      throw new Error("OutputBudget byte limits must be non-negative");
    }
    this.budget = {
      headBytes: budget.headBytes,
      tailBytes: budget.tailBytes,
      hardCapBytes: budget.hardCapBytes,
      maxLineBytes: budget.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      spillTriggerBytes: budget.spillTriggerBytes ?? 0,
      spillDir: budget.spillDir,
    };
    this.onOutput = options.onOutput;
    this.streams = {
      stdout: createStreamState(),
      stderr: createStreamState(),
    };
  }

  getPeakRetainedBytes(): number {
    return this.peakRetainedBytes;
  }

  /** Max retained bytes the collector is configured to hold (both streams). */
  configuredBoundBytes(): number {
    const per =
      Math.max(
        this.budget.headBytes + this.budget.tailBytes,
        this.budget.spillTriggerBytes,
      ) + this.budget.tailBytes;
    return 2 * per;
  }

  isHardCapExceeded(): boolean {
    return this.hardCapExceeded;
  }

  getAggregateBytesSeen(): number {
    return this.aggregateBytesSeen;
  }

  /**
   * Ingest raw bytes. Returns true when aggregate hard cap is exceeded
   * (caller should terminate the owned process tree).
   */
  push(stream: OutputStreamName, chunk: Buffer | string): boolean {
    if (this.hardCapExceeded) {
      return true;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.byteLength === 0) {
      return false;
    }

    const state = this.streams[stream];
    state.bytesSeen += buffer.byteLength;
    this.aggregateBytesSeen += buffer.byteLength;

    this.retain(stream, state, buffer);
    this.projectUi(stream, state, buffer);
    this.noteRetained();

    if (this.aggregateBytesSeen > this.budget.hardCapBytes) {
      this.hardCapExceeded = true;
      return true;
    }
    return false;
  }

  async flush(): Promise<void> {
    await this.spillChain;
  }

  async finalize(): Promise<CollectorSnapshot> {
    await this.flush();
    for (const name of ["stdout", "stderr"] as const) {
      const state = this.streams[name];
      const rest = state.decoder.end();
      if (rest.length > 0) {
        this.emitProjection(name, rest, 0);
      }
      if (state.lineBuffer.length > 0) {
        this.emitProjection(name, state.lineBuffer, 0);
        state.lineBuffer = "";
      }
    }
    return {
      stdout: snapshotStream(this.streams.stdout),
      stderr: snapshotStream(this.streams.stderr),
      aggregateBytesSeen: this.aggregateBytesSeen,
      peakRetainedBytes: this.peakRetainedBytes,
      hardCapExceeded: this.hardCapExceeded,
    };
  }

  private noteRetained(): void {
    const retained =
      streamRetainedBytes(this.streams.stdout) + streamRetainedBytes(this.streams.stderr);
    if (retained > this.peakRetainedBytes) {
      this.peakRetainedBytes = retained;
    }
  }

  private retain(stream: OutputStreamName, state: StreamState, buffer: Buffer): void {
    const copy = Buffer.from(buffer);
    const spillEnabled =
      this.budget.spillTriggerBytes > 0 && typeof this.budget.spillDir === "string";

    // Already past prefix phase (spilled or in-memory head/tail ring).
    if (state.spilled || state.head !== null) {
      state.truncated = true;
      pushTail(state, copy, this.budget.tailBytes);
      if (state.spilled) {
        this.enqueueSpillAppend(state, copy);
      }
      return;
    }

    state.prefix.push(copy);
    state.prefixBytes += copy.byteLength;

    if (spillEnabled && state.prefixBytes > this.budget.spillTriggerBytes) {
      this.beginSpill(stream, state);
      return;
    }

    const memCap = this.budget.headBytes + this.budget.tailBytes;
    if (!spillEnabled && state.prefixBytes > memCap) {
      // No spill: freeze head from prefix and keep only tail ring.
      const combined = Buffer.concat(state.prefix, state.prefixBytes);
      state.prefix = [];
      state.prefixBytes = 0;
      state.head = Buffer.from(
        combined.subarray(0, Math.min(this.budget.headBytes, combined.byteLength)),
      );
      state.truncated = true;
      const rest = combined.subarray(state.head.byteLength);
      state.tail = [];
      state.tailBytes = 0;
      pushTail(state, rest, this.budget.tailBytes);
    }
  }

  private beginSpill(stream: OutputStreamName, state: StreamState): void {
    const spillDir = this.budget.spillDir;
    if (!spillDir || state.spilled || state.spillError) {
      return;
    }
    state.spilled = true;
    state.truncated = true;
    const prefix = Buffer.concat(state.prefix, state.prefixBytes);
    state.prefix = [];
    state.prefixBytes = 0;
    state.head = Buffer.from(prefix.subarray(0, Math.min(this.budget.headBytes, prefix.byteLength)));
    state.tail = [];
    state.tailBytes = 0;
    if (prefix.byteLength > state.head.byteLength) {
      pushTail(state, prefix.subarray(state.head.byteLength), this.budget.tailBytes);
    }

    this.spillChain = this.spillChain.then(async () => {
      try {
        await ensurePrivateDir(spillDir);
        state.spillPath = path.join(spillDir, `proc-${stream}-${randomUUID()}.log`);
        await writePrivateFile(state.spillPath, prefix, { flag: "wx" });
      } catch (error) {
        state.spillError = error instanceof Error ? error.message : String(error);
      }
    });
  }

  private enqueueSpillAppend(state: StreamState, buffer: Buffer): void {
    if (!state.spilled || state.spillError) {
      return;
    }
    this.spillChain = this.spillChain.then(async () => {
      if (!state.spillPath || state.spillError) {
        return;
      }
      try {
        await appendPrivateFile(state.spillPath, buffer);
      } catch (error) {
        state.spillError = error instanceof Error ? error.message : String(error);
      }
    });
  }

  private projectUi(stream: OutputStreamName, state: StreamState, buffer: Buffer): void {
    if (!this.onOutput) {
      return;
    }
    const decoded = state.decoder.write(buffer);
    if (!decoded) {
      return;
    }
    state.lineBuffer += decoded;
    const maxLine = this.budget.maxLineBytes;
    let dropped = 0;
    if (Buffer.byteLength(state.lineBuffer) > maxLine) {
      const encoded = Buffer.from(state.lineBuffer);
      dropped = encoded.byteLength - maxLine;
      state.lineBuffer = encoded.subarray(encoded.byteLength - maxLine).toString("utf8");
    }
    const idx = state.lineBuffer.lastIndexOf("\n");
    if (idx === -1 && Buffer.byteLength(state.lineBuffer) < Math.min(4_096, maxLine)) {
      return;
    }
    if (idx === -1) {
      this.emitProjection(stream, state.lineBuffer, dropped);
      state.lineBuffer = "";
      return;
    }
    const emit = state.lineBuffer.slice(0, idx + 1);
    state.lineBuffer = state.lineBuffer.slice(idx + 1);
    this.emitProjection(stream, emit, dropped);
  }

  private emitProjection(stream: OutputStreamName, text: string, droppedBytes: number): void {
    if (!this.onOutput || text.length === 0) {
      return;
    }
    this.onOutput({ stream, text, droppedBytes });
  }
}

function createStreamState(): StreamState {
  return {
    prefix: [],
    prefixBytes: 0,
    head: null,
    tail: [],
    tailBytes: 0,
    bytesSeen: 0,
    truncated: false,
    spilled: false,
    decoder: new StringDecoder("utf8"),
    lineBuffer: "",
  };
}

function streamRetainedBytes(state: StreamState): number {
  if (state.prefixBytes > 0) {
    return state.prefixBytes;
  }
  return (state.head?.byteLength ?? 0) + state.tailBytes;
}

function pushTail(state: StreamState, buffer: Buffer, tailLimit: number): void {
  if (tailLimit <= 0) {
    return;
  }
  if (buffer.byteLength >= tailLimit) {
    state.tail = [Buffer.from(buffer.subarray(buffer.byteLength - tailLimit))];
    state.tailBytes = tailLimit;
    return;
  }
  state.tail.push(Buffer.from(buffer));
  state.tailBytes += buffer.byteLength;
  while (state.tailBytes > tailLimit && state.tail.length > 0) {
    const overflow = state.tailBytes - tailLimit;
    const first = state.tail[0]!;
    if (first.byteLength <= overflow) {
      state.tail.shift();
      state.tailBytes -= first.byteLength;
    } else {
      state.tail[0] = first.subarray(overflow);
      state.tailBytes -= overflow;
    }
  }
}

function materialize(state: StreamState): Buffer {
  if (state.prefixBytes > 0) {
    return Buffer.concat(state.prefix, state.prefixBytes);
  }
  const head = state.head ?? Buffer.alloc(0);
  const tail = state.tailBytes > 0 ? Buffer.concat(state.tail, state.tailBytes) : Buffer.alloc(0);
  if (!state.truncated || tail.byteLength === 0) {
    return head.byteLength > 0 ? head : tail;
  }
  if (head.byteLength === 0) {
    return tail;
  }
  return Buffer.concat([head, Buffer.from("\n…[truncated]…\n"), tail]);
}

function snapshotStream(state: StreamState): StreamCaptureSnapshot {
  const retained = materialize(state);
  const text = retained.toString("utf8");
  const spilledOk = Boolean(state.spillPath) && !state.spillError;
  return {
    text: spilledOk ? formatSpillText(text, state) : text,
    bytesSeen: state.bytesSeen,
    retainedBytes: retained.byteLength,
    truncated: state.truncated || spilledOk,
    ...(state.spillPath ? { spillPath: state.spillPath } : {}),
    ...(state.spillError ? { spillError: state.spillError } : {}),
  };
}

function formatSpillText(retainedTail: string, state: StreamState): string {
  const marker = `[process_output spilled: ${state.spillPath}; bytes_seen=${state.bytesSeen}]`;
  return retainedTail.length === 0 ? marker : `${marker}\n${retainedTail}`;
}

/** Collect-time presets (raw bytes — not `tool_result_max_chars`). */
export const OUTPUT_BUDGET_PRESETS = {
  bash: {
    headBytes: 32 * 1024,
    tailBytes: 32 * 1024,
    spillTriggerBytes: 128 * 1024,
    hardCapBytes: 16 * 1024 * 1024,
  },
  hook: {
    headBytes: 16 * 1024,
    tailBytes: 16 * 1024,
    spillTriggerBytes: 64 * 1024,
    hardCapBytes: 1 * 1024 * 1024,
  },
  search: {
    headBytes: 16 * 1024,
    tailBytes: 16 * 1024,
    hardCapBytes: 2 * 1024 * 1024,
  },
  verify: {
    headBytes: 32 * 1024,
    tailBytes: 32 * 1024,
    spillTriggerBytes: 128 * 1024,
    hardCapBytes: 16 * 1024 * 1024,
  },
  mcpStderr: {
    headBytes: 0,
    tailBytes: 64 * 1024,
    hardCapBytes: 1 * 1024 * 1024,
  },
  dispatch: {
    headBytes: 16 * 1024,
    tailBytes: 32 * 1024,
    hardCapBytes: 8 * 1024 * 1024,
  },
} as const satisfies Record<string, OutputBudget>;
