import { readFile } from "node:fs/promises";
import path from "node:path";

import { extractBlockerLog } from "../../extensions/xio-evolve/src/retrospective/extract.ts";
import {
  runFailureDraftSubagent,
  withModelId,
  type RunExploreSubagentOptions,
} from "./explore/subagent.ts";
import type { SubagentUiBridge } from "./explore/subagent-ui.ts";

import { formatRegressCaptureHint } from "./session-lifecycle.ts";
import { promptAndCaptureRegression } from "./regress-commands.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { RegressCommandOptions } from "./regress-commands.ts";
import type { RunSummary } from "../../extensions/xio-evolve/src/types.ts";
import type { LlmClient, ProviderRegistration } from "./types.ts";
import type { WorkspacePerceptionService } from "./workspace/index.ts";
import type { ExploreSubagentResult } from "./explore/types.ts";

export type FailureCaptureSignal = "turn_failed" | "hard_steer" | "rollback";

export type FailureCaptureOfferInput = Readonly<{
  turnId: string;
  signal: FailureCaptureSignal;
  runId?: string;
}>;

export type FailureCaptureOfferOptions = Readonly<{
  offerOnFailure: boolean;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  capture: RegressCommandOptions;
  /** Best-effort draft worker; failure/timeout degrades to manual prompts. */
  draftFailureStatement?: (input: FailureCaptureOfferInput) => Promise<string | undefined>;
  draftTimeoutMs?: number;
}>;

export type LiveFailureDraftOptions = Readonly<{
  cwd: string;
  workspaceRoot: string;
  runRoot: string;
  /** Current provider registration (session model or explore flash). */
  getRegistration: () => ProviderRegistration | undefined;
  /** Resolve API key; return undefined when missing (degrade, no throw). */
  resolveApiKey: () => string | undefined;
  getModelId: () => string;
  workspacePerception?: WorkspacePerceptionService;
  subagentUi?: SubagentUiBridge;
  maxTurns?: number;
  /** Outer offer timeout; drafter aborts the worker on the same budget. */
  timeoutMs?: number;
  /** Test seam — defaults to runFailureDraftSubagent. */
  runDraftSubagent?: (
    options: Omit<RunExploreSubagentOptions, "allowBash" | "systemPrompt" | "userPrompt"> & Readonly<{
      artifactSeed?: string;
    }>,
  ) => Promise<ExploreSubagentResult>;
  createClient?: (input: Readonly<{
    registration: ProviderRegistration;
    apiKey: string;
  }>) => LlmClient;
  /** Optional sink for LLM→artifact degrade notices (when used outside offer). */
  onDegrade?: (message: string) => void;
}>;

const SIGNAL_LABEL: Record<FailureCaptureSignal, string> = {
  turn_failed: "turn failed",
  hard_steer: "hard steer",
  rollback: "/rollback",
};

const DEFAULT_DRAFT_TIMEOUT_MS = 25_000;
/** Outer offer budget beyond the live drafter abort so artifact-seed fallback can return. */
const DRAFT_SETTLE_BUFFER_MS = 5_000;
const DEFAULT_DRAFT_MAX_TURNS = 6;

/**
 * Session-scoped one-key capture offer after failure signals.
 * Dedupes by turnId; kill-switch silences offers without touching `/regress`.
 */
