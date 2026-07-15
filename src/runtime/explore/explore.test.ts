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

import type { XioRuntimeConfig } from "../../cli/config-parser.ts";
import type { LlmClient, ProviderRegistration } from "../types.ts";

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
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("absolute");
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
    expect(text).toMatch(/verbatim|absolute paths/i);
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
});

describe("createExploreTool execute", () => {
  it("returns error when provider missing", async () => {
    const tool = createExploreTool({
      config: {
        provider: "missing",
        model: "flash",
        maxTurns: 4,
        timeoutMs: 5_000,
        maxConcurrency: 2,
        maxOutputChars: 8_000,
        allowBash: false,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => undefined,
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
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: {},
    });
    const result = await tool.execute("1", { goal: "where is agent loop" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/missing API key|explore error/i);
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
    },
    retrospective: {
      enabled: true,
      skipTrivial: true,
      minToolCalls: 1,
      autoInject: true,
      enqueueImprove: true,
      useLlm: false,
    },
  };
}
