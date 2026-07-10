import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorTracker } from "../src/error-tracker.ts";
import { RunStore } from "../src/run-store.ts";
import { TrajectoryRecorder } from "../src/trajectory-recorder.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("TrajectoryRecorder", () => {
  it("writes trajectory, events, todo, and summary files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const store = new RunStore({ root: tempDir, now: () => new Date("2026-06-02T00:00:00.000Z"), randomId: () => "recorder" });
    const recorder = new TrajectoryRecorder({ store, now: () => new Date("2026-06-02T00:00:01.000Z") });
    const metadata = await recorder.start({ run_id: "run-1" });

    await recorder.recordToolCall({ toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } });
    await recorder.recordToolResult({ toolCallId: "call-1", toolName: "bash", isError: false, details: { exitCode: 0 }, content: "ok" });
    await recorder.recordTurnEnd({ turnIndex: 1, message: { content: "- [x] verify" }, toolResults: [] });
    const summary = await recorder.finish();

    const trajectory = JSON.parse(await readFile(path.join(tempDir, metadata.run_id, "trajectory.json"), "utf8")) as Record<string, unknown>;
    const events = await readFile(path.join(tempDir, metadata.run_id, "events.jsonl"), "utf8");
    const todo = await readFile(path.join(tempDir, metadata.run_id, "todo.md"), "utf8");

    expect(summary.success).toBe(true);
    expect(trajectory.todo_items).toEqual([{ text: "verify", status: "done" }]);
    expect(events).toContain("\"event\":\"tool.call\"");
    expect(todo).toContain("- [x] verify");
  });

  it("queues tool events off the hot path and flushes them at turn end", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const store = new CountingRunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });

    await recorder.start({ run_id: "run-queued" });
    expect(store.appendBatchCount).toBe(1);
    expect(store.appendedEventCount).toBe(1);

    await recorder.recordToolCall({ toolCallId: "call-1", toolName: "grep", input: { pattern: "TODO" } });
    await recorder.recordToolResult({ toolCallId: "call-1", toolName: "grep", content: "ok" });
    expect(store.appendBatchCount).toBe(1);
    expect(store.appendedEventCount).toBe(1);

    await recorder.recordTurnEnd({ turnIndex: 1, message: { content: "- [x] verify" }, toolResults: [] });
    await recorder.readTrajectory("run-queued");

    expect(store.appendBatchCount).toBe(2);
    expect(store.appendedEventCount).toBe(3);
  });

  it("keeps queued events when a batch append fails and retries them on finish", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const store = new FailingBatchRunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });

    await recorder.start({ run_id: "run-retry" });
    await recorder.recordToolCall({ toolCallId: "call-1", toolName: "grep", input: { pattern: "TODO" } });
    await recorder.recordToolResult({ toolCallId: "call-1", toolName: "grep", content: "ok" });
    await recorder.recordTurnEnd({ turnIndex: 1, message: { content: "- [x] verify" }, toolResults: [] });
    await expect(recorder.finish()).rejects.toThrow("append failed");

    store.failNextBatch = false;
    await recorder.finish();
    const events = await readFile(path.join(tempDir, "run-retry", "events.jsonl"), "utf8");

    expect(events).toContain("\"event\":\"tool.call\"");
    expect(events).toContain("\"event\":\"tool.result\"");
  });

  it("does not block turn end on slow trajectory flushes", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const store = new SlowRunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });

    await recorder.start({ run_id: "run-slow" });
    const turnEnd = recorder.recordTurnEnd({ turnIndex: 1, message: { content: "- [x] verify" }, toolResults: [] });

    await turnEnd;

    expect(store.writeJsonStarted).toBe(false);
    store.releaseWrites();
    await recorder.finish();
  });

  it("waits for pending turn flushes before finishing", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const store = new SlowRunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });

    await recorder.start({ run_id: "run-finish-flush" });
    await recorder.recordToolCall({ toolCallId: "call-1", toolName: "grep", input: { pattern: "TODO" } });
    await recorder.recordToolResult({ toolCallId: "call-1", toolName: "grep", content: "ok" });
    await recorder.recordTurnEnd({ turnIndex: 1, message: { content: "- [x] verify" }, toolResults: [] });
    const finish = recorder.finish();
    await store.waitForWriteJsonStarted();
    expect(store.writeJsonStarted).toBe(true);

    store.releaseWrites();
    await finish;

    const events = await readFile(path.join(tempDir, "run-finish-flush", "events.jsonl"), "utf8");
    const trajectory = await recorder.readTrajectory("run-finish-flush") as Record<string, unknown>;

    expect(events).toContain("\"event\":\"tool.call\"");
    expect(trajectory.todo_items).toEqual([{ text: "verify", status: "done" }]);
  });

  it("marks non-zero exit codes as failed", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }) });

    await recorder.start({ run_id: "run-fail" });
    await recorder.recordToolResult({ toolCallId: "call-1", toolName: "bash", isError: false, details: { exitCode: 2 } });
    const summary = await recorder.finish();

    expect(summary.status).toBe("failed");
    expect(summary.failure_reasons).toContain("exit_code:2");
  });

  it("records file diffs for lowercase edit tool calls", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const filePath = path.join(tempDir, "sample.ts");
    await writeFile(filePath, "const value = 1;\n", "utf8");
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }) });

    await recorder.start({ run_id: "run-diff" });
    await recorder.recordToolCall({ toolCallId: "call-1", toolName: "edit", input: { path: filePath } });
    await writeFile(filePath, "const value = 2;\n", "utf8");
    await recorder.recordToolResult({ toolCallId: "call-1", toolName: "edit", content: "ok" });
    await recorder.finish();

    const events = await readFile(path.join(tempDir, "run-diff", "events.jsonl"), "utf8");
    expect(events).toContain("\"event\":\"file.changed\"");
    expect(events).toContain("before_hash");
    expect(events).toContain("-const value = 1;");
    expect(events).toContain("+const value = 2;");
  });

  it("marks stuck tool loops only after consecutive matching calls reach the threshold", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }), stuckThreshold: 3 });

    await recorder.start({ run_id: "run-stuck" });
    recorder.recordToolCall({ toolCallId: "call-1", toolName: "read" });
    recorder.recordToolCall({ toolCallId: "call-2", toolName: "read" });
    recorder.recordToolCall({ toolCallId: "call-3", toolName: "grep" });
    let summary = await recorder.finish();
    expect(summary.failure_reasons).not.toContain("stuck:read");

    recorder.recordToolCall({ toolCallId: "call-4", toolName: "read" });
    recorder.recordToolCall({ toolCallId: "call-5", toolName: "read" });
    recorder.recordToolCall({ toolCallId: "call-6", toolName: "read" });
    summary = await recorder.finish();
    expect(summary.failure_reasons).toContain("stuck:read");
  });

  it("marks assistant provider errors as failed", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }) });

    await recorder.start({ run_id: "run-provider-error" });
    await recorder.recordTurnEnd({
      turnIndex: 1,
      message: { stopReason: "error", errorMessage: "401 Authentication Fails" },
      toolResults: [],
    });
    const summary = await recorder.finish();

    expect(summary.status).toBe("failed");
    expect(summary.failure_reasons).toContain("assistant_error:401 Authentication Fails");
  });

  it("parses todos from text content blocks", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }) });

    await recorder.start({ run_id: "run-blocks" });
    await recorder.recordTurnEnd({
      turnIndex: 1,
      message: { content: [{ type: "text", text: "- [x] verify" }, { type: "toolCall", id: "call-1" }] },
      toolResults: [],
    });
    const trajectory = await recorder.readTrajectory("run-blocks") as Record<string, unknown>;

    expect(trajectory.todo_items).toEqual([{ text: "verify", status: "done" }]);
  });

  it("does not stringify unknown large messages while parsing todos", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const store = new CapturingRunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });
    let stringifyAttempted = false;

    await recorder.start({ run_id: "run-no-stringify" });
    await recorder.recordTurnEnd({
      turnIndex: 1,
      message: {
        payload: "not markdown",
        toJSON() {
          stringifyAttempted = true;
          return { content: "- [x] should not parse" };
        },
      },
      toolResults: [],
    });
    await recorder.finish();

    expect(stringifyAttempted).toBe(false);
    expect(store.lastTrajectory?.todo_items).toEqual([]);
  });

  it("detects timeout between tool calls exceeding threshold", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const times = [
      new Date("2026-06-02T00:00:00.000Z"),
      new Date("2026-06-02T00:00:01.000Z"),
      new Date("2026-06-02T00:05:00.000Z"),
    ];
    let timeIndex = 0;
    const recorder = new TrajectoryRecorder({
      store: new RunStore({ root: tempDir }),
      now: () => times[timeIndex++] ?? times[times.length - 1]!,
      toolTimeoutMs: 60_000,
    });

    await recorder.start({ run_id: "run-timeout" });
    recorder.recordToolCall({ toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } });
    recorder.recordToolResult({ toolCallId: "call-1", toolName: "read", content: "ok" });
    recorder.recordToolCall({ toolCallId: "call-2", toolName: "bash", input: { command: "npm test" } });
    const summary = await recorder.finish();

    expect(summary.failure_reasons.some((reason) => reason.startsWith("timeout:"))).toBe(true);
  });

  it("detects loop when same tool + same args repeat beyond threshold", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const recorder = new TrajectoryRecorder({
      store: new RunStore({ root: tempDir }),
      loopSignatureThreshold: 2,
    });

    await recorder.start({ run_id: "run-loop-sig" });
    recorder.recordToolCall({ toolCallId: "call-1", toolName: "read", input: { path: "src/index.ts" } });
    recorder.recordToolCall({ toolCallId: "call-2", toolName: "read", input: { path: "src/index.ts" } });
    const summary = await recorder.finish();

    expect(summary.failure_reasons.some((reason) => reason.startsWith("loop:"))).toBe(true);
  });

  it("does not flag loop when same tool uses different paths", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const recorder = new TrajectoryRecorder({
      store: new RunStore({ root: tempDir }),
      loopSignatureThreshold: 2,
    });

    await recorder.start({ run_id: "run-no-loop" });
    recorder.recordToolCall({ toolCallId: "call-1", toolName: "read", input: { path: "src/a.ts" } });
    recorder.recordToolCall({ toolCallId: "call-2", toolName: "read", input: { path: "src/b.ts" } });
    const summary = await recorder.finish();

    expect(summary.failure_reasons.some((reason) => reason.startsWith("loop:"))).toBe(false);
  });

  it("merges semantic error types from ErrorTracker into failure_reasons", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const errorTracker = new ErrorTracker();
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }), errorTracker });

    await recorder.start({ run_id: "run-semantic" });
    // 模拟两次工具错误：一次文件未找到，一次权限拒绝
    errorTracker.recordError("read", "Error: ENOENT: no such file or directory, open 'foo.ts'", { path: "foo.ts" });
    errorTracker.recordError("bash", "permission denied: cannot run script", { command: "./run.sh" });
    const summary = await recorder.finish();

    // 语义化错误类型应出现在 failure_reasons，而非裸的 tool_error:read
    expect(summary.failure_reasons).toContain("tool_error:file_not_found");
    expect(summary.failure_reasons).toContain("tool_error:permission_denied");
    expect(summary.status).toBe("failed");
  });

  it("does not produce duplicate semantic reasons when the same error type repeats", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-traj-"));
    const errorTracker = new ErrorTracker();
    const recorder = new TrajectoryRecorder({ store: new RunStore({ root: tempDir }), errorTracker });

    await recorder.start({ run_id: "run-dedupe" });
    errorTracker.recordError("read", "ENOENT: foo.ts not found");
    errorTracker.recordError("read", "ENOENT: bar.ts not found");
    errorTracker.recordError("read", "ENOENT: baz.ts not found");
    const summary = await recorder.finish();

    const notFoundCount = summary.failure_reasons.filter((r) => r === "tool_error:file_not_found").length;
    expect(notFoundCount).toBe(1);
  });
});

