import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgentLoop } from "../agent-loop.ts";
import { ExtensionHost } from "../extension-host.ts";
import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";
import { runExploreSubagent } from "../explore/subagent.ts";

import type { ChatCompletionResponse, LlmClient, StreamEvent, TokenUsage } from "../types.ts";
import type { PerfSample, PerfSpan } from "./types.ts";
import { PerfTracer } from "./tracer.ts";
import { sampleFromSpans } from "./store.ts";

export const ALL_FIXTURES = [
  "cli.version",
  "cli.help",
  "startup.interactive",
  "tui.replay_10k",
  "session.tool_heavy",
  "explore.workers_2",
  "explore.workers_4",
  "explore.workers_8",
] as const;

export type FixtureId = (typeof ALL_FIXTURES)[number];

export function isFixtureId(value: string): value is FixtureId {
  return (ALL_FIXTURES as readonly string[]).includes(value);
}

export type RunFixtureOptions = Readonly<{
  iteration: number;
  env?: NodeJS.ProcessEnv;
  cliEntry?: string;
  nodeBin?: string;
  timeoutMs?: number;
}>;

export async function runFixture(id: FixtureId, options: RunFixtureOptions): Promise<PerfSample> {
  switch (id) {
    case "cli.version":
      return runCliFlagFixture(id, "--version", options);
    case "cli.help":
      return runCliFlagFixture(id, "--help", options);
    case "startup.interactive":
      return runInteractiveStartupFixture(options);
    case "tui.replay_10k":
      return runTuiReplayFixture(options);
    case "session.tool_heavy":
      return runToolHeavyFixture(options);
    case "explore.workers_2":
      return runExploreWorkersFixture(2, options);
    case "explore.workers_4":
      return runExploreWorkersFixture(4, options);
    case "explore.workers_8":
      return runExploreWorkersFixture(8, options);
    default: {
      const _exhaustive: never = id;
      throw new Error(`unknown fixture: ${_exhaustive}`);
    }
  }
}

async function runCliFlagFixture(
  fixture: FixtureId,
  flag: "--version" | "--help",
  options: RunFixtureOptions,
): Promise<PerfSample> {
  const tracer = new PerfTracer({ enabled: true });
  const entry = options.cliEntry ?? defaultCliEntry();
  const nodeBin = options.nodeBin ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const active = tracer.start("process_start", { attrs: { fixture, flag } });
  const started = performance.now();
  try {
    const result = await spawnCollect(nodeBin, cliArgs(entry, flag), {
      env: { ...process.env, ...options.env, XIO_PERF: "0" },
      timeoutMs,
    });
    const wall_ms = performance.now() - started;
    const outcome = result.code === 0 ? "success" : "failure";
    tracer.end(active, outcome, {
      attrs: { exit_code: result.code ?? -1, stdout_bytes: result.stdout.length },
      error_class: outcome === "failure" ? "cli_nonzero" : undefined,
    });
    return sampleFromSpans({
      fixture,
      iteration: options.iteration,
      spans: tracer.getSpans(),
      wall_ms,
      outcome,
    });
  } catch (error) {
    const wall_ms = performance.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout/i.test(message);
    tracer.end(active, timeout ? "timeout" : "failure", {
      error_class: timeout ? "timeout" : "spawn",
    });
    return sampleFromSpans({
      fixture,
      iteration: options.iteration,
      spans: tracer.getSpans(),
      wall_ms,
      outcome: timeout ? "timeout" : "failure",
      error_class: timeout ? "timeout" : "spawn",
    });
  }
}

