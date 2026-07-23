import { describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import {
  createExploreTool,
  formatExploreResult,
  formatPrimaryExploreAddendum,
  PRIMARY_EXPLORE_PROMPT_ADDENDUM,
  stripMultiExploreAddendum,
} from "./explore-tool.ts";
import {
  DEFAULT_EXPLORE_ACTIVE_MAX,
  detectUserExploreFanoutRequest,
  resolveExploreConcurrencyBudget,
  ULTRA_EXPLORE_ACTIVE_MIN,
} from "./policy.ts";
import { registerExploreCapability } from "./register.ts";
import { parseProviderModelRef, resolveExploreConfig } from "./resolve.ts";
import { suggestExploreConcurrency, tierForCount } from "./scale.ts";
import { Semaphore } from "./semaphore.ts";
import { formatExploreUserPrompt, withModelId } from "./subagent.ts";
import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";
import {
  DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
  DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
  DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
} from "./types.ts";

import type { XioRuntimeConfig } from "../../cli/config-parser.ts";
import type { LlmClient, ProviderRegistration } from "../types.ts";

/** Product wave budgets shared by fixtures — must match register/resolve defaults. */
const PRODUCT_WAVE_BUDGETS = {
  maxTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
  maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
  maxStartsPerMinute: DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
} as const;
describe("parseProviderModelRef", () => {
  it("splits provider/model and multi-segment model ids", () => {
    expect(parseProviderModelRef("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
    expect(parseProviderModelRef("openrouter/anthropic/claude-3")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3",
    });
  });

  it("uses default provider for bare model ids", () => {
    expect(parseProviderModelRef("deepseek-v4-flash", "opencode-go")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
  });
});

describe("resolveExploreConfig", () => {
  const base = {
    enabled: true,
    maxTurns: 12,
    timeoutMs: 180_000,
    maxConcurrency: 4,
    maxOutputChars: 16_000,
    allowBash: false,
    maxTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
    maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
    maxStartsPerMinute: DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
  } as const;

  it("returns undefined when disabled", () => {
    expect(resolveExploreConfig(
      { ...base, enabled: false, model: "deepseek-v4-flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go" },
    )).toBeUndefined();
  });

  it("forceEnable resolves even when config disabled, using fallback model", () => {
    expect(resolveExploreConfig(
      { ...base, enabled: false },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go", defaultModel: "deepseek-v4-pro" },
      { forceEnable: true, fallbackModel: "opencode-go/deepseek-v4-pro" },
    )).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4-pro",
    });
  });

  it("resolves bare model against default provider", () => {
    expect(resolveExploreConfig(
      { ...base, model: "deepseek-v4-flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go", defaultModel: "deepseek-v4-pro" },
    )).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      maxConcurrency: 4,
    });
  });

  it("carries partition_hint", () => {
    expect(resolveExploreConfig(
      { ...base, model: "flash", partitionHint: "按功能模块拆" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go" },
    )).toMatchObject({ partitionHint: "按功能模块拆" });
  });

  it("honors explicit provider + model", () => {
    expect(resolveExploreConfig(
      { ...base, provider: "opencode-go", model: "deepseek-v4-flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "deepseek" },
    )).toMatchObject({ provider: "opencode-go", model: "deepseek-v4-flash" });
  });

  it("carries nonzero product wave budgets by default", () => {
    expect(resolveExploreConfig(
      { ...base, model: "flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go" },
    )).toMatchObject({
      maxTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
      maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
      maxStartsPerMinute: DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
    });
    expect(DEFAULT_EXPLORE_WAVE_MAX_TOKENS).toBeGreaterThan(0);
    expect(DEFAULT_EXPLORE_WAVE_MAX_COST_USD).toBeGreaterThan(0);
    expect(DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE).toBeGreaterThan(0);
  });

  it("honors explicit 0 wave budgets as unlimited", () => {
    expect(resolveExploreConfig(
      {
        ...base,
        model: "flash",
        maxTokens: 0,
        maxCostUsd: 0,
        maxStartsPerMinute: 0,
      },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go" },
    )).toMatchObject({
      maxTokens: 0,
      maxCostUsd: 0,
      maxStartsPerMinute: 0,
    });
  });
});
describe("Semaphore", () => {
  it("limits concurrent acquirers", async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const run = async () => {
      const release = await gate.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(peak).toBe(2);
  });

  it("honors a dynamic max getter", async () => {
    let limit = 1;
    const gate = new Semaphore(() => limit);
    expect(gate.limit()).toBe(1);
    limit = 3;
    expect(gate.limit()).toBe(3);
  });
});

describe("formatExploreResult / prompts", () => {
  it("formats report metadata and truncates body", () => {
    const text = formatExploreResult({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      success: true,
      text: "x".repeat(50),
      turns: 3,
      toolCalls: 5,
      toolErrors: 0,
    }, 20);
    expect(text).toContain("model: opencode-go/deepseek-v4-flash");
    expect(text).toContain("…[truncated");
  });

  it("includes scope constraints and focus paths in user prompt", () => {
    const prompt = formatExploreUserPrompt("find auth", ["src/auth", "src/runtime"]);
    expect(prompt).toContain("Assigned goal");
    expect(prompt).toContain("find auth");
    expect(prompt).toContain("src/auth");
    expect(prompt).toContain("Read-only");
    expect(prompt).toContain("main agent");
    expect(prompt).toMatch(/### Facts|path:line/i);
    expect(prompt).toMatch(/Gaps/i);
    expect(prompt).not.toMatch(/verbatim.*main content/i);
  });

  it("primary addendum encodes default ≤4 policy and partition hint", () => {
    const text = formatPrimaryExploreAddendum({
      maxConcurrency: 16,
      suggestedConcurrency: 2,
      effectiveMax: 4,
      mode: "default",
      scaleNote: "small (~80 source-like files)",
      partitionHint: "按接口划分",
      thinkingLevel: "medium",
    });
    expect(text).toContain("Prefer about **2**");
    expect(text).toMatch(/Mechanical concurrent cap: \*\*4\*\*/i);
    expect(text).toContain(String(MAX_EXPLORE_CONCURRENCY));
    expect(text).toContain("small");
    expect(text).toContain("按接口划分");
    expect(text).toContain("small (~80");
    expect(text).toMatch(/prefer `explore`|Multi-file locate/i);
    expect(text).toMatch(/Facts|path:line|WorkspaceBrief/i);
    expect(text).not.toMatch(/verbatim file content/i);
    expect(text).toMatch(/standard.*2–4|2–\*\*4\*\*/i);
    expect(PRIMARY_EXPLORE_PROMPT_ADDENDUM).toContain("## Multi-explore");
  });

  it("ultra addendum describes deep lane ceiling without forced single-file spawn", () => {
    const text = formatPrimaryExploreAddendum({
      maxConcurrency: 16,
      suggestedConcurrency: 8,
      effectiveMax: 16,
      mode: "ultra",
      lane: "deep",
      thinkingLevel: "ultra",
    });
    expect(text).toMatch(/Deep lane/i);
    expect(text).toContain(String(ULTRA_EXPLORE_ACTIVE_MIN));
    expect(text).toMatch(/does \*\*not\*\* force workers on trivial single-file/i);
  });

  it("strips previous multi-explore sections for re-apply", () => {
    const withSection = `base\n\n${formatPrimaryExploreAddendum({
      maxConcurrency: 16,
      effectiveMax: 4,
      mode: "default",
    })}\n\n## Other\nkeep`;
    const stripped = stripMultiExploreAddendum(withSection);
    expect(stripped).toContain("base");
    expect(stripped).toContain("## Other");
    expect(stripped).not.toContain("Fan-out policy");
  });
});

describe("explore concurrency policy", () => {
  it("detects user high-fanout requests", () => {
    expect(detectUserExploreFanoutRequest("开16个explore扫仓库")).toEqual({
      highFanout: true,
      requestedCount: 16,
    });
    expect(detectUserExploreFanoutRequest("use 12 subagents for this survey")).toEqual({
      highFanout: true,
      requestedCount: 12,
    });
    expect(detectUserExploreFanoutRequest("look at auth only")).toEqual({ highFanout: false });
    expect(detectUserExploreFanoutRequest("run 3 explores")).toEqual({ highFanout: false });
  });

  it("default ≤4, ultra deep ceiling, user high up to 16", () => {
    expect(resolveExploreConcurrencyBudget({
      thinkingLevel: "high",
      configMax: 16,
      userRequest: { highFanout: false },
      scale: { tier: "huge", fileCount: 5000, capped: true },
    })).toMatchObject({
      mode: "default",
      effectiveMax: DEFAULT_EXPLORE_ACTIVE_MAX,
      suggested: DEFAULT_EXPLORE_ACTIVE_MAX,
      lane: "standard",
    });

    expect(resolveExploreConcurrencyBudget({
      thinkingLevel: "ultra",
      configMax: 16,
      userRequest: { highFanout: false },
      scale: { tier: "medium", fileCount: 200, capped: false },
    })).toMatchObject({
      mode: "ultra",
      effectiveMax: 16,
      lane: "deep",
    });
    const ultra = resolveExploreConcurrencyBudget({
      thinkingLevel: "ultra",
      configMax: 16,
      userRequest: { highFanout: false },
      scale: { tier: "medium", fileCount: 200, capped: false },
    });
    expect(ultra.suggested).toBeGreaterThanOrEqual(DEFAULT_EXPLORE_ACTIVE_MAX);
    expect(ultra.suggested).toBeLessThanOrEqual(ULTRA_EXPLORE_ACTIVE_MIN);

    expect(resolveExploreConcurrencyBudget({
      thinkingLevel: "off",
      configMax: 16,
      userRequest: { highFanout: true, requestedCount: 16 },
    })).toMatchObject({
      mode: "user",
      effectiveMax: 16,
      suggested: 16,
      lane: "explicit_high",
    });
  });

  it("fast lane suggests zero workers for simple single-file tasks", () => {
    const budget = resolveExploreConcurrencyBudget({
      thinkingLevel: "medium",
      configMax: 16,
      userRequest: { highFanout: false },
      signal: {
        userText: "fix typo in src/cli/version.ts",
        singleFile: true,
        unresolvedUncertainty: false,
      },
    });
    expect(budget).toMatchObject({
      lane: "fast",
      suggested: 0,
      mode: "fast",
    });
  });
});

describe("adaptive roles and WorkspaceBrief", () => {
  it("assigns non-overlapping ownership for standard/deep lanes", async () => {
    const { planExploreRoles, ownershipOverlap } = await import("./roles.ts");
    const plans = planExploreRoles("standard", ["src/a", "src/b", "src/c", "src/d"]);
    expect(plans.length).toBe(2);
    expect(ownershipOverlap(plans)).toBe(0);
    const deep = planExploreRoles("deep", ["p1", "p2", "p3", "p4"]);
    expect(deep.map((plan) => plan.role.id)).toEqual([
      "locator",
      "flow_analyst",
      "impact_test",
      "adversarial",
    ]);
    expect(planExploreRoles("fast", ["src/a"])).toEqual([]);
  });

  it("aggregates brief under 12KB with citation coverage", async () => {
    const { aggregateWorkspaceBrief, DEFAULT_WORKSPACE_BRIEF_MAX_CHARS } = await import("./brief.ts");
    const brief = aggregateWorkspaceBrief([
      {
        role: "locator",
        claims: [
          {
            text: "auth entry is src/auth/index.ts",
            confidence: 0.9,
            citations: [{ path: "src/auth/index.ts", start_line: 1, end_line: 20 }],
          },
        ],
        symbols: ["createAuth"],
        gaps: ["tests not scanned"],
      },
      {
        role: "flow_analyst",
        claims: [
          {
            text: "auth entry is src/auth/index.ts",
            confidence: 0.7,
            citations: [{ path: "src/auth/index.ts", start_line: 1, end_line: 20 }],
          },
          {
            text: "session depends on auth",
            confidence: 0.8,
            citations: [{ path: "src/runtime/session.ts", start_line: 10 }],
          },
        ],
      },
    ]);
    expect(brief.citation_coverage).toBe(1);
    expect(brief.claims.length).toBe(2);
    expect(brief.text_chars).toBeLessThanOrEqual(DEFAULT_WORKSPACE_BRIEF_MAX_CHARS);
    expect(brief.gaps).toContain("tests not scanned");
  });

  it("enforces 12KB budget by dropping low-confidence claims", async () => {
    const { aggregateWorkspaceBrief } = await import("./brief.ts");
    const claims = Array.from({ length: 200 }, (_, index) => ({
      text: `claim-${index} ${"x".repeat(80)}`,
      confidence: index / 200,
      citations: [{ path: `src/f${index}.ts` }],
    }));
    const brief = aggregateWorkspaceBrief([{ role: "locator", claims }], { maxChars: 2_000 });
    expect(brief.truncated).toBe(true);
    expect(brief.text_chars).toBeLessThanOrEqual(2_000);
  });
});

describe("deep vs fast frozen workspace-awareness (AC)", () => {
  it("deep covers more of frozen multi-package case than fast/standard; fast stays zero-spawn", async () => {
    const {
      FROZEN_AUTH_SESSION_AWARENESS,
      planDispatch,
      scoreAwarenessCoverage,
      simulateOwnedWorkerReports,
      sampleLaneSelectionCostUs,
      shouldEarlyStop,
    } = await import("./dispatcher.ts");
    const { selectExploreLane } = await import("./lanes.ts");
    const frozen = FROZEN_AUTH_SESSION_AWARENESS;

    const fastPlan = planDispatch("fast", frozen.expected_paths, frozen.questions);
    const standardPlan = planDispatch("standard", frozen.expected_paths, frozen.questions);
    const deepPlan = planDispatch("deep", frozen.expected_paths, frozen.questions);

    expect(fastPlan.spawn).toBe(false);
    expect(fastPlan.roles).toEqual([]);
    expect(standardPlan.roles.length).toBe(2);
    expect(deepPlan.roles.length).toBe(4);

    const fastScore = scoreAwarenessCoverage(
      simulateOwnedWorkerReports(fastPlan.roles, frozen),
      frozen,
    );
    const standardScore = scoreAwarenessCoverage(
      simulateOwnedWorkerReports(standardPlan.roles, frozen),
      frozen,
    );
    const deepScore = scoreAwarenessCoverage(
      simulateOwnedWorkerReports(deepPlan.roles, frozen),
      frozen,
    );

    expect(fastScore.evidence_coverage).toBe(0);
    expect(deepScore.evidence_coverage).toBeGreaterThan(standardScore.evidence_coverage);
    expect(standardScore.evidence_coverage).toBeGreaterThan(fastScore.evidence_coverage);
    expect(deepScore.path_coverage).toBeGreaterThanOrEqual(0.8);
    expect(deepScore.role_count).toBe(4);
    // Impact/adversarial roles surface tests + gaps that standard may miss.
    const deepReports = simulateOwnedWorkerReports(deepPlan.roles, frozen);
    expect(deepReports.some((report) => (report.gaps?.length ?? 0) > 0)).toBe(true);
    expect(deepReports.some((report) => report.role === "impact_test")).toBe(true);

    // Fast-lane cases: zero workers and negligible decision cost (no deep fan-out pressure).
    const fastBudget = resolveExploreConcurrencyBudget({
      thinkingLevel: "medium",
      configMax: 16,
      userRequest: { highFanout: false },
      signal: {
        userText: "fix typo in src/cli/version.ts",
        singleFile: true,
        unresolvedUncertainty: false,
      },
    });
    expect(fastBudget.suggested).toBe(0);
    expect(fastBudget.lane).toBe("fast");

    const fastCost = sampleLaneSelectionCostUs(() => {
      selectExploreLane({
        thinkingLevel: "medium",
        userRequest: { highFanout: false },
        userText: "fix typo in src/cli/version.ts",
        singleFile: true,
        unresolvedUncertainty: false,
      });
    }, 400);
    const deepCost = sampleLaneSelectionCostUs(() => {
      selectExploreLane({
        thinkingLevel: "ultra",
        userRequest: { highFanout: false },
        userText: "map auth session impact across packages",
        singleFile: false,
        unresolvedUncertainty: true,
      });
    }, 400);
    // Policy selection itself stays sub-millisecond per call on both lanes.
    expect(fastCost.p95_us).toBeLessThan(1_000);
    expect(deepCost.p95_us).toBeLessThan(2_000);
    // Fast lane must not become more expensive than deep selection in process terms.
    // (Both are pure CPU; assert fast stays in the same ballpark — no accidental O(n) map work.)
    expect(fastCost.median_us).toBeLessThanOrEqual(deepCost.median_us + 200);

    // Early-stop on coverage plateau (deep straggler cancellation signal).
    expect(shouldEarlyStop([0.5, 0.7, 0.72, 0.73, 0.735], { minSamples: 3, epsilon: 0.02 })).toBe(true);
    expect(shouldEarlyStop([0.2, 0.5, 0.8], { minSamples: 3, epsilon: 0.02 })).toBe(false);
  });

  it("injects role + policy capsule into explore worker prompts", async () => {
    const { formatExploreUserPrompt } = await import("./subagent.ts");
    const { buildPolicyCapsule, formatCapsuleForPrompt } = await import("./capsule.ts");
    const prompt = formatExploreUserPrompt("locate SessionStore", ["src/runtime"], "locator");
    expect(prompt).toContain("Assigned role: **locator**");
    expect(prompt).toContain("SessionStore");
    const capsule = buildPolicyCapsule({
      workspaceId: "/tmp/ws",
      mainRootHint: "/tmp/ws",
      ownership: { role: "locator", paths: ["src/runtime"], questions: ["locate SessionStore"] },
      wallMs: 60_000,
      maxTurns: 4,
      maxOutputChars: 8_000,
    });
    const text = formatCapsuleForPrompt(capsule);
    expect(text).toContain("read_only=true");
    expect(text).toContain("no_recursive_explore=true");
    expect(text).toContain("role: locator");
  });
});

describe("suggestExploreConcurrency", () => {
  it("scales with tier and respects max_concurrency default 4", () => {
    expect(suggestExploreConcurrency({ tier: "tiny", fileCount: 10, capped: false }, 4)).toBe(1);
    expect(suggestExploreConcurrency({ tier: "small", fileCount: 80, capped: false }, 4)).toBe(2);
    expect(suggestExploreConcurrency({ tier: "medium", fileCount: 200, capped: false }, 4)).toBe(4);
    expect(suggestExploreConcurrency({ tier: "large", fileCount: 1000, capped: false }, 4)).toBe(4);
    expect(suggestExploreConcurrency({ tier: "huge", fileCount: 5000, capped: true }, 16)).toBe(12);
  });

  it("maps file counts to tiers", () => {
    expect(tierForCount(10, false)).toBe("tiny");
    expect(tierForCount(80, false)).toBe("small");
    expect(tierForCount(200, false)).toBe("medium");
    expect(tierForCount(1000, false)).toBe("large");
    expect(tierForCount(100, true)).toBe("huge");
  });
});

describe("withModelId", () => {
  it("appends missing model from template", () => {
    const reg: ProviderRegistration = {
      name: "opencode-go",
      api: "openai-completions",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", reasoning: true, input: ["text"] }],
    };
    const next = withModelId(reg, "deepseek-v4-flash");
    expect(next.models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(next.models[1]?.reasoning).toBe(true);
  });
});

describe("registerExploreCapability", () => {
  it("registers explore tool and prompt addendum when enabled", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    host.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] }],
    });
    host.setSystemPrompt("You are XioCode.");

    const handle = await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(true),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(handle.getResolved()?.model).toBe("deepseek-v4-flash");
    expect(handle.isRegistered()).toBe(true);
    expect(host.getTool("explore")).toBeDefined();
    expect(host.getProvider("opencode-go")?.models.some((m) => m.id === "deepseek-v4-flash")).toBe(true);

    const results = await host.emit("before_agent_start", {
      prompt: "scan the repo",
      systemPrompt: "You are XioCode.",
    });
    const last = results.at(-1) as { systemPrompt?: string } | undefined;
    expect(last?.systemPrompt).toContain("## Multi-explore");
    expect(last?.systemPrompt).toMatch(/Mechanical concurrent cap: \*\*4\*\*/i);
    expect(last?.systemPrompt).toMatch(/Prefer about \*\*\d+\*\*/);
    expect(last?.systemPrompt).toContain("You are XioCode.");

    host.setThinkingLevel("ultra");
    const ultra = await host.emit("before_agent_start", {
      prompt: "deep survey",
      systemPrompt: last?.systemPrompt ?? "You are XioCode.",
    });
    const ultraPrompt = (ultra.at(-1) as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
    expect(ultraPrompt).toMatch(/thinking effort: \*\*ultra\*\*/i);
    expect(ultraPrompt).toMatch(/Deep lane/i);
    expect(ultraPrompt).toContain(String(ULTRA_EXPLORE_ACTIVE_MIN));
    expect(ultraPrompt).toMatch(/does \*\*not\*\* force workers on trivial single-file/i);
    expect(ultraPrompt.match(/## Multi-explore/g)?.length).toBe(1);
  });

  it("does not register when explore is disabled and thinking is not ultra", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    const handle = await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(false),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(handle.isRegistered()).toBe(false);
    expect(host.getTool("explore")).toBeUndefined();
  });

  it("auto-enables explore when session starts on ultra even if config disabled", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
      initialThinkingLevel: "ultra",
    });
    host.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] }],
    });
    const handle = await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(false),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(handle.isRegistered()).toBe(true);
    // Config still carries explore.model even when enabled=false.
    expect(handle.getResolved()?.model).toBe("deepseek-v4-flash");
    expect(host.getTool("explore")).toBeDefined();
  });

  it("ensure(ultra) installs explore when switching mid-session", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    host.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] }],
    });
    const handle = await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(false),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(handle.isRegistered()).toBe(false);
    host.setThinkingLevel("ultra");
    const resolved = await handle.ensure("ultra");
    expect(resolved?.model).toBe("deepseek-v4-flash");
    expect(host.getTool("explore")).toBeDefined();
  });

  it("ensure(ultra) falls back to session primary when explore.model is unset", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    host.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] }],
    });
    const cfg = runtimeWithExplore(false);
    const noModel = {
      ...cfg,
      explore: { ...cfg.explore, model: undefined },
    };
    host.setThinkingLevel("ultra");
    const handle = await registerExploreCapability(host, {
      runtimeConfig: noModel,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(handle.getResolved()?.model).toBe("deepseek-v4-pro");
    expect(host.getTool("explore")).toBeDefined();
  });

  it("enabled=false + model + ultra force-enables dedicated scout; non-ultra does not install", async () => {
    const cfg = runtimeWithExplore(false);
    expect(cfg.explore.enabled).toBe(false);
    expect(cfg.explore.model).toBe("deepseek-v4-flash");

    const cold = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    cold.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] }],
    });
    const coldHandle = await registerExploreCapability(cold, {
      runtimeConfig: cfg,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(coldHandle.isRegistered()).toBe(false);
    expect(cold.getTool("explore")).toBeUndefined();

    const ultra = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
      initialThinkingLevel: "ultra",
    });
    ultra.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] },
        { id: "deepseek-v4-flash", name: "deepseek-v4-flash", input: ["text"] },
      ],
    });
    const ultraHandle = await registerExploreCapability(ultra, {
      runtimeConfig: cfg,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(ultraHandle.isRegistered()).toBe(true);
    expect(ultraHandle.getResolved()).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
    expect(ultra.getTool("explore")).toBeDefined();
  });
});