class CountingRunStore extends RunStore {
  appendBatchCount = 0;
  appendedEventCount = 0;

  override async appendJsonlBatch(runId: string, fileName: string, values: readonly unknown[]): Promise<void> {
    this.appendBatchCount += 1;
    this.appendedEventCount += values.length;
    await super.appendJsonlBatch(runId, fileName, values);
  }
}

class FailingBatchRunStore extends RunStore {
  failNextBatch = true;

  override async appendJsonlBatch(runId: string, fileName: string, values: readonly unknown[]): Promise<void> {
    if (fileName === "events.jsonl" && values.length > 1 && this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("append failed");
    }
    await super.appendJsonlBatch(runId, fileName, values);
  }
}

class CapturingRunStore extends RunStore {
  lastTrajectory: { todo_items?: unknown } | undefined;

  override async writeJson(runId: string, fileName: string, value: unknown): Promise<void> {
    if (fileName === "trajectory.json") {
      this.lastTrajectory = value as { todo_items?: unknown };
      return;
    }
    await super.writeJson(runId, fileName, value);
  }
}

class SlowRunStore extends RunStore {
  writeJsonStarted = false;
  private release: (() => void) | undefined;
  private resolveStarted: (() => void) | undefined;
  private readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private released = false;

  override async writeJson(runId: string, fileName: string, value: unknown): Promise<void> {
    if (fileName === "trajectory.json" && !this.released) {
      this.writeJsonStarted = true;
      this.resolveStarted?.();
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    await super.writeJson(runId, fileName, value);
  }

  releaseWrites(): void {
    this.released = true;
    this.release?.();
  }

  async waitForWriteJsonStarted(): Promise<void> {
    await this.started;
  }
}