async function runInteractiveStartupFixture(options: RunFixtureOptions): Promise<PerfSample> {
  const tracer = new PerfTracer({ enabled: true });
  const entry = options.cliEntry ?? defaultCliEntry();
  const nodeBin = options.nodeBin ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const activeProcess = tracer.start("process_start", { attrs: { fixture: "startup.interactive" } });
  const started = performance.now();
  try {
    const result = await spawnCollect(
      nodeBin,
      // --xio-fast skips evolve/sandbox extensions so boot measures core path only.
      [...cliArgs(entry), "--xio-fast"],
      {
        env: {
          ...process.env,
          ...options.env,
          XIO_PERF: "1",
          XIO_PERF_BOOT_EXIT: "1",
          CI: "1",
          // Dummy key only for prepareSession; boot-exit never issues a provider request.
          DEEPSEEK_API_KEY: options.env?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "bench-dummy-key",
        },
        timeoutMs,
      },
    );
    const wall_ms = performance.now() - started;
    const spansFromChild = parsePerfJsonLines(result.stdout);
    for (const span of spansFromChild) {
      tracer.mark(span.name, span.outcome, {
        wall_ms: span.wall_ms,
        attrs: span.attrs,
        error_class: span.error_class,
      });
    }
    const outcome = result.code === 0 ? "success" : "failure";
    tracer.end(activeProcess, outcome, {
      attrs: { exit_code: result.code ?? -1, child_spans: spansFromChild.length },
      error_class: outcome === "failure" ? "boot_exit_nonzero" : undefined,
    });
    if (!spansFromChild.some((span) => span.name === "prompt_ready")) {
      tracer.mark("prompt_ready", outcome, { wall_ms, attrs: { source: "parent_fallback" } });
    }
    if (!spansFromChild.some((span) => span.name === "first_frame")) {
      tracer.mark("first_frame", outcome, { wall_ms, attrs: { source: "parent_fallback" } });
    }
    return sampleFromSpans({
      fixture: "startup.interactive",
      iteration: options.iteration,
      spans: tracer.getSpans(),
      wall_ms,
      outcome,
    });
  } catch (error) {
    const wall_ms = performance.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout/i.test(message);
    tracer.end(activeProcess, timeout ? "timeout" : "failure", {
      error_class: timeout ? "timeout" : "spawn",
    });
    tracer.mark("prompt_ready", timeout ? "timeout" : "failure", {
      wall_ms,
      error_class: timeout ? "timeout" : "spawn",
    });
    tracer.mark("first_frame", timeout ? "timeout" : "failure", {
      wall_ms,
      error_class: timeout ? "timeout" : "spawn",
    });
    return sampleFromSpans({
      fixture: "startup.interactive",
      iteration: options.iteration,
      spans: tracer.getSpans(),
      wall_ms,
      outcome: timeout ? "timeout" : "failure",
    });
  }
}

async function runTuiReplayFixture(options: RunFixtureOptions): Promise<PerfSample> {
  const tracer = new PerfTracer({ enabled: true });
  const started = performance.now();
  const deltas = 10_000;
  for (let i = 0; i < deltas; i += 1) {
    if (i % 100 === 0) {
      const paint = tracer.start("tui.paint", { attrs: { i, sample: true } });
      let acc = 0;
      for (let j = 0; j < 20; j += 1) acc += j;
      void acc;
      tracer.end(paint, "success", { attrs: { bytes: 64 } });
    }
  }
  const wall_ms = performance.now() - started;
  tracer.mark("process_start", "success", { wall_ms, attrs: { fixture: "tui.replay_10k", deltas } });
  return sampleFromSpans({
    fixture: "tui.replay_10k",
    iteration: options.iteration,
    spans: tracer.getSpans(),
    wall_ms,
    outcome: "success",
  });
}

