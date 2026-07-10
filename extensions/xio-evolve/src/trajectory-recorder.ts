import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";

import { RunStore } from "./run-store.ts";
import { parseTodos } from "./todo-enforcer.ts";
import { SecretRedactor } from "./secret-redactor.ts";
import { decodeProviderUsageEvent, sumTokenUsage } from "../../../src/runtime/usage.ts";

import type { ErrorTracker } from "./error-tracker.ts";
import type { RunMetadata, RunSummary, TodoItem, ToolCall, TrajectoryTurn } from "./types.ts";
import type { TokenUsage } from "../../../src/runtime/types.ts";

export type TrajectoryRecorderOptions = Readonly<{
  store?: RunStore;
  metadata?: Partial<RunMetadata>;
  now?: () => Date;
  stuckThreshold?: number;
  debugMode?: boolean;
  toolTimeoutMs?: number;
  loopSignatureThreshold?: number;
  errorTracker?: ErrorTracker;
}>;

type PendingEvent = Readonly<{
  event: string;
  message: string;
  payload: Record<string, unknown>;
  call?: ToolCall;
  timestamp: string;
}>;

type TurnState = "AWAITING_USER" | "PROCESSING_TOOLS" | "AWAITING_ASSISTANT" | "TURN_COMPLETE";

type FileSnapshot = Readonly<{
  path: string;
  content: string;
  hash: string;
}>;

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_LOOP_SIGNATURE_THRESHOLD = 3;

export class TrajectoryRecorder {
  private readonly store: RunStore;
  private readonly now: () => Date;
  private readonly stuckThreshold: number;
  private readonly toolTimeoutMs: number;
  private readonly loopSignatureThreshold: number;
  private readonly redactor: SecretRedactor;
  private readonly errorTracker?: ErrorTracker;
  private metadata: RunMetadata | null = null;
  private readonly toolCalls: ToolCall[] = [];
  private readonly toolCallsById = new Map<string, ToolCall>();
  private readonly toolResults: unknown[] = [];
  private readonly turns: TrajectoryTurn[] = [];
  private readonly failureReasons: string[] = [];
  private readonly pendingEvents: PendingEvent[] = [];
  private readonly providerUsages: TokenUsage[] = [];
  private todoItems: readonly TodoItem[] = [];
  private pendingFlush: Promise<void> | undefined;
  private flushAgain = false;
  private flushError: unknown;
  private turnState: TurnState = "AWAITING_USER";
  private pendingToolCallsInTurn = 0;
  private readonly fileSnapshots = new Map<string, FileSnapshot>();
  private lastToolCallAt: number | undefined;
  private readonly loopSignatureCounts = new Map<string, number>();

  constructor(options: TrajectoryRecorderOptions = {}) {
    this.store = options.store ?? new RunStore();
    this.now = options.now ?? (() => new Date());
    this.stuckThreshold = options.stuckThreshold ?? 3;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.loopSignatureThreshold = options.loopSignatureThreshold ?? DEFAULT_LOOP_SIGNATURE_THRESHOLD;
    this.redactor = new SecretRedactor({ debugMode: options.debugMode });
    this.errorTracker = options.errorTracker;
    if (options.metadata) {
      this.metadata = options.metadata as RunMetadata;
    }
  }

  async start(input: Partial<RunMetadata> = {}): Promise<RunMetadata> {
    const record = await this.store.createRun({ ...this.metadata, ...input });
    this.metadata = record.metadata;
    await this.writeEvent("run.started", "run started", {});
    return record.metadata;
  }