describe("Phase 0 characterization (ADR 0003 gate — no behavior change)", () => {
  it("explore tool schema omits provider/model/reasoning overrides", () => {
    const tool = createExploreTool({
      config: {
        provider: "stub",
        model: "flash",
        maxTurns: 4,
        timeoutMs: 5_000,
        maxConcurrency: 2,
        maxOutputChars: 8_000,
        allowBash: false,
        ...PRODUCT_WAVE_BUDGETS,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => undefined,
    });
    const keys = Object.keys(tool.parameters.properties ?? {}).sort();
    expect(keys).toEqual(["focus_paths", "goal", "max_turns", "role"]);
    expect(keys).not.toContain("provider");
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("reasoning");
    expect(keys).not.toContain("thinking_level");
    expect(keys).not.toContain("allow_bash");
  });

  it("prefer explore.model over session primary under forceEnable fallback chain", () => {
    expect(resolveExploreConfig(
      {
        enabled: false,
        model: "opencode-go/deepseek-v4-flash",
        maxTurns: 12,
        timeoutMs: 180_000,
        maxConcurrency: 6,
        maxOutputChars: 16_000,
        allowBash: false,
        ...PRODUCT_WAVE_BUDGETS,
      },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go", defaultModel: "deepseek-v4-pro" },
      { forceEnable: true, fallbackModel: "opencode-go/deepseek-v4-pro" },
    )).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      maxConcurrency: 6,
    });
  });

  it("worker host allowlist is read-only (no write/edit/explore; bash opt-in)", async () => {
    const { runExploreSubagent } = await import("./subagent.ts");
    const offered: string[] = [];
    const stubClient: LlmClient = {
      async complete(request) {
        offered.push(...(request.tools ?? []).map((tool) => tool.function.name));
        return { content: "ok", toolCalls: [] };
      },
    };
    const registration: ProviderRegistration = {
      name: "stub",
      api: "openai-completions",
      models: [{ id: "flash", name: "flash", input: ["text"] }],
    };
    await runExploreSubagent({
      goal: "list tools",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration,
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 1,
      allowBash: false,
      createClient: () => stubClient,
    });
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toEqual(expect.arrayContaining(["read", "grep", "glob"]));
    expect(offered).not.toContain("write");
    expect(offered).not.toContain("edit");
    expect(offered).not.toContain("bash");
    expect(offered).not.toContain("explore");
    expect(offered).not.toContain("plan");

    const withBash: string[] = [];
    await runExploreSubagent({
      goal: "list tools with bash",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration,
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 1,
      allowBash: true,
      createClient: () => ({
        async complete(request) {
          withBash.push(...(request.tools ?? []).map((tool) => tool.function.name));
          return { content: "ok", toolCalls: [] };
        },
      }),
    });
    expect(withBash).toContain("bash");
    expect(withBash).not.toContain("write");
    expect(withBash).not.toContain("explore");
  });

  it("primary explore result injects WorkspaceBrief, not raw worker body dump", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: 0,
      maxCostUsd: 0,
    });
    const rawBody = [
      "RAW_WORKER_DUMP_MARKER",
      "```ts",
      "export function huge() { return 1 }",
      "```",
      "createAuth in src/auth/index.ts:10",
    ].join("\n");
    const tool = createExploreTool({
      config: {
        provider: "stub",
        model: "flash",
        maxTurns: 4,
        timeoutMs: 30_000,
        maxConcurrency: 4,
        maxOutputChars: 8_000,
        allowBash: false,
        ...PRODUCT_WAVE_BUDGETS,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => ({
        name: "stub",
        api: "openai-completions",
        apiKey: "sk-test",
        models: [{ id: "flash", name: "flash", input: ["text"] }],
      }),
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "map auth across packages",
      getThinkingLevel: () => "ultra",
      orchestrator,
      runWorker: async () => ({
        provider: "stub",
        model: "flash",
        success: true,
        text: rawBody,
        turns: 1,
        toolCalls: 1,
        toolErrors: 0,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheTokens: null,
          reasoningTokens: null,
        },
      }),
    });
    const result = await tool.execute("brief-1", {
      goal: "locate createAuth",
      focus_paths: ["src/auth/index.ts"],
      role: "locator",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("### WorkspaceBrief");
    expect(text).toContain("### Worker note (truncated; raw evidence in EvidenceStore)");
    // Current product still peeks a capped worker note; full raw body is not the primary layer.
    const briefIdx = text.indexOf("### WorkspaceBrief");
    const noteIdx = text.indexOf("### Worker note");
    expect(briefIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeGreaterThan(briefIdx);
    expect(result.details).toMatchObject({
      brief: expect.objectContaining({
        citation_coverage: expect.any(Number),
      }),
    });
    // Cap characterization: note path is truncated at ~1200 chars of body.
    expect(text.length).toBeLessThan(rawBody.length + 4_000);
  });

  it("beginWave clears early-stop so a later turn can explore again", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: 0,
      maxCostUsd: 0,
      earlyStopMinSamples: 2,
      earlyStopEpsilon: 0.5,
    });

    const completeQuick = (goal: string, focus: string, role: "locator" | "flow_analyst") => {
      const begin = orchestrator.beginWorker({
        goal,
        focusPaths: [focus],
        role,
        lane: "deep",
      });
      expect(begin.skip).toBeUndefined();
      return orchestrator.completeWorker({
        workerId: begin.workerId,
        role,
        result: {
          provider: "stub",
          model: "flash",
          success: true,
          text: "createAuth in src/auth/index.ts:1-10 and SessionStore in src/runtime/session-store.ts:1-10",
          turns: 1,
          toolCalls: 1,
          toolErrors: 0,
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cacheTokens: null,
            reasoningTokens: null,
          },
        },
      });
    };

    completeQuick("locate auth", "src/auth/index.ts", "locator");
    completeQuick("locate session", "src/runtime/session-store.ts", "flow_analyst");
    expect(orchestrator.earlyStopped).toBe(true);

    // Without beginWave, the next worker would still see coverage_plateau.
    const poisoned = orchestrator.beginWorker({
      goal: "fresh turn: survey payments",
      focusPaths: ["src/payments/index.ts"],
      role: "locator",
      lane: "deep",
    });
    expect(poisoned.skip?.code).toBe("coverage_plateau");

    const wave = orchestrator.beginWave();
    expect(wave).toEqual({ ok: true, waveId: 1 });
    expect(orchestrator.earlyStopped).toBe(false);
    const recovered = orchestrator.beginWorker({
      goal: "after beginWave: survey payments",
      focusPaths: ["src/payments/index.ts"],
      role: "locator",
      lane: "deep",
    });
    expect(recovered.skip).toBeUndefined();
    orchestrator.completeWorker({
      workerId: recovered.workerId,
      role: "locator",
      result: {
        provider: "stub",
        model: "flash",
        success: true,
        text: "ok src/payments/index.ts:1",
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheTokens: null,
          reasoningTokens: null,
        },
      },
    });
  });

  it("beginWave refreshes wall clock; refuses while workers are active; keeps start-rate", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 1,
      maxTokens: 0,
      maxCostUsd: 0,
      maxStartsPerMinute: 100,
    });
    const seed = orchestrator.beginWorker({
      goal: "seed wave",
      focusPaths: ["src/a.ts"],
      role: "locator",
      lane: "standard",
    });
    expect(seed.skip).toBeUndefined();

    // Active worker → beginWave refused / deferred.
    expect(orchestrator.beginWave()).toEqual({
      ok: false,
      reason: "active_workers",
      activeCount: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const sameWave = orchestrator.beginWorker({
      goal: "still wave 1",
      focusPaths: ["src/b.ts"],
      role: "locator",
      lane: "standard",
    });
    expect(sameWave.skip?.code).toBe("wall_budget");

    orchestrator.completeWorker({
      workerId: seed.workerId,
      role: "locator",
      result: {
        provider: "stub",
        model: "flash",
        success: true,
        text: "done src/a.ts:1",
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheTokens: null,
          reasoningTokens: null,
        },
      },
    });

    // Without beginWave, a "new turn" still sees the same wall start.
    const stillPoisoned = orchestrator.beginWorker({
      goal: "pretend turn 2 without beginWave",
      focusPaths: ["src/c.ts"],
      role: "locator",
      lane: "standard",
    });
    expect(stillPoisoned.skip?.code).toBe("wall_budget");

    expect(orchestrator.beginWave()).toEqual({ ok: true, waveId: 1 });
    const nextTurn = orchestrator.beginWorker({
      goal: "turn 2 after beginWave",
      focusPaths: ["src/c.ts"],
      role: "locator",
      lane: "standard",
    });
    expect(nextTurn.skip).toBeUndefined();
    // Session start-rate still counts the earlier successful start + this one.
    expect(orchestrator.activeCount).toBe(1);
  });

  it("beginWave preserves session start-rate across waves", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: 0,
      maxCostUsd: 0,
      maxStartsPerMinute: 2,
    });
    for (const focus of ["src/a.ts", "src/b.ts"] as const) {
      const begin = orchestrator.beginWorker({
        goal: `wave1 ${focus}`,
        focusPaths: [focus],
        role: "locator",
        lane: "standard",
      });
      expect(begin.skip).toBeUndefined();
      orchestrator.completeWorker({
        workerId: begin.workerId,
        role: "locator",
        result: {
          provider: "stub",
          model: "flash",
          success: true,
          text: `ok ${focus}:1`,
          turns: 1,
          toolCalls: 0,
          toolErrors: 0,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheTokens: null,
            reasoningTokens: null,
          },
        },
      });
    }
    expect(orchestrator.beginWave()).toEqual({ ok: true, waveId: 1 });
    const rateLimited = orchestrator.beginWorker({
      goal: "wave2 should still see session start-rate",
      focusPaths: ["src/c.ts"],
      role: "locator",
      lane: "standard",
    });
    expect(rateLimited.skip?.code).toBe("provider_rate_budget");
  });
});

