import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prepareSession, writeUsageSummary } from "./session.ts";
import { createScriptedLlmClient, loadAgentTape } from "./providers/scripted/index.ts";

import type { XioRuntimeConfig } from "../cli/config-parser.ts";
import type { PricingOverrides } from "./pricing.ts";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "providers/scripted/fixtures",
);

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

/**
 * End-to-end cost path: a scripted provider response carries usage, the session
 * prices it with the active model, and `xio -p` reports real dollars. Covers the
 * link the unit tests cannot — provider_response → cost meter → footer.
 */
async function runPricedSession(pricing: PricingOverrides): Promise<{
  status: string[];
  summary: string;
}> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-session-cost-"));
  const status: string[] = [];
  const tape = await loadAgentTape(path.join(fixturesDir, "text-only.json"));

  const session = await prepareSession({
    cwd: tempDir,
    workspaceRoot: tempDir,
    runtimeConfig: minimalRuntimeConfig(tempDir, pricing),
    sessionId: "sess-cost",
    llmClient: createScriptedLlmClient({ tape }),
    model: { provider: "scripted", id: "priced-model" },
    env: { ...process.env, XIO_TEST_KEY: "test" },
    ask: async () => true,
    uiSink: {
      setStatus: (key, text) => {
        if (key === "usage" && text) status.push(text);
      },
    },
  });

  try {
    const result = await session.runPrompt("hi");
    expect(result.success).toBe(true);
    const chunks: string[] = [];
    writeUsageSummary(session, (chunk) => void chunks.push(chunk));
    return { status, summary: chunks.join("") };
  } finally {
    await session.close();
  }
}

describe("session cost path (scripted provider, no network)", () => {
  it("turns provider-reported usage into a real dollar figure", async () => {
    // 1M in / 1M out priced at $3 / $6 → the tape's 10 in + 2 out costs
    // 10*3e-6 + 2*6e-6 = $0.000042.
    const { status, summary } = await runPricedSession({
      "priced-model": { inputPerMTok: 3, outputPerMTok: 6 },
    });

    expect(status.length).toBeGreaterThan(0);
    // Below the last displayed digit, but real — shown as `<$0.0001`, not `$0.0000`.
    expect(status.at(-1)).toBe("tok:12 <$0.0001");
    expect(summary).toContain("tok:12 <$0.0001");
    expect(summary).toContain("scripted/priced-model");
    expect(summary).not.toContain("~unknown");
  }, 30_000);

  it("reports ~unknown for a model with no price instead of $0", async () => {
    const { status, summary } = await runPricedSession({});

    expect(status.at(-1)).toBe("tok:12 ~unknown");
    expect(summary).toContain("~unknown");
    expect(summary).toContain("[pricing.\"<model>\"]");
  }, 30_000);
});

function minimalRuntimeConfig(runRoot: string, pricing: PricingOverrides): XioRuntimeConfig {
  return {
    general: { runRoot, maxTurns: 8, defaultProvider: "scripted", defaultModel: "priced-model" },
    providers: {
      scripted: {
        name: "scripted",
        kind: "openai",
        model: "priced-model",
        apiKeyEnv: "XIO_TEST_KEY",
      },
    },
    pricing,
    worktree: { enabled: false, retainOnReject: false, allowDirty: false },
    extensions: {},
    verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
    agentsMd: { enabled: false, readClaudeDirs: false, maxBytes: 1, maxImportDepth: 1 },
    skills: { enabled: false, readClaude: false, readCursor: false, maxBodyBytes: 1 },
    hooks: { enabled: false, readClaude: false, timeoutMs: 1 },
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
      enabled: false,
      maxTurns: 4,
      timeoutMs: 1_000,
      maxConcurrency: 1,
      maxOutputChars: 1_000,
      allowBash: false,
      maxTokens: 1_000,
      maxCostUsd: 1,
      maxStartsPerMinute: 1,
    },
    retrospective: {
      enabled: false,
      skipTrivial: true,
      minToolCalls: 1,
      autoInject: false,
      enqueueImprove: false,
      useLlm: false,
      sessionEndSubagent: false,
      sessionEndTimeoutMs: 45_000,
      normsAutoWrite: false,
    },
    regress: { offerOnFailure: false },
  };
}