async function runToolHeavyFixture(options: RunFixtureOptions): Promise<PerfSample> {
  const tracer = new PerfTracer({ enabled: true });
  const started = performance.now();
  const host = new ExtensionHost({
    initialModel: { provider: "mock", id: "mock", name: "mock" },
  });
  let toolRounds = 0;
  const maxRounds = 8;
  host.registerTool(defineTool({
    name: "noop_read",
    description: "bench noop",
    parameters: Type.Object({ n: Type.Number() }, { required: [] }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  }));

  let callIndex = 0;
  const client: LlmClient = {
    async complete(): Promise<ChatCompletionResponse> {
      const provider = tracer.start("provider.request");
      const first = tracer.start("provider.first_token", { parentId: provider?.span_id });
      tracer.end(first, "success");
      const completion = tracer.start("provider.completion", { parentId: provider?.span_id });
      toolRounds += 1;
      const usage = emptyUsage();
      if (toolRounds <= maxRounds) {
        const toolCalls = [
          { id: `c${callIndex++}`, name: "noop_read", arguments: { n: toolRounds } },
          { id: `c${callIndex++}`, name: "noop_read", arguments: { n: toolRounds + 0.5 } },
        ];
        tracer.end(completion, "success", { usage });
        tracer.end(provider, "success", { usage });
        const batch = tracer.start("tool.batch", { attrs: { tools: toolCalls.length } });
        // Batch wall is measured when agent-loop runs tools; mark synthetic success after microtask.
        queueMicrotask(() => tracer.end(batch, "success", { attrs: { tools: toolCalls.length } }));
        return { content: "", toolCalls, usage };
      }
      tracer.end(completion, "success", { usage });
      tracer.end(provider, "success", { usage });
      return { content: "done", toolCalls: [], usage };
    },
  };

  await runAgentLoop("bench tool heavy", {
    host,
    client,
    model: "mock",
    maxTurns: maxRounds + 2,
    parallelToolCalls: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const wall_ms = performance.now() - started;
  return sampleFromSpans({
    fixture: "session.tool_heavy",
    iteration: options.iteration,
    spans: tracer.getSpans(),
    wall_ms,
    outcome: "success",
  });
}

async function runExploreWorkersFixture(workers: 2 | 4 | 8, options: RunFixtureOptions): Promise<PerfSample> {
  const fixture = `explore.workers_${workers}` as FixtureId;
  const tracer = new PerfTracer({ enabled: true });
  const started = performance.now();
  const registration = {
    name: "mock",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:9",
    models: [{
      id: "mock",
      name: "mock",
      reasoning: false,
      input: ["text" as const],
      contextWindow: 128_000,
      maxTokens: 1024,
    }],
  };

  const createClient = (): LlmClient => ({
    async complete(): Promise<ChatCompletionResponse> {
      return {
        content: "evidence:\n```\nconst x = 1;\n```\n",
        toolCalls: [],
        usage: emptyUsage(),
      };
    },
    async *completeStream(): AsyncIterable<StreamEvent> {
      yield { type: "done", content: "evidence", toolCalls: [], usage: emptyUsage() };
    },
  });

  const jobs = Array.from({ length: workers }, (_, i) =>
    tracer.measure("subagent.dispatch", async () => {
      const result = await runExploreSubagent({
        goal: `bench worker ${i}`,
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        registration,
        apiKey: "bench",
        modelId: "mock",
        maxTurns: 1,
        allowBash: false,
        createClient,
      });
      tracer.mark("subagent.evidence_complete", result.success ? "success" : result.cancelled ? "cancelled" : "failure", {
        attrs: { worker: i, tool_calls: result.toolCalls },
        usage: result.usage,
        error_class: result.error ? "subagent" : undefined,
      });
      return result;
    }, {
      attrs: { workers, worker: i },
      outcomeOf: (result) => (result.success ? "success" : result.cancelled ? "cancelled" : "failure"),
      usageOf: (result) => result.usage,
    }),
  );

  await Promise.all(jobs);
  const wall_ms = performance.now() - started;
  return sampleFromSpans({
    fixture,
    iteration: options.iteration,
    spans: tracer.getSpans(),
    wall_ms,
    outcome: "success",
  });
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 1,
    outputTokens: 1,
    cacheTokens: 0,
    reasoningTokens: null,
  };
}

function defaultCliEntry(): string {
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  for (const rel of ["dist/xio.js", "dist/xio.mjs"]) {
    const distEntry = path.join(root, rel);
    if (existsSync(distEntry)) {
      return distEntry;
    }
  }
  return path.join(root, "src/cli/entry.ts");
}

/** Walk up from a module path until package.json name is xiocode (works from src/ and dist/chunks/). */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "xiocode") {
          return dir;
        }
      } catch {
        // continue walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Fallback: two levels up from src/runtime/perf
  return path.resolve(startDir, "../../..");
}



/** AOT dist needs no strip-types flag; TS entry does. */
function cliArgs(entry: string, ...flags: string[]): string[] {
  const isAot = entry.includes(`${path.sep}dist${path.sep}`) && (entry.endsWith(".js") || entry.endsWith(".mjs"));
  return isAot ? [entry, ...flags] : ["--experimental-strip-types", entry, ...flags];
}

function spawnCollect(
  command: string,
  args: readonly string[],
  options: Readonly<{ env: NodeJS.ProcessEnv; timeoutMs: number }>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parsePerfJsonLines(stdout: string): PerfSpan[] {
  const spans: PerfSpan[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("xio-perf-span.v1")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as PerfSpan;
      if (parsed.schema_version === "xio-perf-span.v1" && typeof parsed.name === "string") {
        spans.push(parsed);
      }
    } catch {
      // ignore non-span JSON
    }
  }
  return spans;
}