  async recordToolCall(event: unknown): Promise<void> {
    const call = toToolCall(event);
    const nowMs = this.now().getTime();

    // Timeout detection: gap between tool calls exceeds threshold
    if (this.lastToolCallAt !== undefined) {
      const gap = nowMs - this.lastToolCallAt;
      if (gap > this.toolTimeoutMs) {
        this.failureReasons.push(`timeout:${call.name}:${gap}ms`);
      }
    }
    this.lastToolCallAt = nowMs;

    // Precise loop detection: same tool + similar args
    const signature = toolCallSignature(call);
    if (signature) {
      const count = (this.loopSignatureCounts.get(signature) ?? 0) + 1;
      this.loopSignatureCounts.set(signature, count);
      if (count === this.loopSignatureThreshold) {
        this.failureReasons.push(`loop:${signature}`);
      }
    }

    this.toolCalls.push(call);
    if (call.id) {
      this.toolCallsById.set(call.id, call);
    }
    this.queueEvent("tool.call", `tool call: ${call.name}`, { args: call.args }, call);
    this.detectStuckToolLoop(call.name);

    // Capture file snapshot before Edit/Write
    if (isFileMutationTool(call.name)) {
      await this.captureFileSnapshot(call.args as Record<string, unknown>);
    }

    // Transition to PROCESSING_TOOLS state and increment pending count
    if (this.turnState === "AWAITING_ASSISTANT") {
      this.turnState = "PROCESSING_TOOLS";
    }
    this.pendingToolCallsInTurn += 1;
  }

  async recordToolResult(event: unknown): Promise<void> {
    this.toolResults.push(event);
    const call = this.toolCallForResult(event);
    if (isErrorResult(event)) {
      this.failureReasons.push(`tool_error:${call.name}`);
    }
    if (exitCode(event) !== null && exitCode(event) !== 0) {
      this.failureReasons.push(`exit_code:${exitCode(event)}`);
    }

    // Compute diff after Edit/Write if snapshot exists
    if (isFileMutationTool(call.name) && !isErrorResult(event)) {
      await this.computeFileDiff(call.args as Record<string, unknown>);
    }

    this.queueEvent(isErrorResult(event) ? "tool.error" : "tool.result", `tool result: ${call.name}`, { result: event }, call);

    // Decrement pending tool call counter
    this.pendingToolCallsInTurn = Math.max(0, this.pendingToolCallsInTurn - 1);
  }

  recordProviderUsage(event: unknown): void {
    const usage = decodeProviderUsageEvent(event);
    this.providerUsages.push(usage);
    this.queueEvent("provider.usage", "provider usage", { usage });
  }

  recordTurnEnd(event: unknown): void {
    const turn = toTurn(event);
    const assistantError = assistantErrorMessage(turn.message);
    if (assistantError) {
      this.failureReasons.push(`assistant_error:${assistantError}`);
    }

    // Update state machine
    if (this.turnState === "AWAITING_USER" || this.turnState === "TURN_COMPLETE") {
      // Starting a new turn
      this.turnState = "AWAITING_ASSISTANT";
    }

    // Only push turn when all pending tool calls are complete
    if (this.pendingToolCallsInTurn === 0) {
      this.turns.push(turn);
      this.turnState = "TURN_COMPLETE";
      this.todoItems = parseTodos(messageText(turn.message));
      this.requestFlush();
    } else {
      // Still have pending tool calls, will push turn on next recordTurnEnd
      this.turnState = "AWAITING_ASSISTANT";
    }
  }

  async finish(status: "success" | "failed" = this.deriveStatus()): Promise<RunSummary> {
    const metadata = await this.ensureStarted();
    await this.waitForPendingFlush();
    await this.flushEvents();
    await this.flushTrajectory();
    const durationMs = this.now().getTime() - new Date(metadata.started_at).getTime();
    // 合并 ErrorTracker 的语义化错误类型（file_not_found / permission_denied / syntax_error ...）
    // 与 recorder 内部的结构性标记（timeout/loop/stuck/tool_error/exit_code）互补，
    // 让 StrategyLearner 看到的是有信号量的失败模式，而不是"没崩溃 = 成功"。
    const semanticReasons = this.errorTracker?.getFailureReasons() ?? [];
    const failureReasons = unique([...this.failureReasons, ...semanticReasons]);
    // 若调用方没显式传 status，则语义化错误也应让 run 被判为 failed，
    // 避免 failure_reasons 非空但 status=success 的自相矛盾。
    const resolvedStatus = status === "success" && semanticReasons.length > 0 ? "failed" : status;
    const summary: RunSummary = {
      run_id: metadata.run_id,
      status: resolvedStatus,
      duration_ms: Math.max(0, durationMs),
      success: resolvedStatus === "success",
      failure_reasons: failureReasons,
      finished_at: this.now().toISOString(),
      usage: sumTokenUsage(this.providerUsages),
    };
    await this.store.writeJson(metadata.run_id, "summary.json", summary);
    await this.writeEvent(resolvedStatus === "success" ? "run.finished" : "run.error", `run ${resolvedStatus}`, { summary });
    return summary;
  }