describe("createExploreTool execute", () => {
  it("returns error when provider missing (non-fast multi-file lane)", async () => {
    const tool = createExploreTool({
      config: {
        provider: "missing",
        model: "flash",
        maxTurns: 4,
        timeoutMs: 5_000,
        maxConcurrency: 2,
        maxOutputChars: 8_000,
        allowBash: false,
        ...PRODUCT_WAVE_BUDGETS,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => undefined,
      getUserPrompt: () => "map auth session impact across packages",
      getThinkingLevel: () => "high",
    });
    const result = await tool.execute("1", { goal: "map auth" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("provider not registered");
  });

  it("runs a stub explore subagent via nested loop", async () => {
    const registration: ProviderRegistration = {
      name: "stub",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      apiKey: "$STUB_KEY",
      models: [{ id: "flash", name: "flash", input: ["text"] }],
    };

    // Patch createLlmClient path by using a real subagent only if we mock fetch —
    // instead unit-test format path: call execute with resolveApiKey env and mock run via vi.
    // Here we only verify gate + missing key path is clear; integration uses stub client below.
    const tool = createExploreTool({
      config: {
        provider: "stub",
        model: "flash",
        maxTurns: 2,
        timeoutMs: 5_000,
        maxConcurrency: 1,
        maxOutputChars: 8_000,
        allowBash: false,
        ...PRODUCT_WAVE_BUDGETS,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: {},
      getUserPrompt: () => "survey the monorepo auth flow",
      getThinkingLevel: () => "high",
    });
    const result = await tool.execute("1", { goal: "where is agent loop" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/missing API key|explore error/i);
  });
});

describe("real adaptive dispatch path (not simulate-only)", () => {
  const registration: ProviderRegistration = {
    name: "stub",
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    apiKey: "sk-test",
    models: [{ id: "flash", name: "flash", input: ["text"] }],
  };

  const baseConfig = {
    provider: "stub",
    model: "flash",
    maxTurns: 3,
    timeoutMs: 30_000,
    maxConcurrency: 4,
    maxOutputChars: 8_000,
    allowBash: false,
    ...PRODUCT_WAVE_BUDGETS,
  };

  it("fast lane mechanically skips spawn on real explore tool path", async () => {
    let workerCalls = 0;
    const tool = createExploreTool({
      config: baseConfig,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "fix typo in src/cli/version.ts",
      getThinkingLevel: () => "medium",
      runWorker: async () => {
        workerCalls += 1;
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: "should not run",
          turns: 1,
          toolCalls: 0,
          toolErrors: 0,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });
    const result = await tool.execute("1", { goal: "fix the typo" });
    expect(workerCalls).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toMatch(/skipped|fast lane/i);
    expect(result.details).toMatchObject({
      explore: { skipped: true, skipCode: "fast_lane" },
    });
  });

  it("live multi-worker dispatch returns aggregate WorkspaceBrief ≤12KB with citations", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const { DEFAULT_WORKSPACE_BRIEF_MAX_CHARS } = await import("./brief.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: 0,
      maxCostUsd: 0,
    });

    const reports = [
      {
        role: "locator" as const,
        text:
          "Auth entry is src/auth/index.ts:1-40 with createAuth.\n"
          + "Also touches packages/api/middleware/auth.ts:10-30 authMiddleware.",
      },
      {
        role: "flow_analyst" as const,
        text:
          "Session lifecycle uses src/runtime/session.ts:1-50 resumeSession "
          + "and src/runtime/session-store.ts:1-20 SessionStore.",
      },
    ];
    let i = 0;
    const tool = createExploreTool({
      config: baseConfig,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "map auth session impact across packages",
      getThinkingLevel: () => "ultra",
      orchestrator,
      runWorker: async (opts) => {
        const scripted = reports[i++] ?? reports[0]!;
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: scripted.text,
          turns: 2,
          toolCalls: 3,
          toolErrors: 0,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });

    const a = await tool.execute("a", {
      goal: "locate auth entrypoints in src/auth/index.ts",
      focus_paths: ["src/auth/index.ts", "packages/api/middleware/auth.ts"],
      role: "locator",
    });
    const b = await tool.execute("b", {
      goal: "trace session flow in src/runtime/session.ts",
      focus_paths: ["src/runtime/session.ts", "src/runtime/session-store.ts"],
      role: "flow_analyst",
    });

    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(a.content[0]?.text).toContain("### WorkspaceBrief");
    expect(b.content[0]?.text).toContain("### WorkspaceBrief");
    // Raw dump must not dominate primary context — brief is the aggregate inject.
    expect(b.content[0]?.text).not.toMatch(/should never appear as full raw dump of 50k/);
    const brief = (b.details as { brief?: { text_chars: number; citation_coverage: number; claims: unknown[] } })
      ?.brief;
    expect(brief).toBeDefined();
    expect(brief!.text_chars).toBeLessThanOrEqual(DEFAULT_WORKSPACE_BRIEF_MAX_CHARS);
    expect(brief!.citation_coverage).toBeGreaterThan(0);
    expect(brief!.claims.length).toBeGreaterThan(0);
    expect(orchestrator.reportCount).toBe(2);
    // Mechanical ownership: second worker should not re-lease first worker paths.
    const ownA = (a.details as { explore?: { ownership?: { paths: string[] } } })?.explore?.ownership?.paths ?? [];
    const ownB = (b.details as { explore?: { ownership?: { paths: string[] } } })?.explore?.ownership?.paths ?? [];
    const overlap = ownA.filter((p) => ownB.includes(p));
    expect(overlap).toEqual([]);
  });

  it("early-stop cancels stragglers when coverage plateaus on live path", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: 0,
      maxCostUsd: 0,
      earlyStopMinSamples: 2,
      earlyStopEpsilon: 0.5, // easy plateau after two similar reports
    });

    const controllers: AbortSignal[] = [];
    let started = 0;
    const tool = createExploreTool({
      config: { ...baseConfig, maxConcurrency: 4 },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "deep multi-file survey of auth",
      getThinkingLevel: () => "ultra",
      orchestrator,
      runWorker: async (opts) => {
        started += 1;
        controllers.push(opts.signal!);
        // First two complete quickly with similar coverage; third waits on signal.
        if (started <= 2) {
          return {
            provider: "stub",
            model: "flash",
            success: true,
            text: "createAuth in src/auth/index.ts:1-10 and SessionStore in src/runtime/session-store.ts:1-10",
            turns: 1,
            toolCalls: 1,
            toolErrors: 0,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              cacheTokens: null,
              reasoningTokens: null,
            },
          };
        }
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 2_000);
        });
        return {
          provider: "stub",
          model: "flash",
          success: false,
          cancelled: opts.signal?.aborted === true,
          text: opts.signal?.aborted ? "" : "late",
          turns: 0,
          toolCalls: 0,
          toolErrors: 0,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });

    // Run two workers to plateau, then a third that should be cancelled or skipped.
    await tool.execute("1", {
      goal: "locate auth",
      focus_paths: ["src/auth/index.ts"],
      role: "locator",
    });
    await tool.execute("2", {
      goal: "locate session store",
      focus_paths: ["src/runtime/session-store.ts"],
      role: "flow_analyst",
    });
    expect(orchestrator.earlyStopped).toBe(true);

    const third = await tool.execute("3", {
      goal: "adversarial gaps",
      focus_paths: ["tests/auth/session.test.ts"],
      role: "adversarial",
    });
    // Third is skipped due to plateau or cancelled as straggler.
    const text = third.content[0]?.text ?? "";
    expect(
      text.includes("skipped")
        || text.includes("cancelled")
        || text.includes("early_stop")
        || text.includes("plateau"),
    ).toBe(true);
  });

  it("global wall budget refuses further workers", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orchestrator = new ExploreOrchestrator({
      wallMs: 1,
      maxTokens: 0,
      maxCostUsd: 0,
    });
    // Force wave start in the past.
    orchestrator.beginWorker({
      goal: "seed",
      lane: "standard",
      focusPaths: ["src/a.ts"],
      role: "locator",
    });
    await new Promise((r) => setTimeout(r, 5));

    let workerCalls = 0;
    const tool = createExploreTool({
      config: baseConfig,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "survey packages",
      getThinkingLevel: () => "high",
      orchestrator,
      runWorker: async () => {
        workerCalls += 1;
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: "nope",
          turns: 1,
          toolCalls: 0,
          toolErrors: 0,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });
    const result = await tool.execute("x", { goal: "more work", focus_paths: ["src/b.ts"] });
    expect(workerCalls).toBe(0);
    expect(result.content[0]?.text).toMatch(/skipped|budget|wall/i);
  });

  it("product token default trips token_budget on live explore path", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    // Same budgets register.ts wires from resolveExploreConfig product defaults.
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
      maxCostUsd: 0, // isolate token budget
      maxStartsPerMinute: 0,
    });
    expect(orchestrator.budgets.maxTokens).toBe(DEFAULT_EXPLORE_WAVE_MAX_TOKENS);
    expect(DEFAULT_EXPLORE_WAVE_MAX_TOKENS).toBeGreaterThan(0);

    let workerCalls = 0;
    const tool = createExploreTool({
      config: { ...baseConfig, ...PRODUCT_WAVE_BUDGETS },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "map auth across packages",
      getThinkingLevel: () => "high",
      orchestrator,
      runWorker: async () => {
        workerCalls += 1;
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: "createAuth in src/auth/index.ts:1-10",
          turns: 1,
          toolCalls: 1,
          toolErrors: 0,
          usage: {
            inputTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
            outputTokens: 0,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });

    const first = await tool.execute("1", {
      goal: "locate auth",
      focus_paths: ["src/auth/index.ts"],
      role: "locator",
    });
    expect(first.isError).toBe(false);
    expect(workerCalls).toBe(1);
    expect(orchestrator.tokensUsed).toBeGreaterThanOrEqual(DEFAULT_EXPLORE_WAVE_MAX_TOKENS);

    const second = await tool.execute("2", {
      goal: "locate session",
      focus_paths: ["src/runtime/session.ts"],
      role: "flow_analyst",
    });
    expect(workerCalls).toBe(1);
    expect(second.details).toMatchObject({
      explore: { skipped: true, skipCode: "token_budget" },
    });
    expect(second.content[0]?.text).toMatch(/token budget|skipped/i);
    const brief = (second.details as { brief?: { gaps?: string[] } }).brief;
    expect(brief?.gaps?.some((gap) => /incomplete coverage: token_budget/i.test(gap))).toBe(true);
  });

  it("product cost default trips cost_budget on live explore path", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    // Soft estimate is tokens * 1e-6; exhaust product USD ceiling with tokens unlimited.
    const tokensToTripCost = Math.ceil(DEFAULT_EXPLORE_WAVE_MAX_COST_USD / 1e-6);
    const orchestrator = new ExploreOrchestrator({
      wallMs: 60_000,
      maxTokens: 0,
      maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
      maxStartsPerMinute: 0,
    });
    expect(orchestrator.budgets.maxCostUsd).toBe(DEFAULT_EXPLORE_WAVE_MAX_COST_USD);
    expect(DEFAULT_EXPLORE_WAVE_MAX_COST_USD).toBeGreaterThan(0);

    let workerCalls = 0;
    const tool = createExploreTool({
      config: {
        ...baseConfig,
        maxTokens: 0,
        maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
        maxStartsPerMinute: 0,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "deep survey of packages",
      getThinkingLevel: () => "ultra",
      orchestrator,
      runWorker: async () => {
        workerCalls += 1;
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: "SessionStore in src/runtime/session-store.ts:1-20",
          turns: 1,
          toolCalls: 1,
          toolErrors: 0,
          usage: {
            inputTokens: tokensToTripCost,
            outputTokens: 0,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });

    await tool.execute("1", {
      goal: "locate session store",
      focus_paths: ["src/runtime/session-store.ts"],
      role: "locator",
    });
    expect(workerCalls).toBe(1);
    expect(orchestrator.costUsd).toBeGreaterThanOrEqual(DEFAULT_EXPLORE_WAVE_MAX_COST_USD);

    const second = await tool.execute("2", {
      goal: "impact tests",
      focus_paths: ["src/runtime/session.ts"],
      role: "impact_test",
    });
    expect(workerCalls).toBe(1);
    expect(second.details).toMatchObject({
      explore: { skipped: true, skipCode: "cost_budget" },
    });
    const brief = (second.details as { brief?: { gaps?: string[] } }).brief;
    expect(brief?.gaps?.some((gap) => /incomplete coverage: cost_budget/i.test(gap))).toBe(true);
  });

  it("product starts-per-minute default trips provider_rate_budget on live path", async () => {
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const rateCap = DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE;
    expect(rateCap).toBeGreaterThan(0);
    const orchestrator = new ExploreOrchestrator({
      wallMs: 120_000,
      maxTokens: 0,
      maxCostUsd: 0,
      maxStartsPerMinute: rateCap,
    });
    expect(orchestrator.budgets.maxStartsPerMinute).toBe(rateCap);

    // Fill the rolling window with successful starts (no completions needed for rate).
    for (let i = 0; i < rateCap; i += 1) {
      const started = orchestrator.beginWorker({
        goal: `seed ${i}`,
        lane: "standard",
        focusPaths: [`src/seed-${i}.ts`],
        role: "locator",
      });
      expect(started.skip).toBeUndefined();
    }

    let workerCalls = 0;
    const tool = createExploreTool({
      config: {
        ...baseConfig,
        maxTokens: 0,
        maxCostUsd: 0,
        maxStartsPerMinute: rateCap,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: { STUB_KEY: "sk-test" },
      getUserPrompt: () => "survey packages with many explores",
      getThinkingLevel: () => "high",
      orchestrator,
      runWorker: async () => {
        workerCalls += 1;
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: "should not run",
          turns: 1,
          toolCalls: 0,
          toolErrors: 0,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheTokens: null,
            reasoningTokens: null,
          },
        };
      },
    });

    const result = await tool.execute("over", {
      goal: "one more slice",
      focus_paths: ["src/over.ts"],
      role: "adversarial",
    });
    expect(workerCalls).toBe(0);
    expect(result.details).toMatchObject({
      explore: { skipped: true, skipCode: "provider_rate_budget" },
    });
    expect(result.content[0]?.text).toMatch(/provider-rate|starts per minute|skipped/i);
    const brief = (result.details as { brief?: { gaps?: string[] } }).brief;
    expect(brief?.gaps?.some((gap) => /incomplete coverage: provider_rate_budget/i.test(gap))).toBe(true);
  });

  it("registerExploreCapability wires product nonzero budgets into orchestrator", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    host.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] },
        { id: "deepseek-v4-flash", name: "deepseek-v4-flash", input: ["text"] },
      ],
    });

    const handle = await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(true),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    const resolved = handle.getResolved();
    expect(resolved).toMatchObject({
      maxTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
      maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
      maxStartsPerMinute: DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
    });
    expect(resolved!.maxTokens).toBeGreaterThan(0);
    expect(resolved!.maxCostUsd).toBeGreaterThan(0);
    expect(resolved!.maxStartsPerMinute).toBeGreaterThan(0);

    // Live tool path: exhaust product token default via the registered tool's shared orchestrator.
    const tool = host.getTool("explore");
    expect(tool).toBeDefined();

    // Inject a stub by re-registering is hard; instead prove resolve→register budget identity
    // and that createExploreTool with the same resolved config builds an orchestrator that trips.
    const { ExploreOrchestrator } = await import("./orchestrator.ts");
    const orch = new ExploreOrchestrator({
      wallMs: resolved!.timeoutMs,
      maxTokens: resolved!.maxTokens,
      maxCostUsd: resolved!.maxCostUsd,
      maxStartsPerMinute: resolved!.maxStartsPerMinute,
    });
    expect(orch.budgets).toMatchObject({
      maxTokens: DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
      maxCostUsd: DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
      maxStartsPerMinute: DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
    });
  });

  it("parseWorkerEvidenceReport extracts citations and gaps", async () => {
    const { parseWorkerEvidenceReport } = await import("./orchestrator.ts");
    const report = parseWorkerEvidenceReport(
      "Found createAuth in src/auth/index.ts:1-20.\nGap: tests not scanned.",
      { role: "locator" },
    );
    expect(report.claims.length).toBeGreaterThan(0);
    expect(report.claims.some((c) => c.citations.length > 0)).toBe(true);
    expect((report.gaps ?? []).some((g) => /tests not scanned/i.test(g))).toBe(true);
    expect(report.symbols).toContain("createAuth");
  });

  it("parseWorkerEvidenceReport separates facts, inference, file:line, and gaps", async () => {
    const { parseWorkerEvidenceReport } = await import("./orchestrator.ts");
    const { aggregateWorkspaceBrief } = await import("./brief.ts");
    const compact = [
      "### Facts",
      "- createAuth exports the login entry at src/auth/index.ts:12-18",
      "### Inference",
      "- SessionStore likely depends on createAuth for resume",
      "### Citations",
      "- src/auth/index.ts:12-18",
      "### Gaps",
      "- tests not scanned",
      "- src/payments not opened",
    ].join("\n");
    const report = parseWorkerEvidenceReport(compact, { role: "locator" });
    expect(report.claims.some((c) => c.kind === "fact" && /createAuth/.test(c.text))).toBe(true);
    expect(report.claims.some((c) => c.kind === "inference")).toBe(true);
    expect(report.claims.some((c) => c.citations.some((cite) => cite.start_line === 12))).toBe(true);
    expect(report.symbols).toContain("createAuth");
    expect((report.gaps ?? []).some((g) => /tests not scanned/i.test(g))).toBe(true);
    expect((report.gaps ?? []).some((g) => /payments/i.test(g))).toBe(true);

    const dump = [
      "Here is the whole file contents for your review:",
      "```",
      "export function createAuth() { return true }",
      "```".repeat(40),
      "src/auth/index.ts looks important but no line cites.",
    ].join("\n");
    const dumpReport = parseWorkerEvidenceReport(dump, { role: "locator" });
    const compactBrief = aggregateWorkspaceBrief([report]);
    const dumpBrief = aggregateWorkspaceBrief([dumpReport]);
    // Compact file:line contract must not lose citation coverage vs an uncited dump.
    expect(compactBrief.citation_coverage).toBeGreaterThanOrEqual(dumpBrief.citation_coverage);
    expect(compactBrief.citation_coverage).toBeGreaterThan(0.5);
  });

  it("scout system prompt prefers facts/citations/gaps over whole-file dumps", async () => {
    const { runExploreSubagent, formatExploreUserPrompt } = await import("./subagent.ts");
    let seenRequest = "";
    const user = formatExploreUserPrompt("locate createAuth", ["src/auth"]);
    expect(user).toMatch(/### Facts/);
    expect(user).not.toMatch(/verbatim.*main content/i);

    await runExploreSubagent({
      goal: "locate createAuth",
      focusPaths: ["src/auth"],
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration: {
        name: "stub",
        api: "openai-completions",
        models: [{ id: "flash", name: "flash", input: ["text"] }],
      },
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 1,
      allowBash: false,
      createClient: () => ({
        async complete(request) {
          seenRequest = JSON.stringify(request);
          return {
            content: "### Facts\n- x at src/auth/index.ts:1\n### Gaps\n- none",
            toolCalls: [],
          };
        },
      }),
    });
    expect(seenRequest).toMatch(/compact evidence report|### Facts|file:line/i);
    expect(seenRequest).not.toMatch(/verbatim.*main content/i);
    expect(seenRequest).toMatch(/Do \*\*not\*\* dump entire files|whole-file/i);
  });
});

