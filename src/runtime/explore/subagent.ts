import { ExtensionHost } from "../extension-host.ts";
import { runAgentLoop } from "../agent-loop.ts";
import { createLlmClient } from "../providers/client.ts";
import { createBuiltinTools } from "../tools/builtin.ts";
import {
  PERCEPTION_TOOL_NAMES,
  registerPerceptionCapability,
  WorkspacePerceptionService,
} from "../workspace/index.ts";

import type { LlmClient, ProviderRegistration } from "../types.ts";
import { formatCapsuleForPrompt, type PolicyCapsule } from "./capsule.ts";
import type { ExploreRoleId } from "./roles.ts";
import type { ExploreSubagentResult } from "./types.ts";
import {
  scopeSubagentToolCall,
  type SubagentUiScope,
} from "./subagent-ui.ts";

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
  "- Read-only. Tools: read / grep / glob / query_workspace / read_evidence (bash only if explicitly enabled).",
  "- Never modify files, create/delete paths, apply patches, run installs, or change git state.",
  "- Do not implement fixes, refactors, or write code for the user.",
  "",
  "Scope (narrow by design):",
  "- You own only this one small part — not a whole feature, service, or large subsystem.",
  "- Stay strictly within the dispatched research goal and any focus_paths hints.",
  "- Do not expand into sibling areas; if something is out of scope, note it briefly and stop.",
  "- Prefer query_workspace for structure, then grep/glob, then **read** each needed file (do not invent contents).",
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

const ROLE_FOCUS: Readonly<Record<ExploreRoleId, string>> = {
  locator: "Focus: paths, symbols, entrypoints, package boundaries.",
  flow_analyst: "Focus: call flow, data path, control flow across modules.",
  impact_test: "Focus: dependents, tests, blast radius, failure ownership.",
  adversarial: "Focus: gaps, contradictions, missed edges, over-claimed evidence.",
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", ...PERCEPTION_TOOL_NAMES]);
const EXPLORE_TOOLS_WITH_BASH = new Set(["read", "grep", "glob", "bash", ...PERCEPTION_TOOL_NAMES]);

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
  /** Dispatcher-assigned specialized role (optional). */
  role?: ExploreRoleId;
  /** Binding policy capsule from dispatcher (optional). */
  capsule?: PolicyCapsule;
  /** Shared session perception service; workers create a local warm map if omitted. */
  workspacePerception?: WorkspacePerceptionService;
  /** Override system prompt (failure-draft sibling uses a concise drafting prompt). */
  systemPrompt?: string;
  /** Override user prompt; defaults to formatExploreUserPrompt(goal, focusPaths, role). */
  userPrompt?: string;
  /** Test seam; defaults to provider client factory. */
  createClient?: (input: Readonly<{
    registration: ProviderRegistration;
    apiKey: string;
  }>) => LlmClient;
  /** Optional UI scope — nested loop streams here; never primary session history. */
  ui?: SubagentUiScope;
}>;

/**
 * Failure-statement drafter (sibling of explore evidence dump).
 * Same read-only tool host; output is a short operator-facing statement, not a full report.
 */