export function createFailureCaptureOffer(options: FailureCaptureOfferOptions): {
  maybeOfferFailureCapture: (input: FailureCaptureOfferInput) => Promise<void>;
} {
  const offeredTurns = new Set<string>();
  const draft =
    options.draftFailureStatement
    ?? ((input: FailureCaptureOfferInput) => draftFailureStatementFromRun({
      runRoot: options.capture.runRoot,
      runId: input.runId,
      signal: input.signal,
    }));
  const draftTimeoutMs = options.draftTimeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS;

  return {
    async maybeOfferFailureCapture(input) {
      if (!options.offerOnFailure) return;
      if (!input.turnId || offeredTurns.has(input.turnId)) return;
      offeredTurns.add(input.turnId);

      const label = SIGNAL_LABEL[input.signal];
      const detail = [
        `Signal: ${label}`,
        input.runId && input.runId !== "none" ? `run=${input.runId}` : undefined,
        "Accept to draft a failure statement via a read-only explore worker (best-effort), then confirm verifier.",
        "Decline keeps the optional /regress hint only — nothing is persisted.",
      ].filter(Boolean).join("\n");

      let accepted = false;
      try {
        accepted = await options.interactive.ask("Capture as regression case?", detail);
      } catch (error) {
        options.sink.notify?.(
          `Failure-capture offer failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        options.sink.notify?.(formatRegressCaptureHint(input.runId), "info");
        return;
      }

      if (!accepted) {
        options.sink.notify?.(formatRegressCaptureHint(input.runId), "info");
        return;
      }

      let draftText: string | undefined;
      try {
        // Live drafter aborts at draftTimeoutMs and may still return an artifact seed.
        // Outer budget must be strictly larger or that seed is discarded as a timeout.
        draftText = await withTimeout(draft(input), draftTimeoutMs + DRAFT_SETTLE_BUFFER_MS);
        if (!draftText?.trim()) {
          draftText = undefined;
          options.sink.notify?.(
            "Draft enrichment unavailable; falling back to manual /regress prompts.",
            "warning",
          );
        } else {
          options.sink.notify?.(`Draft failure statement:\n${draftText}`, "info");
        }
      } catch (error) {
        draftText = undefined;
        options.sink.notify?.(
          `Draft enrichment unavailable (${error instanceof Error ? error.message : String(error)}); falling back to manual /regress prompts.`,
          "warning",
        );
      }

      try {
        await promptAndCaptureRegression(options.capture, {
          runId: input.runId,
          draftFailure: draftText,
        });
      } catch (error) {
        options.sink.notify?.(
          `Regression capture failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  };
}

/**
 * Live explore-style drafter: LLM first (seeded by artifacts), artifact fallback, else undefined.
 * Missing credentials / non-interactive callers should omit wiring or let resolveApiKey return undefined.
 */
export function createLiveFailureStatementDrafter(
  options: LiveFailureDraftOptions,
): (input: FailureCaptureOfferInput) => Promise<string | undefined> {
  const runDraft = options.runDraftSubagent ?? runFailureDraftSubagent;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_DRAFT_MAX_TURNS;

  return async (input) => {
    const artifactSeed = await draftFailureStatementFromRun({
      runRoot: options.runRoot,
      runId: input.runId,
      signal: input.signal,
    });

    const registration = options.getRegistration();
    const apiKey = options.resolveApiKey();
    if (!registration || !apiKey?.trim()) {
      options.onDegrade?.(
        "LLM draft skipped (missing provider credentials); using artifact seed or manual prompts.",
      );
      return artifactSeed;
    }

    const modelId = options.getModelId();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const focusPaths = input.runId && input.runId !== "none"
      ? [path.join(options.runRoot, input.runId)]
      : undefined;
    const modelLabel = `${registration.name}/${modelId}`;
    const ui = options.subagentUi
      ? {
          workerId: 0,
          modelLabel,
          sink: options.subagentUi.forWorker({
            workerId: 0,
            modelLabel,
            goal: `failure-draft:${input.signal}`,
          }),
        }
      : undefined;

    try {
      const result = await runDraft({
        goal: [
          `Failure signal: ${SIGNAL_LABEL[input.signal]}.`,
          input.runId && input.runId !== "none" ? `Run id: ${input.runId}.` : undefined,
          "Inspect run artifacts under the focus path (summary.json, trajectory.json) and relevant workspace files.",
          "Produce a concise operator-facing failure_statement.",
        ].filter(Boolean).join(" "),
        artifactSeed,
        focusPaths,
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        registration: withModelId(registration, modelId),
        apiKey,
        modelId,
        maxTurns,
        signal: controller.signal,
        workspacePerception: options.workspacePerception,
        createClient: options.createClient,
        ui,
      });

      const text = result.text?.trim();
      if (result.cancelled || controller.signal.aborted) {
        options.onDegrade?.(
          `LLM draft timed out or aborted; ${artifactSeed ? "using artifact seed." : "falling back to manual prompts."}`,
        );
        return artifactSeed;
      }
      if (!result.success || !text) {
        options.onDegrade?.(
          `LLM draft unavailable${result.error ? ` (${result.error})` : ""}; ${
            artifactSeed ? "using artifact seed." : "falling back to manual prompts."
          }`,
        );
        return artifactSeed;
      }
      return text;
    } catch (error) {
      options.onDegrade?.(
        `LLM draft failed (${error instanceof Error ? error.message : String(error)}); ${
          artifactSeed ? "using artifact seed." : "falling back to manual prompts."
        }`,
      );
      return artifactSeed;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Deterministic read-only draft from run summary + trajectory blockers (no write tools). */
export async function draftFailureStatementFromRun(input: Readonly<{
  runRoot: string;
  runId?: string;
  signal: FailureCaptureSignal;
}>): Promise<string | undefined> {
  const runId = input.runId;
  if (!runId || runId === "none") return undefined;
  const runDir = path.join(input.runRoot, runId);
  const [summaryRaw, trajectoryRaw] = await Promise.all([
    readFile(path.join(runDir, "summary.json"), "utf8").catch(() => undefined),
    readFile(path.join(runDir, "trajectory.json"), "utf8").catch(() => undefined),
  ]);
  if (!summaryRaw) return undefined;

  const summaryJson = JSON.parse(summaryRaw) as Record<string, unknown>;
  const summary = toDraftSummary(runId, summaryJson);
  const trajectory = trajectoryRaw
    ? (JSON.parse(trajectoryRaw) as { tool_rounds?: readonly unknown[] })
    : undefined;
  const log = extractBlockerLog({ runId, summary, trajectory });
  const lines = [
    `Operator signal: ${SIGNAL_LABEL[input.signal]}.`,
    summary.success === false || summary.status === "failed"
      ? `Run status: failed.`
      : `Run status: ${summary.status}.`,
  ];
  if (summary.failure_reasons.length > 0) {
    lines.push(`Failure reasons: ${summary.failure_reasons.slice(0, 3).join("; ")}.`);
  }
  const top = log.blockers.slice(0, 3);
  if (top.length > 0) {
    lines.push("Evidence:");
    for (const blocker of top) {
      lines.push(`- [${blocker.kind}] ${blocker.summary}`);
    }
  } else {
    lines.push("No structured tool blockers recorded; operator should refine this statement.");
  }
  return lines.join("\n").trim();
}

function toDraftSummary(runId: string, raw: Record<string, unknown>): RunSummary {
  const status = raw.status === "success" || raw.status === "failed" ? raw.status : "failed";
  const failureReasons = Array.isArray(raw.failure_reasons)
    ? raw.failure_reasons.filter((item): item is string => typeof item === "string")
    : [];
  return {
    run_id: typeof raw.run_id === "string" ? raw.run_id : runId,
    status,
    duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : 0,
    success: raw.success === true,
    failure_reasons: failureReasons,
    finished_at: typeof raw.finished_at === "string" ? raw.finished_at : new Date(0).toISOString(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: null,
      reasoningTokens: null,
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