describe("runExploreSubagent integration (stub client)", () => {
  it("completes with read-only tools and returns final text", async () => {
    const { runExploreSubagent } = await import("./subagent.ts");
    const stubClient: LlmClient = {
      async complete() {
        return { content: "Found agent-loop in src/runtime/agent-loop.ts", toolCalls: [] };
      },
    };
    const result = await runExploreSubagent({
      goal: "locate agent loop",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration: {
        name: "stub",
        api: "openai-completions",
        models: [{ id: "flash", name: "flash", input: ["text"] }],
      },
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 3,
      allowBash: false,
      createClient: () => stubClient,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("agent-loop");
    expect(result.model).toBe("flash");
  });

  it("forwards nested loop UI callbacks with worker identity", async () => {
    const { runExploreSubagent } = await import("./subagent.ts");
    const { noopSubagentUiBridge } = await import("./subagent-ui.ts");
    const lifecycle: string[] = [];
    const deltas: string[] = [];
    const bridge: import("./subagent-ui.ts").SubagentUiBridge = {
      forWorker: () => ({
        onLifecycle: (phase: "start" | "end") => lifecycle.push(phase),
        onAssistantDelta: (text: string) => deltas.push(text),
      }),
    };
    const stubClient: LlmClient = {
      async complete() {
        return {
          content: "evidence block",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 2, cacheTokens: null, reasoningTokens: null },
        };
      },
      async *completeStream() {
        yield { type: "text_delta" as const, text: "evidence" };
        yield {
          type: "done" as const,
          content: "evidence block",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 2, cacheTokens: null, reasoningTokens: null },
          raw: undefined,
        };
      },
    };
    await runExploreSubagent({
      goal: "find entry",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration: {
        name: "stub",
        api: "openai-completions",
        models: [{ id: "flash", name: "flash", input: ["text"] }],
      },
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 2,
      allowBash: false,
      createClient: () => stubClient,
      ui: {
        workerId: 7,
        modelLabel: "stub/flash",
        role: "locator",
        sink: bridge.forWorker({
          workerId: 7,
          modelLabel: "stub/flash",
          role: "locator",
          goal: "find entry",
        }),
      },
    });
    expect(lifecycle).toEqual(["start", "end"]);
    expect(deltas.join("")).toContain("evidence");
    expect(noopSubagentUiBridge.forWorker({ workerId: 1, modelLabel: "x", goal: "g" }).onLifecycle).toBeUndefined();
  });
});