  private deriveStatus(): "success" | "failed" {
    return this.failureReasons.length > 0 ? "failed" : "success";
  }

  async readTrajectory(runId: string): Promise<unknown> {
    await this.waitForPendingFlush();
    return JSON.parse(await readFile(this.store.filePath(runId, "trajectory.json"), "utf8"));
  }

  private async flushTrajectory(): Promise<void> {
    const metadata = await this.ensureStarted();
    await this.store.writeJson(metadata.run_id, "trajectory.json", {
      metadata,
      messages: this.turns.map((turn) => turn.message),
      tool_rounds: this.toolResults,
      todo_items: this.todoItems,
      finalMessage: this.turns.at(-1)?.message ?? null,
    });
    await this.store.writeText(metadata.run_id, "todo.md", formatTodos(this.todoItems));
  }

  private queueEvent(event: string, message: string, payload: Record<string, unknown>, call?: ToolCall): void {
    this.pendingEvents.push({ event, message, payload, call, timestamp: this.now().toISOString() });
  }

  private async flushEvents(): Promise<void> {
    while (this.pendingEvents.length > 0) {
      const events = this.pendingEvents.slice();
      await this.writePendingEvents(events);
      this.pendingEvents.splice(0, events.length);
    }
  }

  private requestFlush(): void {
    if (this.pendingFlush) {
      this.flushAgain = true;
      return;
    }
    this.pendingFlush = Promise.resolve()
      .then(() => this.runFlushLoop())
      .catch((error: unknown) => {
        this.flushError = error;
      })
      .finally(() => {
        this.pendingFlush = undefined;
      });
  }

  private async runFlushLoop(): Promise<void> {
    do {
      this.flushAgain = false;
      await this.flushEvents();
      await this.flushTrajectory();
    } while (this.flushAgain);
  }

  private async waitForPendingFlush(): Promise<void> {
    if (this.pendingFlush) {
      await this.pendingFlush;
    }
    if (this.flushError) {
      const error = this.flushError;
      this.flushError = undefined;
      throw error;
    }
  }

  private async ensureStarted(): Promise<RunMetadata> {
    if (this.metadata) {
      return this.metadata;
    }
    return this.start();
  }

  private async writeEvent(event: string, message: string, payload: Record<string, unknown>, call?: ToolCall): Promise<void> {
    await this.writePendingEvent({ event, message, payload, call, timestamp: this.now().toISOString() });
  }

  private async writePendingEvent(pending: PendingEvent): Promise<void> {
    await this.writePendingEvents([pending]);
  }

  private async writePendingEvents(pendingEvents: readonly PendingEvent[]): Promise<void> {
    const metadata = await this.ensureStarted();
    await this.store.appendJsonlBatch(metadata.run_id, "events.jsonl", pendingEvents.map((pending) => ({
      event: pending.event,
      timestamp: pending.timestamp,
      run_id: metadata.run_id,
      call_id: pending.call?.id,
      tool_name: pending.call?.name,
      message: pending.message,
      payload: this.redactor.redact(pending.payload),
      schema_version: "run-event.v1",
    })));
  }

  private detectStuckToolLoop(toolName: string): void {
    if (this.toolCalls.length < this.stuckThreshold) {
      return;
    }
    for (let index = this.toolCalls.length - this.stuckThreshold; index < this.toolCalls.length; index++) {
      if (this.toolCalls[index]?.name !== toolName) {
        return;
      }
    }
    if (this.stuckThreshold > 0) {
      this.failureReasons.push(`stuck:${toolName}`);
    }
  }