const FAILURE_DRAFT_SYSTEM_PROMPT = [
  "You are a read-only failure-statement drafter for XioCode private regression capture.",
  "Your only job: gather last errors / tool failures / relevant paths from run artifacts",
  "and the workspace, then draft a concise operator-facing failure_statement.",
  "",
  "Permissions:",
  "- Read-only. Tools: read / grep / glob / query_workspace / read_evidence.",
  "- Never modify files, run bash, apply patches, or change git state.",
  "- Do not implement fixes or write code.",
  "",
  "Output (non-negotiable):",
  "- 2–8 short sentences or bullet lines the operator can confirm as failure_statement.",
  "- Name concrete paths, tool errors, and exit/status facts when known.",
  "- Do NOT dump verbatim file contents, long evidence blocks, or a full explore report.",
  "- Do NOT invent failures you did not observe in tools or the seed.",
  "- Stop as soon as the statement is grounded enough for the operator to edit.",
].join("\n");

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
  const perception = options.workspacePerception
    ?? new WorkspacePerceptionService({ root: options.workspaceRoot });
  if (!options.workspacePerception) {
    void perception.ensureWarm();
  }
  // Read-only query/evidence path; no prompt addendum (explore system prompt already covers tools).
  registerPerceptionCapability(host, { service: perception, injectPrompt: false });

  const createClient = options.createClient ?? createLlmClient;
  const client = createClient({
    registration,
    apiKey: options.apiKey,
  });

  const { getGlobalTracer, classifyUnknownError } = await import("../perf/index.ts");
  const tracer = getGlobalTracer();
  const dispatch = tracer?.start("subagent.dispatch", {
    attrs: {
      model: options.modelId,
      allow_bash: options.allowBash,
      ...(options.role ? { role: options.role } : {}),
    },
  });
  const ui = options.ui;
  const lifecycleMeta = ui
    ? {
        workerId: ui.workerId,
        modelLabel: ui.modelLabel,
        role: ui.role,
        goal: options.goal,
      }
    : undefined;
  try {
    if (lifecycleMeta) {
      ui?.sink.onLifecycle?.("start", lifecycleMeta);
    }
    const modelCfg = registration.models.find((entry) => entry.id === options.modelId)
      ?? registration.models[0];
    host.registerProvider(registration.name, registration);
    const systemPrompt = options.systemPrompt
      ?? buildExploreSystemPrompt(options.role, options.capsule);
    const userPrompt = options.userPrompt
      ?? formatExploreUserPrompt(options.goal, options.focusPaths, options.role);
    const result = await runAgentLoop(
      userPrompt,
      {
        host,
        client,
        model: options.modelId,
        providerApi: registration.api,
        providerName: registration.name,
        systemPrompt,
        maxTurns: options.maxTurns,
        maxTokens: modelCfg?.maxTokens,
        toolChoice: registration.toolChoice,
        toolChoiceScope: registration.toolChoiceScope,
        parallelToolCalls: true,
        signal: options.signal,
        onThinkingDelta: (text) => ui?.sink.onThinkingDelta?.(text),
        onAssistantDelta: (text) => ui?.sink.onAssistantDelta?.(text),
        onAssistantText: (text) => ui?.sink.onAssistantText?.(text),
        onToolStart: (call) => ui?.sink.onToolStart?.(scopeSubagentToolCall(ui.workerId, call)),
        onToolEnd: (call, toolResult) => ui?.sink.onToolEnd?.(
          scopeSubagentToolCall(ui.workerId, call),
          toolResult,
        ),
      },
    );
    const outcome = result.cancelled ? "cancelled" : result.success ? "success" : "failure";
    if (lifecycleMeta) {
      ui?.sink.onLifecycle?.("end", {
        ...lifecycleMeta,
        success: result.success && !result.cancelled,
        status: outcome,
      });
    }
    tracer?.end(dispatch, outcome, {
      usage: result.usage,
      attrs: {
        turns: result.turns,
        tool_calls: result.toolCalls,
        tool_errors: result.toolErrors,
        ...(options.role ? { role: options.role } : {}),
      },
      ...(result.cancelled ? { error_class: "abort" } : {}),
    });
    tracer?.mark("subagent.evidence_complete", outcome, {
      usage: result.usage,
      attrs: {
        text_chars: result.finalText.length,
        tool_calls: result.toolCalls,
        ...(options.role ? { role: options.role } : {}),
      },
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
    const classified = classifyUnknownError(error);
    const outcome = cancelled ? "cancelled" : classified.outcome;
    if (lifecycleMeta) {
      ui?.sink.onLifecycle?.("end", {
        ...lifecycleMeta,
        success: false,
        status: outcome,
      });
    }
    tracer?.end(dispatch, outcome, { error_class: classified.error_class });
    tracer?.mark("subagent.evidence_complete", outcome, { error_class: classified.error_class });
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

/**
 * Thin explore sibling: same tool host + allowBash:false, drafting-focused prompts.
 * Prefer this over raw explore when the caller needs a short failure_statement.
 */
export async function runFailureDraftSubagent(
  options: Omit<RunExploreSubagentOptions, "allowBash" | "systemPrompt" | "userPrompt"> & Readonly<{
    /** Deterministic artifact seed (optional); included in the user prompt. */
    artifactSeed?: string;
  }>,
): Promise<ExploreSubagentResult> {
  const { artifactSeed, ...exploreOptions } = options;
  return runExploreSubagent({
    ...exploreOptions,
    allowBash: false,
    systemPrompt: FAILURE_DRAFT_SYSTEM_PROMPT,
    userPrompt: formatFailureDraftUserPrompt(options.goal, artifactSeed, options.focusPaths),
  });
}

export function formatFailureDraftUserPrompt(
  goal: string,
  artifactSeed?: string,
  focusPaths?: readonly string[],
): string {
  const lines = [
    "Draft a concise failure_statement for private regression capture.",
    `Operator goal / signal context:\n${goal.trim()}`,
  ];
  if (artifactSeed?.trim()) {
    lines.push(`Artifact seed (refine or replace with better evidence; do not invent beyond this + tools):\n${artifactSeed.trim()}`);
  }
  if (focusPaths && focusPaths.length > 0) {
    lines.push(
      `Prefer these paths first:\n${focusPaths.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  lines.push(
    [
      "Constraints:",
      "- Read-only; no bash.",
      "- Final reply = the failure_statement only (2–8 sentences/bullets).",
      "- No full file dumps; cite paths briefly when useful.",
    ].join("\n"),
  );
  return lines.join("\n\n");
}

export function formatExploreUserPrompt(
  goal: string,
  focusPaths?: readonly string[],
  role?: ExploreRoleId,
): string {
  const lines = [
    "The main agent dispatched this investigation. Stay inside this scope only.",
    `Assigned goal:\n${goal.trim()}`,
  ];
  if (role) {
    lines.push(`Assigned role: **${role}**. ${ROLE_FOCUS[role]}`);
  }
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

function buildExploreSystemPrompt(
  role: ExploreRoleId | undefined,
  capsule: PolicyCapsule | undefined,
): string {
  const parts = [EXPLORE_SYSTEM_PROMPT];
  if (role) {
    parts.push(`### Role\n${role}\n${ROLE_FOCUS[role]}`);
  }
  if (capsule) {
    parts.push(formatCapsuleForPrompt(capsule));
  }
  return parts.join("\n\n");
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
        reasoning: template?.reasoning ?? true,
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
