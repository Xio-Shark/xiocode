import { defineTool } from "../define-tool.ts";
import { resolveApiKey } from "../providers/client.ts";
import { Type } from "../schema.ts";

import type { ProviderRegistration, ToolDefinition } from "../types.ts";
import { Semaphore } from "./semaphore.ts";
import { runExploreSubagent } from "./subagent.ts";

import type { ResolvedExploreConfig } from "./types.ts";
import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";

export const EXPLORE_TOOL_NAME = "explore";

/**
 * Static fallback for marker matching in tests.
 * Prefer formatPrimaryExploreAddendum with live scale + cap.
 */
export const PRIMARY_EXPLORE_PROMPT_ADDENDUM = formatPrimaryExploreAddendum({
  maxConcurrency: 4,
  suggestedConcurrency: 4,
});

/** Primary-agent guidance: dynamic fan-out by project scale, tiny slices, flexible partition. */
export function formatPrimaryExploreAddendum(
  options: Readonly<{
    maxConcurrency: number;
    /** Scale-based suggestion (≤ maxConcurrency). Default band ~4 for medium repos. */
    suggestedConcurrency?: number;
    scaleNote?: string;
    partitionHint?: string;
  }>,
): string {
  const cap = Math.min(Math.max(1, options.maxConcurrency), MAX_EXPLORE_CONCURRENCY);
  const suggested = Math.min(
    Math.max(1, options.suggestedConcurrency ?? Math.min(4, cap)),
    cap,
  );
  const lines = [
    "## Multi-explore (read-only subagents)",
    "You have an `explore` tool that runs a faster/cheaper **read-only** subagent on a separate model.",
    "",
    "When to use explore (default for pure reading):",
    "- User wants to understand / locate / survey the repo, or you only need file contents before editing:",
    "  **prefer `explore`** (possibly multiple parallel slices) instead of bulk `read`/`grep` on the main agent.",
    "- Main agent should stay for planning, synthesis, and **write/edit/bash** that change the tree.",
    "- Do not send the whole monorepo as one explore goal — partition into small slices.",
    "",
    `Default budget is small (typically ~4). Hard cap this session: ${cap} concurrent explores `
      + `(absolute max ${MAX_EXPLORE_CONCURRENCY}; raise explore.max_concurrency in config if needed).`,
    `For this workspace, prefer about **${suggested}** concurrent explore call(s) — not always the hard cap.`,
    "Choose worker count from project scale and task breadth: tiny/local work → 1–2; medium → ~4; "
      + "only use more when the repo and the task clearly need wider fan-out (still ≤ hard cap).",
    "Each subagent must own only a **small** slice — never a whole large subsystem.",
    "You choose how to partition (API surface, feature, package/layer, call path, file tree, bug surface, …)",
    "based on the project and the user request; the user may also dictate the partition.",
    "Prefer many narrow explores over few broad ones; if a slice is still large, split further (within the cap).",
    "Issue multiple `explore` tool calls in one turn for parallel slices, then synthesize reports yourself",
    "and implement changes with write/edit/bash. Workers cannot modify files or spawn further explores.",
    "Pass a narrow research `goal` plus optional `focus_paths` for that slice only.",
    "",
    "Trust rules for explore returns:",
    "- Workers must return **absolute paths** and **verbatim file content** for what they read.",
    "- Treat code blocks as source evidence; do not assume they rewrote or \"cleaned\" code.",
    "- If a report is truncated or incomplete, re-explore a narrower path or `read` that absolute path yourself — never invent missing text.",
  ];
  if (options.scaleNote?.trim()) {
    lines.push(`Workspace scale: ${options.scaleNote.trim()}`);
  }
  if (options.partitionHint?.trim()) {
    lines.push(`User/project partition preference: ${options.partitionHint.trim()}`);
  }
  return lines.join("\n");
}

export type CreateExploreToolOptions = Readonly<{
  config: ResolvedExploreConfig;
  cwd: string;
  workspaceRoot: string;
  getProvider: (name: string) => ProviderRegistration | undefined;
  env?: NodeJS.ProcessEnv;
  onNotify?: (message: string) => void;
}>;