  private toolCallForResult(event: unknown): ToolCall {
    const call = toToolCall(event);
    const original = call.id ? this.toolCallsById.get(call.id) : undefined;
    if (!original) {
      return call;
    }
    return {
      id: call.id ?? original.id,
      name: call.name === "unknown" ? original.name : call.name,
      args: hasArgs(call.args) ? call.args : original.args,
    };
  }

  private async captureFileSnapshot(args: Record<string, unknown>): Promise<void> {
    const filePath = extractFilePath(args);
    if (!filePath) {
      return;
    }

    try {
      const content = await readFile(filePath, "utf8");
      this.fileSnapshots.set(filePath, {
        path: filePath,
        content,
        hash: hashContent(content),
      });
    } catch {
      this.fileSnapshots.set(filePath, {
        path: filePath,
        content: "",
        hash: hashContent(""),
      });
    }
  }

  private async computeFileDiff(args: Record<string, unknown>): Promise<void> {
    const filePath = extractFilePath(args);
    if (!filePath) {
      return;
    }

    const snapshot = this.fileSnapshots.get(filePath);
    if (!snapshot) {
      return;
    }

    try {
      const newContent = await readFile(filePath, "utf8");
      const newHash = hashContent(newContent);
      if (snapshot.hash === newHash) {
        return;
      }

      const diff = createTwoFilesPatch(
        filePath,
        filePath,
        snapshot.content,
        newContent,
        "before",
        "after",
      );

      this.queueEvent("file.changed", `file changed: ${filePath}`, {
        path: filePath,
        before_hash: snapshot.hash,
        after_hash: newHash,
        unified_diff: diff,
      });
    } catch {
      this.queueEvent("file.changed", `file changed: ${filePath}`, {
        path: filePath,
        before_hash: snapshot.hash,
        after_hash: null,
        unified_diff: null,
      });
    } finally {
      this.fileSnapshots.delete(filePath);
    }
  }
}

function toToolCall(event: unknown): ToolCall {
  const record = asRecord(event);
  return {
    id: stringValue(record.toolCallId ?? record.id),
    name: stringValue(record.toolName ?? record.name) ?? "unknown",
    args: asRecord(record.input ?? record.args),
  };
}

function toTurn(event: unknown): TrajectoryTurn {
  const record = asRecord(event);
  return {
    turn_index: numberValue(record.turnIndex) ?? 0,
    message: record.message ?? null,
    tool_results: Array.isArray(record.toolResults) ? record.toolResults : [],
  };
}

function isErrorResult(event: unknown): boolean {
  return asRecord(event).isError === true;
}

function messageText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  const record = asRecord(message);
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return textFromContentBlocks(record.content);
  }
  return "";
}

function textFromContentBlocks(content: readonly unknown[]): string {
  return content
    .map((item) => asRecord(item).text)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("");
}

function exitCode(event: unknown): number | null {
  const record = asRecord(event);
  const details = asRecord(record.details);
  return numberValue(record.exitCode) ?? numberValue(details.exitCode);
}

function assistantErrorMessage(message: unknown): string | null {
  const record = asRecord(message);
  if (record.stopReason !== "error") {
    return null;
  }
  return stringValue(record.errorMessage) ?? "unknown";
}

function formatTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) {
    return "";
  }
  return `${items.map((item) => `- [${item.status === "done" ? "x" : item.status === "in_progress" ? "-" : " "}] ${item.text}`).join("\n")}\n`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function extractFilePath(args: Record<string, unknown>): string | null {
  const filePath = args.file_path ?? args.path;
  return typeof filePath === "string" ? filePath : null;
}

function hasArgs(args: Record<string, unknown> | undefined): args is Record<string, unknown> {
  return args !== undefined && Object.keys(args).length > 0;
}

function isFileMutationTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "edit" || normalized === "write";
}

function toolCallSignature(call: ToolCall): string | null {
  const path = call.args?.path ?? call.args?.file_path;
  const command = call.args?.command;
  if (typeof path === "string" && path.length > 0) {
    return `${call.name}:${path}`;
  }
  if (typeof command === "string" && command.length > 0) {
    return `${call.name}:${command.slice(0, 80)}`;
  }
  return null;
}