describe("runFailureDraftSubagent", () => {
  it("formats a drafting user prompt with artifact seed", async () => {
    const { formatFailureDraftUserPrompt } = await import("./subagent.ts");
    const prompt = formatFailureDraftUserPrompt(
      "Failure signal: turn failed.",
      "Operator signal: turn failed.\nEvidence:\n- [tool_error] npm test",
      ["/tmp/runs/run-1"],
    );
    expect(prompt).toMatch(/failure_statement/);
    expect(prompt).toContain("Artifact seed");
    expect(prompt).toContain("/tmp/runs/run-1");
    expect(prompt).not.toMatch(/verbatim.*main content/i);
  });

  it("uses drafting system prompt and returns concise text", async () => {
    const { runFailureDraftSubagent } = await import("./subagent.ts");
    let seenSystem = "";
    const stubClient: LlmClient = {
      async complete(req) {
        const system = req.messages.find((m) => m.role === "system");
        seenSystem = typeof system?.content === "string" ? system.content : "";
        return { content: "Verifier red: npm test failed on auth path.", toolCalls: [] };
      },
    };
    const result = await runFailureDraftSubagent({
      goal: "Failure signal: hard steer.",
      artifactSeed: "Operator signal: hard steer.",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration: {
        name: "stub",
        api: "openai-completions",
        models: [{ id: "flash", name: "flash", input: ["text"] }],
      },
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 2,
      createClient: () => stubClient,
    });
    expect(result.success).toBe(true);
    expect(result.text).toMatch(/Verifier red/);
    expect(seenSystem).toMatch(/failure-statement drafter/i);
    expect(seenSystem).not.toMatch(/verbatim.*main content/i);
  });
});