export function createExploreTool(options: CreateExploreToolOptions): ToolDefinition {
  const gate = new Semaphore(Math.min(options.config.maxConcurrency, MAX_EXPLORE_CONCURRENCY));
  const env = options.env ?? process.env;

  const maxParallel = Math.min(options.config.maxConcurrency, MAX_EXPLORE_CONCURRENCY);
  return defineTool({
    name: EXPLORE_TOOL_NAME,
    label: "Explore",
    description:
      "Spawn one read-only subagent for a **small** research slice (not a whole feature/module). "
      + "Prefer this for pure repo reading/location so the main context stays light. "
      + `Call multiple times in parallel (max ${maxParallel}) with different narrow goals. `
      + "Returns absolute paths + verbatim file content for that slice (not a rewritten summary).",
    promptSnippet: "Read-only explore subagents: narrow slices, faithful file content back",
    parameters: Type.Object({
      goal: Type.String({
        description:
          "One narrow research question for this worker only. Do not pack multiple areas into one goal.",
      }),
      focus_paths: Type.Array(Type.String({ description: "Optional path/glob hints." }), {
        description: "Paths for this slice only; keep the worker inside a small boundary.",
      }),
      max_turns: Type.Number({
        description: `Optional turn cap for this worker (1–${options.config.maxTurns}, default config).`,
      }),
    }, { required: ["goal"] }),
    async execute(_id, params, ctx) {
      const goal = typeof params.goal === "string" ? params.goal.trim() : "";
      if (goal.length === 0) {
        return {
          content: [{ type: "text", text: "explore error: goal is required" }],
          isError: true,
        };
      }
      const focusPaths = parseFocusPaths(params.focus_paths);
      const maxTurns = clampTurns(params.max_turns, options.config.maxTurns);
      const registration = options.getProvider(options.config.provider);
      if (!registration) {
        return {
          content: [{
            type: "text",
            text: `explore error: provider not registered: ${options.config.provider}`,
          }],
          isError: true,
        };
      }

      let release: (() => void) | undefined;
      const timeout = createTimeoutSignal(ctx?.signal, options.config.timeoutMs);
      try {
        release = await gate.acquire();
        options.onNotify?.(
          `explore → ${options.config.provider}/${options.config.model}: ${truncate(goal, 80)}`,
        );
        let apiKey: string;
        try {
          apiKey = resolveApiKey(registration, env);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `explore error: ${message}` }],
            isError: true,
          };
        }

        const result = await runExploreSubagent({
          goal,
          focusPaths,
          cwd: options.cwd,
          workspaceRoot: options.workspaceRoot,
          registration,
          apiKey,
          modelId: options.config.model,
          maxTurns,
          allowBash: options.config.allowBash,
          signal: timeout.signal,
        });

        if (timeout.timedOut) {
          return {
            content: [{
              type: "text",
              text: formatExploreResult({
                ...result,
                success: false,
                timedOut: true,
                error: result.error ?? `timed out after ${options.config.timeoutMs}ms`,
                text: result.text,
              }, options.config.maxOutputChars),
            }],
            isError: true,
            details: { explore: { ...result, timedOut: true } },
          };
        }

        return {
          content: [{
            type: "text",
            text: formatExploreResult(result, options.config.maxOutputChars),
          }],
          isError: result.success === false,
          details: { explore: result },
        };
      } finally {
        timeout.dispose();
        release?.();
      }
    },
  });
}

export function formatExploreResult(
  result: Readonly<{
    provider: string;
    model: string;
    success: boolean;
    cancelled?: boolean;
    timedOut?: boolean;
    text: string;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    error?: string;
  }>,
  maxOutputChars: number,
): string {
  const status = result.timedOut
    ? "timeout"
    : result.cancelled
      ? "cancelled"
      : result.success
        ? "ok"
        : "error";
  const body = result.error && result.text.length === 0
    ? result.error
    : truncate(result.text.trim() || result.error || "(empty report)", maxOutputChars);
  return [
    `## Explore report (${status})`,
    `model: ${result.provider}/${result.model}`,
    `turns: ${result.turns}  tool_calls: ${result.toolCalls}  tool_errors: ${result.toolErrors}`,
    "",
    body,
  ].join("\n");
}

function parseFocusPaths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const paths = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function clampTurns(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return max;
  }
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return (
    `${text.slice(0, maxChars)}\n`
    + `…[truncated ${omitted} chars by explore.max_output_chars — `
    + "do not invent omitted text; re-explore a smaller path or raise max_output_chars / read the absolute path]"
  );
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => {
    controller.abort();
  };
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut;
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
