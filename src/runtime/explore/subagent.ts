import { ExtensionHost } from "../extension-host.ts";
import { runAgentLoop } from "../agent-loop.ts";
import { createLlmClient } from "../providers/client.ts";
import { createBuiltinTools } from "../tools/builtin.ts";

import type { LlmClient, ProviderRegistration } from "../types.ts";
import type { ExploreSubagentResult } from "./types.ts";

/**
 * Subagent contract (parent → Flash/explore worker):
 * read-only, narrow slice, return faithful file content to main agent (no rewrite, no drop).
 */
const EXPLORE_SYSTEM_PROMPT = [
  "You are a read-only investigation subagent for XioCode.",
  "Your only job: research the **small** slice the main agent assigned to you,",
  "then return **faithful evidence** (paths + file content) to the main agent.",
  "",
  "Permissions:",
  "- Read-only. Tools: read / grep / glob only (bash only if explicitly enabled).",
  "- Never modify files, create/delete paths, apply patches, run installs, or change git state.",
  "- Do not implement fixes, refactors, or write code for the user.",
  "",
  "Scope (narrow by design):",
  "- You own only this one small part — not a whole feature, service, or large subsystem.",
  "- Stay strictly within the dispatched research goal and any focus_paths hints.",
  "- Do not expand into sibling areas; if something is out of scope, note it briefly and stop.",
  "- Prefer grep/glob to locate targets, then **read** each needed file (do not invent contents).",
  "",
  "Fidelity (non-negotiable):",
  "- Paths in the report must be **absolute paths** when known from tool results.",
  "- For every file that matters to the goal, return its **main content as read from disk**:",
  "  use fenced code blocks; copy tool output; do **not** paraphrase, beautify, rename, or invent lines.",
  "- Do **not** omit relevant sections with vague summaries (\"the rest is similar\", \"…handler…\").",
  "- If a file is too large for one reply: state absolute path + total size/lines if known,",
  "  then return **complete contiguous sections** that answer the goal (full functions/types/config blocks),",
  "  never a rewritten or \"cleaned\" version. Mark any hard cut with `[truncated by size — re-read this path]`.",
  "- Uncertainties: only state what you did not open or could not find — never fill gaps with guesses.",
  "",
  "Output shape for the main agent (no user-facing fluff):",
  "1) Slice answer in 1–3 sentences (facts only).",
  "2) Files (absolute path list).",
  "3) Per file: absolute path + verbatim content block(s) from read.",
  "4) Gaps / not found (if any).",
  "- Stop as soon as the assigned goal is answered with evidence.",
].join("\n");

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);
const EXPLORE_TOOLS_WITH_BASH = new Set(["read", "grep", "glob", "bash"]);

export type RunExploreSubagentOptions = Readonly<{
  goal: string;
  focusPaths?: readonly string[];
  cwd: string;
  workspaceRoot: string;
  registration: ProviderRegistration;
  apiKey: string;
  modelId: string;
  maxTurns: number;
  allowBash: boolean;
  signal?: AbortSignal;
  /** Test seam; defaults to provider client factory. */
  createClient?: (input: Readonly<{
    registration: ProviderRegistration;
    apiKey: string;
  }>) => LlmClient;
}>;

/** Nested agent loop on a fresh host — no explore tool (no recursion), no primary extensions. */
export async function runExploreSubagent(
  options: RunExploreSubagentOptions,
): Promise<ExploreSubagentResult> {
  const registration = withModelId(options.registration, options.modelId);
  const host = new ExtensionHost({
    initialModel: {
      provider: registration.name,
      id: options.modelId,
      name: options.modelId,
      api: registration.api,
    },
  });
  const allowed = options.allowBash ? EXPLORE_TOOLS_WITH_BASH : READ_ONLY_TOOLS;
  for (const tool of createBuiltinTools({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
  })) {
    if (allowed.has(tool.name)) {
      host.registerTool(tool);
    }
  }

  const createClient = options.createClient ?? createLlmClient;
  const client = createClient({
    registration,
    apiKey: options.apiKey,
  });

  try {
    const result = await runAgentLoop(formatExploreUserPrompt(options.goal, options.focusPaths), {
      host,
      client,
      model: options.modelId,
      providerApi: registration.api,
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      maxTurns: options.maxTurns,
      parallelToolCalls: true,
      signal: options.signal,
    });
    return {
      provider: registration.name,
      model: options.modelId,
      success: result.success,
      cancelled: result.cancelled,
      text: result.finalText,
      turns: result.turns,
      toolCalls: result.toolCalls,
      toolErrors: result.toolErrors,
      usage: result.usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = options.signal?.aborted === true;
    return {
      provider: registration.name,
      model: options.modelId,
      success: false,
      cancelled,
      text: "",
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheTokens: null,
        reasoningTokens: null,
      },
      error: message,
    };
  }
}

export function formatExploreUserPrompt(goal: string, focusPaths?: readonly string[]): string {
  const lines = [
    "The main agent dispatched this investigation. Stay inside this scope only.",
    `Assigned goal:\n${goal.trim()}`,
  ];
  if (focusPaths && focusPaths.length > 0) {
    lines.push(
      `Scope hints (prioritize these paths; do not wander outside the goal):\n${
        focusPaths.map((p) => `- ${p}`).join("\n")
      }`,
    );
  }
  lines.push(
    [
      "Constraints reminder:",
      "- Read-only: no edits, no writes, no destructive commands.",
      "- Investigate only what this goal requires.",
      "- Final reply to the main agent must include absolute paths and **verbatim** main content",
      "  of files you read (no paraphrase, no inventing, no dropping relevant code).",
      "- Prefer evidence blocks over narrative summary.",
    ].join("\n"),
  );
  return lines.join("\n\n");
}

/** Ensure the explore model id is present so thinking/cost maps can resolve when available. */
export function withModelId(
  registration: ProviderRegistration,
  modelId: string,
): ProviderRegistration {
  if (registration.models.some((model) => model.id === modelId)) {
    return registration;
  }
  const template = registration.models[0];
  return {
    ...registration,
    models: [
      ...registration.models,
      {
        id: modelId,
        name: modelId,
        reasoning: template?.reasoning ?? false,
        thinkingLevelMap: template?.thinkingLevelMap,
        input: template?.input ?? ["text"],
        cost: template?.cost,
        contextWindow: template?.contextWindow ?? 128_000,
        maxTokens: template?.maxTokens ?? 8192,
        headers: template?.headers,
        compat: template?.compat,
      },
    ],
  };
}