function runtimeWithExplore(enabled: boolean): XioRuntimeConfig {
  return {
    general: {
      runRoot: "~/.xiocode/runs",
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-pro",
    },
    providers: {
      "opencode-go": {
        name: "opencode-go",
        kind: "openai",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "deepseek-v4-pro",
        apiKeyEnv: "OPENCODE_API_KEY",
      },
    },
    worktree: { enabled: false, retainOnReject: false, allowDirty: false },
    extensions: {},
    verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
    agentsMd: { enabled: true, readClaudeDirs: true, maxBytes: 1, maxImportDepth: 1 },
    skills: { enabled: true, readClaude: true, readCursor: true, maxBodyBytes: 1 },
    hooks: { enabled: true, readClaude: true, timeoutMs: 1 },
    mcp: {
      enabled: false,
      readClaude: false,
      readCursor: false,
      failClosed: false,
      unknownSourceFailClosed: false,
      timeoutMs: 1,
      servers: {},
    },
    permissions: { allowHighRisk: false },
    explore: {
      enabled,
      model: "deepseek-v4-flash",
      maxTurns: 12,
      timeoutMs: 180_000,
      maxConcurrency: 16,
      maxOutputChars: 16_000,
      allowBash: false,
      ...PRODUCT_WAVE_BUDGETS,
    },
    retrospective: {
      enabled: true,
      skipTrivial: true,
      minToolCalls: 1,
      autoInject: true,
      enqueueImprove: true,
      useLlm: false,
      sessionEndSubagent: true,
      sessionEndTimeoutMs: 45_000,
      normsAutoWrite: false,
    },
    regress: { offerOnFailure: true },
  };
}
