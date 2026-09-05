import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { ExtensionHost } from "./extension-host.ts";
import { createLlmClient } from "./providers/client.ts";
import { registerConfiguredProviders, resolveDefaultModel } from "./provider-registry.ts";
import { registerConnectCommands } from "./connect-commands.ts";
import { registerThinkingCommands } from "./thinking-commands.ts";
import { registerPermissionCommands } from "./agent-commands.ts";
import { registerContextCommands } from "./context-commands.ts";
import { ContextCompactionController, SessionHistory, isContextCompactionError } from "./context-compaction.ts";
import { resolveSessionTokenBudget } from "./providers/token-estimate.ts";
import { thinkingStatusLabel } from "./thinking.ts";
import { registerPerceptionCapability, WorkspacePerceptionService } from "./workspace/index.ts";
import type { PermissionMode } from "./permission-mode.ts";
import { createReadlineInteractiveIO } from "./readline-interactive.ts";
import {
  allowsProjectResources,
  ensureProjectTrust,
  sessionGrantFromWorktree,
  type ProjectTrustState,
  type TrustMode,
} from "./project-trust.ts";
import {
  createPromptRunner,
  createSessionCloser,
  createSessionHost,
  registerMergeCommand,
  registerRollbackCommand,
} from "./session-lifecycle.ts";
import { FileReadSet } from "./file-read-set.ts";
import { FileShiftRegistry, type FileShiftInfo } from "./file-shift.ts";
import { FileWriteQueue } from "./file-write-queue.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import { GrepSeenState } from "./tools/grep-outline.ts";
import { WorkspacePathPolicy } from "./workspace-path-policy.ts";
import { DEFAULT_CACHE_COLD_SECS, ProviderCacheColdTracker } from "./providers/cache-cold.ts";
import { createStdoutSessionUiSink, createStdoutSubagentUiBridge, formatContextStatus } from "./session-ui.ts";
import { decodeProviderUsageEvent } from "./usage.ts";
import {
  exploreFallbackModelRef,
  registerExploreCapability,
  resolveExploreConfig,
} from "./explore/index.ts";
import type { SubagentUiBridge } from "./explore/subagent-ui.ts";
import { noopSubagentUiBridge } from "./explore/subagent-ui.ts";
import { registerPlanCapability } from "./plan/index.ts";
import { MergeGate, DirectRollbackGate, WorktreeSandbox, defaultAsk } from "../../extensions/xio-sandbox/src/index.ts";
import { expandHome } from "../cli/config-parser.ts";
import { createRuntimeEventEmitter } from "./events/emitter.ts";
import {
  createStreamJsonSessionUiSink,
  pipeRuntimeEventsToStreamJson,
} from "./events/stream-json.ts";
import { SteerMailbox, type SteerMode } from "./steer.ts";
import {
  HarnessController,
  type HarnessPhase,
} from "./harness/admission.ts";
import { SecretEnvironment } from "./secret-environment.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { ContextCompactionResult } from "./context-compaction.ts";
import type { SessionExecution } from "./session-store.ts";
import type { ChatMessage, ContextCompactionMode, ModelInfo, ProviderRegistration, SessionStartPayload, ThinkingLevel, TokenUsage, XioExtensionAPI } from "./types.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { LlmClient } from "./types.ts";
import type { AskFn } from "../../extensions/xio-sandbox/src/merge-gate.ts";
import type { XioRuntimeConfig, XioVerifyConfig } from "../cli/config-parser.ts";
import type { RuntimeEventEmitter } from "./events/types.ts";
import { applyThinkingLevel, cycleSessionThinkingLevel } from "./thinking-commands.ts";
import { availableThinkingLevels, clampThinkingLevel, findProviderModel } from "./thinking.ts";

export type SessionOutputFormat = "text" | "stream-json";

export type SessionOptions = Readonly<{
  cwd?: string;
  workspaceRoot?: string;
  runtimeConfig: XioRuntimeConfig;
  registerExtensions?: (api: XioExtensionAPI) => Promise<void> | void;
  promptOnce?: string;
  /**
   * stdout shape for non-interactive `-p` runs.
   * `stream-json`: only RuntimeEvent.v1 NDJSON on stdout; diagnostics on stderr.
   */
  outputFormat?: SessionOutputFormat;
  /** Session identity for RuntimeEvent envelopes (stream-json). */
  sessionId?: string;
  /** Escape hatch for non-interactive high-risk tools (CLI/config). */
  allowHighRisk?: boolean;
  /**
   * Pre-resolved project trust (tests). When omitted, resolved via ensureProjectTrust
   * using [trust] mode from runtimeConfig (default ask).
   */
  projectTrust?: ProjectTrustState;
  env?: NodeJS.ProcessEnv;
  /** Session-scoped secrets; created from env+credentials when omitted. */
  secretEnvironment?: SecretEnvironment;
  ask?: (question: string) => Promise<boolean>;
  interactive?: InteractiveIO;
  maxTurns?: number;
  sessionStart?: SessionStartPayload;
  uiSink?: SessionUiSink;
  initialMessages?: readonly ChatMessage[];
  onSessionSnapshot?: (snapshot: SessionSnapshot) => Promise<void> | void;
  model?: ModelInfo;
  initialExecution?: SessionExecution;
  /**
   * Optional write for stream-json stdout (tests). Default process.stdout.write.
   */
  streamJsonWrite?: (chunk: string) => void;
  /** Optional stderr for stream-json diagnostics (tests). */
  streamJsonStderr?: (chunk: string) => void;
  /** Inject RuntimeEvent bus (tests). When omitted, one is always created for the session. */
  runtimeEvents?: RuntimeEventEmitter;
  /** Optional bridge for explore subagent UI streaming (TUI passes TuiSessionBridge bridge). */
  subagentUi?: SubagentUiBridge;
  /** Test escape hatch: inject LLM client instead of building from provider registry. */
  llmClient?: LlmClient;
}>;

export type SessionSnapshot = Readonly<{
  model: ModelInfo;
  messages: readonly ChatMessage[];
  execution?: SessionExecution;
  workspaceLifecycle?: "active" | "retained" | "merged" | "discarded" | "clean_removed";
  /**
   * `journal` for mid-turn O(delta) WAL appends; `snapshot` (default) for full
   * state.json rewrite at turn boundaries and session lifecycle events.
   */
  durability?: "snapshot" | "journal";
  /** Durable compaction fact — appended to WAL before projection rewrite. */
  compaction?: import("./context-compaction.ts").SessionCompactionFact;
}>;

export type PreparedSession = Readonly<{
  host: ExtensionHost;
  /** Live session model — prefer getModel() after /model switches. */
  model: ModelInfo;
  getModel: () => ModelInfo;
  setModel: (model: ModelInfo) => Promise<void>;
  getThinkingLevel: () => ThinkingLevel;
  cycleThinkingLevel: () => Promise<ThinkingLevel>;
  getPermissionMode: () => PermissionMode;
  /** Set permission mode explicitly (e.g. /bypass → full). */
  setPermissionMode: (mode: PermissionMode) => PermissionMode;
  /** Cycle auto → full → strict → auto (Shift+Tab). */
  cyclePermissionMode: () => PermissionMode;
  compact: (focus?: string) => Promise<ContextCompactionResult>;
  runPrompt: (prompt: string) => Promise<{
    text: string;
    success: boolean;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    usage: TokenUsage;
    cancelled?: boolean;
  }>;
  /** Abort the in-flight agent turn (REPL Ctrl+C). No-op when idle. Pure cancel — no inject/continue. */
  abortTurn: () => void;
  /**
   * Mid-turn steer. Hard aborts provider/tools then continues with the steer text.
   * Soft waits for a tool/provider boundary (never mid-stream HTTP inject).
   * `auto` → hard when a turn is active, else soft.
   */
  steer: (text: string, mode?: SteerMode) => void;
  /**
   * Queue subsequent user work for the natural end of the current run
   * (no more tool calls and soft steer empty). Distinct from composer UI queue
   * and from soft steer (which adjusts the current turn).
   */
  followUp: (text: string) => void;
  getMessages: () => readonly ChatMessage[];
  /** Local workspace perception map + evidence store (non-blocking warm). */
  workspacePerception: WorkspacePerceptionService;
  close: () => Promise<void>;
  /** Wait until harness phase is idle and tracked settle work has finished. */
  waitForIdle: () => Promise<void>;
  /** Coarse harness phase (idle | turn | compaction | retry). */
  getHarnessPhase: () => HarnessPhase;
}>;

export async function prepareSession(options: SessionOptions): Promise<PreparedSession> {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ?? cwd;
  const env = options.env ?? process.env;
  const secretEnvironment = options.secretEnvironment
    ?? await SecretEnvironment.create({
      env,
      providers: options.runtimeConfig.providers,
    });
  const childEnv = secretEnvironment.buildChildEnv(env, {
    extraNames: options.runtimeConfig.tools?.childEnv ?? [],
  });
  const model = options.model ?? resolveDefaultModel(options.runtimeConfig);
  const verify = options.runtimeConfig.verify ?? { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] };
  const ask = options.ask ?? defaultAsk;
  const streamJson = options.outputFormat === "stream-json";
  const sessionEventId = options.sessionId ?? randomUUID().replaceAll("-", "").slice(0, 16);
  const runEventId = randomUUID().replaceAll("-", "").slice(0, 16);
  // Always create a RuntimeEvent.v1 bus so product sinks share one stream.
  const sink = streamJson
    ? (options.uiSink ?? createStreamJsonSessionUiSink(options.streamJsonStderr))
    : (options.uiSink ?? createStdoutSessionUiSink());
  // Subscriber failures are isolated from the loop but must surface as a UI notice (R6.4).
  const runtimeEvents = options.runtimeEvents
    ?? createRuntimeEventEmitter({
      sessionId: sessionEventId,
      runId: runEventId,
      redactValue: (payload) => secretEnvironment.redactProjection(payload),
      onSubscriberError: ({ event, phase, error }) => {
        const message = error instanceof Error ? error.message : String(error);
        sink.notify?.(`runtime-event subscriber failed (${phase}) on ${event}: ${message}`, "warn");
      },
    });
  const subagentUi = options.subagentUi
    ?? (streamJson ? noopSubagentUiBridge : createStdoutSubagentUiBridge());
  if (streamJson) {
    // Product sink A: NDJSON stdout. Evolve (when registered) is sink B via host.getRuntimeEvents().
    pipeRuntimeEventsToStreamJson(
      runtimeEvents,
      options.streamJsonWrite ?? ((chunk) => {
        process.stdout.write(chunk);
      }),
    );
  }
  // Text/TUI keep SessionUi callbacks (not bus→UI) so onAssistantText / bridge semantics stay intact.
  const interactive = options.interactive ?? createReadlineInteractiveIO(ask);
  const interactiveSession = options.promptOnce === undefined;
  const trustMode: TrustMode = options.runtimeConfig.trust?.mode ?? "ask";
  const worktreeSession = options.runtimeConfig.worktree?.session;
  const sessionGrant = worktreeSession
    ? sessionGrantFromWorktree(worktreeSession)
    : undefined;
  const projectTrust = options.projectTrust ?? await ensureProjectTrust({
    cwd,
    mode: trustMode,
    interactiveSession,
    ask: (question, detail) => interactive.ask(question, detail),
    notify: (message) => sink.notify?.(message, "info"),
    ...(sessionGrant ? { sessionGrant } : {}),
  });
  // Hygiene loaders (session_start) honor this for the remainder of the session.
  process.env.XIO_INCLUDE_PROJECT = allowsProjectResources(projectTrust.decision) ? "1" : "0";
  sink.setStatus?.("trust", `trust:${projectTrust.decision}`);

  const steerMailbox = new SteerMailbox();
  const harness = new HarnessController({ runtimeEvents });
  const turnSnapshotEnabled = options.runtimeConfig.harness?.snapshot !== false;
  // Perception before host config so main + explore share one warm service.
  const workspacePerception = new WorkspacePerceptionService({ root: workspaceRoot });
  // Non-blocking: never await full index on the interactive startup path.
  void workspacePerception.ensureWarm();
  // Shared across the session: same-path write/edit serialize; readSet survives abort
  // within a run and clears on each new user turn (see beforePrompt below).
  const fileWriteQueue = new FileWriteQueue();
  const fileReadSet = new FileReadSet();
  const grepSeen = new GrepSeenState();
  const fileShift = new FileShiftRegistry();
  const requireReadBeforeEdit = options.runtimeConfig.tools?.requireReadBeforeEdit !== false;
  const pathPolicy = await WorkspacePathPolicy.create({ workspaceRoot, cwd });
  const { host, mergeGate, rollbackGate, ensureExploreForUltra } = await createConfiguredHost({
    options,
    model,
    sink,
    ask,
    cwd,
    workspaceRoot,
    workspacePerception,
    runtimeEvents,
    subagentUi,
    fileWriteQueue,
    fileReadSet,
    grepSeen,
    fileShift,
    requireReadBeforeEdit,
    pathPolicy,
    childEnv,
    secretEnvironment,
  });

  let currentModel = model;
  let registration = host.getProvider(currentModel.provider)
    ?? (options.llmClient
      ? {
        name: currentModel.provider,
        api: "openai-completions" as const,
        models: [{ id: currentModel.id, name: currentModel.id }],
      }
      : (interactiveSession
        ? (() => {
          const placeholder: ProviderRegistration = {
            name: currentModel.provider,
            api: "openai-completions" as const,
            models: [{ id: currentModel.id, name: currentModel.id }],
          };
          host.registerProvider(currentModel.provider, placeholder);
          sink.notify?.(
            `Provider "${currentModel.provider}" is not configured. Run /connect or /model to set up credentials.`,
            "warning",
          );
          return placeholder;
        })()
        : requireSessionRegistration(host, currentModel)));
  let client: LlmClient | undefined = options.llmClient;
  const getOrCreateClient = (): LlmClient => {
    if (client) return client;
    const created = createSessionClient({ host, model: currentModel, secretEnvironment });
    client = created.client;
    registration = created.registration;
    return client;
  };
  const modelStatus = (): string => {
    if (client) return `${currentModel.provider}/${currentModel.id}`;
    try {
      // Project only availability; never emit or retain the resolved secret.
      secretEnvironment.resolveProvider(registration);
      return `${currentModel.provider}/${currentModel.id}`;
    } catch {
      return "not connected · /connect";
    }
  };
  let parallelToolCalls = options.runtimeConfig.providers[currentModel.provider]?.parallelToolCalls ?? true;
  let turnAbort: AbortController | undefined;
  let currentExecution: SessionExecution = options.initialExecution ?? { phase: "idle" };
  let workspaceLifecycle: SessionSnapshot["workspaceLifecycle"] = "active";
  const maxSessionMessages = options.runtimeConfig.general.maxSessionMessages ?? 80;
  host.on("tool_result", async (payload) => {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const call = record.call && typeof record.call === "object"
      ? record.call as Record<string, unknown>
      : undefined;
    const toolName = typeof call?.name === "string" ? call.name : undefined;
    if (toolName !== "write" && toolName !== "edit") return;
    const args = call?.args && typeof call.args === "object"
      ? call.args as Record<string, unknown>
      : undefined;
    const filePath = typeof args?.path === "string" ? args.path : undefined;
    if (!filePath) return;
    const rel = path.isAbsolute(filePath)
      ? path.relative(workspaceRoot, filePath)
      : filePath;
    if (rel.startsWith("..")) return;
    try {
      await workspacePerception.noteMutation(rel.replace(/\\/g, "/"), toolName === "write" ? "write" : "edit");
    } catch (error) {
      // Do not fail the tool_result path; surface refresh failure so map is not silently stale.
      const message = error instanceof Error ? error.message : String(error);
      workspacePerception.markRefreshFailed(error);
      sink.setStatus?.("workspace_perception", `stale: ${message.slice(0, 80)}`);
      sink.notify?.(
        `workspace perception refresh failed for ${rel}: ${message}`,
        "warn",
      );
    }
  });
  // Latest request usage → context occupancy for the status row. Tokens are
  // provider-reported per provider_response (prompt already includes cache
  // reads after normalization); shown as % of the model context window, no
  // cost estimate. Decode failures surface as a warn notice, never silently.
  host.on("provider_response", async (payload) => {
    try {
      const usage = decodeProviderUsageEvent(payload);
      const used = Math.max(0, usage.inputTokens ?? 0) + Math.max(0, usage.outputTokens ?? 0);
      const modelCfg = registration.models.find((entry) => entry.id === currentModel.id)
        ?? registration.models[0];
      sink.setStatus?.("usage", formatContextStatus(used, modelCfg?.contextWindow));
    } catch (error) {
      sink.notify?.(
        `usage status update failed: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
    }
  });
  const history = new SessionHistory({
    initialMessages: options.initialMessages,
    persist: async (messages, meta) => {
      const { getGlobalTracer } = await import("./perf/index.ts");
      const tracer = getGlobalTracer(options.env ?? process.env);
      const active = tracer?.start("checkpoint.persist", { attrs: { kind: "session_snapshot" } });
      try {
        await options.onSessionSnapshot?.({
          model: currentModel,
          messages,
          execution: currentExecution,
          workspaceLifecycle,
          ...(meta?.compaction ? { compaction: meta.compaction } : {}),
        });
        tracer?.end(active, "success");
      } catch (error) {
        tracer?.end(active, "failure", { error_class: "io" });
        throw error;
      }
    },
  });
  mergeGate?.setCheckpointClearedHandler(async () => {
    currentExecution = { phase: "idle" };
    await history.persist();
  });
  const createTurnSignal = () => {
    turnAbort = new AbortController();
    return turnAbort.signal;
  };

  const getModel = () => currentModel;
  const onThinkingLevelChanged = async (level: ThinkingLevel) => {
    if (level === "ultra") {
      await ensureExploreForUltra();
    }
  };
  const thinkingOpts = {
    host,
    interactive,
    sink,
    getModel,
    env,
    onThinkingLevelChanged,
  };
  const setModel = async (next: ModelInfo) => {
    const created = createSessionClient({ host, model: next, secretEnvironment });
    currentModel = next;
    client = created.client;
    registration = created.registration;
    parallelToolCalls = options.runtimeConfig.providers[currentModel.provider]?.parallelToolCalls ?? true;
    await host.setModel(currentModel);
    sink.setStatus?.("model", `${currentModel.provider}/${currentModel.id}`);
    const providerModel = findProviderModel(registration, currentModel.id);
    const clamped = clampThinkingLevel(host.getThinkingLevel(), availableThinkingLevels(providerModel));
    await applyThinkingLevel({ ...thinkingOpts, persist: false }, clamped);
    await host.emit("model_change", { provider: currentModel.provider, model: currentModel.id });
    await history.persist();
  };

  registerConnectCommands({
    host,
    interactive,
    runtimeConfig: options.runtimeConfig,
    env,
    secretEnvironment,
    sink,
    getModel,
    setModel,
  });
  registerThinkingCommands({
    host,
    interactive,
    sink,
    getModel,
    env,
    onThinkingLevelChanged,
  });
  // Permission mode + high-risk gate before session_start so MCP hot-register respects filters.
  const allowHighRisk =
    options.allowHighRisk === true || options.runtimeConfig.permissions?.allowHighRisk === true;
  const permission = registerPermissionCommands({
    host,
    sink,
    interactive,
    allowHighRisk,
    interactiveSession,
    getTrust: () => projectTrust.decision,
    pathPolicy,
  });
  const getRunId = async (): Promise<string | undefined> => {
    try {
      const status = await host.runCommand("status");
      if (status && typeof status === "object" && "runId" in status) {
        const id = (status as { runId?: unknown }).runId;
        return typeof id === "string" ? id : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };
  host.registerCommand("regress", {
    description: "Regression capture tool (archived).",
    handler: async () => "/regress has been archived into archive/extensions/xio-regress (Route B: focus on core coding agent resilience).",
  });

  registerRollbackCommand(
    host,
    rollbackGate,
    ask,
    sink,
  );

  const contextCompaction = new ContextCompactionController({
    history,
    getClient: getOrCreateClient,
    getModel,
    maxMessages: maxSessionMessages,
    getMaxTokens: () => {
      const modelCfg = registration.models.find((entry) => entry.id === currentModel.id)
        ?? registration.models[0];
      return resolveSessionTokenBudget({
        configured: options.runtimeConfig.general.maxSessionTokens,
        contextWindow: modelCfg?.contextWindow,
      });
    },
    redactOutbound: (value) => secretEnvironment.redactProjection(value),
    onUiEvent: (event) => sink.onContextCompaction?.(event),
    onRuntimeEvent: async (event) => {
      try {
        await host.emit("context_compaction", event);
      } catch (error) {
        sink.notify?.(
          `Context compaction telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
  const compact = async (mode: ContextCompactionMode, focus?: string) => {
    // Manual / automatic-from-command compaction only when idle.
    // Automatic pre-prompt compaction runs inside an admitted prompt turn.
    if (mode !== "automatic") {
      harness.begin("compaction");
    }
    try {
      return await contextCompaction.compact(mode, focus, createTurnSignal());
    } finally {
      if (mode !== "automatic") {
        await harness.end();
      }
    }
  };
  registerContextCommands({ host, compact });

  // Surface workspace identity so TUI + agent know main vs worktree.
  {
    const provenance = options.sessionStart?.provenance as
      | Readonly<{ main_root?: string; workspace_root?: string }>
      | undefined;
    const main = provenance?.main_root ?? workspaceRoot;
    const wt = provenance?.workspace_root ?? cwd;
    const directCwd = path.resolve(main) === path.resolve(wt);
    // Quiet badge for footer — never scream DIRECT / NO MERGEGATE into the header.
    sink.setStatus?.("workspace", directCwd ? "direct" : "worktree");
    // Only announce when actually sandboxed; direct-cwd is the default UX.
    if (!directCwd) {
      sink.notify?.(
        `workspace: agent cwd = worktree (from launch directory)\n  main: ${main}\n  worktree: ${wt}`,
        "info",
      );
    }
  }

  await host.emit("session_start", {
    ...(options.sessionStart ?? {}),
    provider: currentModel.provider,
    model: currentModel.id,
  });

  await history.persist();
  sink.setStatus?.("model", modelStatus());
  sink.setStatus?.("thinking", thinkingStatusLabel(host.getThinkingLevel()));

  const session: PreparedSession = {
    host,
    get model() {
      return currentModel;
    },
    getModel,
    setModel,
    getThinkingLevel: () => host.getThinkingLevel(),
    cycleThinkingLevel: () => cycleSessionThinkingLevel(thinkingOpts),
    getPermissionMode: () => permission.getMode(),
    setPermissionMode: (mode) => permission.setMode(mode),
    cyclePermissionMode: () => permission.cycleMode(),
    compact: (focus) => compact("manual", focus),
    workspacePerception,
    waitForIdle: () => harness.waitForIdle(),
    getHarnessPhase: () => harness.phase,
    runPrompt: createPromptRunner({
      host,
      getClient: getOrCreateClient,
      getModel,
      getProviderApi: () => registration.api,
      maxTurns: options.maxTurns ?? options.runtimeConfig.general.maxTurns,
      repeatToolLimit: options.runtimeConfig.general.repeatToolLimit,
      doneContract: toDoneContract(verify),
      doneContractEnv: childEnv,
      redactOutbound: (value) => secretEnvironment.redactProjection(value),
      verify,
      getParallelToolCalls: () => parallelToolCalls,
      maxSessionMessages,
      getSignal: createTurnSignal,
      resetSignal: createTurnSignal,
      steerMailbox,
      harness,
      turnSnapshot: turnSnapshotEnabled,
      streamingTools: options.runtimeConfig.agent?.streamingTools === true,
      toolResultMaxChars: options.runtimeConfig.context?.toolResultMaxChars,
      toolResultKeepRounds: options.runtimeConfig.context?.keepToolRounds,
      getToolResultSpillDir: async () => {
        const runId = await getRunId();
        if (!runId) return undefined;
        const runRoot = expandHome(options.runtimeConfig.general.runRoot);
        return path.join(runRoot, runId, "tool-results");
      },
      getRunId,
      failureCapture: undefined,
      beforePrompt: async () => {
        // New user turn: reset read discipline so prior-turn reads do not authorize edits.
        // Abort / hard-steer hops within the same runPrompt do not hit this path.
        fileReadSet.clear();
        // Fresh prompt should not inherit stale grep-outline "already shown" state.
        grepSeen.clear();
        // Fresh prompt resets the cross-context read landscape for file-shift detection.
        fileShift.clear();
        if (rollbackGate?.captureTurnCheckpoint) {
          try {
            const checkpoint = await rollbackGate.captureTurnCheckpoint();
            if (checkpoint) {
              currentExecution = {
                phase: "turn_started",
                turn_id: randomUUID().replaceAll("-", ""),
                checkpoint,
              };
            }
          } catch {
            // Ignore checkpoint capture failure on non-git trees
          }
        }
      },
      onCheckpoint: async (checkpoint) => {
        const turnComplete = checkpoint.phase === "turn_complete";
        currentExecution = {
          phase: turnComplete ? "idle" : checkpoint.phase,
          ...(currentExecution.turn_id ? { turn_id: currentExecution.turn_id } : {}),
          ...(currentExecution.checkpoint ? { checkpoint: currentExecution.checkpoint } : {}),
          ...(checkpoint.pendingTools && checkpoint.pendingTools.length > 0
            ? { pending_tools: checkpoint.pendingTools.map((tool) => ({ ...tool })) }
            : {}),
        };
        const { getGlobalTracer } = await import("./perf/index.ts");
        const tracer = getGlobalTracer(options.env ?? process.env);
        const active = tracer?.start("checkpoint.persist", {
          attrs: {
            kind: turnComplete ? "snapshot" : "journal",
            phase: checkpoint.phase,
            message_count: checkpoint.messages.length,
          },
        });
        try {
          await options.onSessionSnapshot?.({
            model: currentModel,
            messages: checkpoint.messages,
            execution: currentExecution,
            durability: turnComplete ? "snapshot" : "journal",
          });
          tracer?.end(active, "success");
        } catch (error) {
          tracer?.end(active, "failure", { error_class: "io" });
          throw error;
        }
      },
      sink,
      history,
      contextCompaction,
      runtimeEvents,
    }),
    close: createSessionCloser({
      host,
      mergeGate,
      ask,
      retainOnReject: options.runtimeConfig.worktree.retainOnReject,
      sink,
      onFinalized: async (disposition) => {
        workspaceLifecycle = disposition;
        if (disposition !== "retained") {
          currentExecution = { phase: "idle" };
        }
        await history.persist();
      },
      onClosed: () => {
        secretEnvironment.dispose();
      },
    }),
    abortTurn: () => {
      turnAbort?.abort();
      // Pure abort (Stop): discard follow-ups visibly — never silent later execution.
      const discarded = steerMailbox.clearFollowUp();
      for (const item of discarded) {
        runtimeEvents?.emit("follow_up.discarded", {
          text: item.text,
          id: item.id,
          reason: "abort",
        });
      }
      if (discarded.length > 0) {
        runtimeEvents?.emit("queue_updated", {
          soft: steerMailbox.list().filter((item) => item.mode === "soft").length,
          hard: steerMailbox.list().filter((item) => item.mode === "hard").length,
          follow_up: 0,
        });
        const preview = discarded.map((item) => item.text.slice(0, 40)).join("; ");
        sink.notify?.(
          `Follow-up discarded on abort (${discarded.length}): ${preview}`,
          "warn",
        );
      }
    },
    steer: (text, mode = "auto") => {
      const busy = turnAbort !== undefined && turnAbort.signal.aborted === false;
      // auto: hard while a turn signal is live; soft when idle (queued for next boundary/loop).
      const request = steerMailbox.enqueue({ text, mode, busy: busy || mode === "hard" });
      runtimeEvents?.emit("steer.requested", {
        mode: request.mode,
        text: request.text,
        id: request.id,
      });
      runtimeEvents?.emit("queue_updated", {
        soft: steerMailbox.list().filter((item) => item.mode === "soft").length,
        hard: steerMailbox.list().filter((item) => item.mode === "hard").length,
        follow_up: steerMailbox.listFollowUp().length,
      });
      if (request.mode === "hard") {
        turnAbort?.abort();
      }
    },
    followUp: (text) => {
      const request = steerMailbox.enqueueFollowUp({ text });
      runtimeEvents?.emit("follow_up.queued", {
        text: request.text,
        id: request.id,
        pending: steerMailbox.listFollowUp().length,
      });
      runtimeEvents?.emit("queue_updated", {
        soft: steerMailbox.list().filter((item) => item.mode === "soft").length,
        hard: steerMailbox.list().filter((item) => item.mode === "hard").length,
        follow_up: steerMailbox.listFollowUp().length,
      });
      sink.notify?.(
        `Follow-up queued (after current task ends): ${request.text.slice(0, 80)}`,
        "info",
      );
    },
    getMessages: () => history.getMessages(),
  };
  return session;
}

async function createConfiguredHost(input: Readonly<{
  options: SessionOptions;
  model: ModelInfo;
  sink: SessionUiSink;
  ask: AskFn;
  cwd: string;
  workspaceRoot: string;
  workspacePerception: WorkspacePerceptionService;
  runtimeEvents?: RuntimeEventEmitter;
  subagentUi?: SubagentUiBridge;
  fileWriteQueue?: FileWriteQueue;
  fileReadSet?: FileReadSet;
  grepSeen?: GrepSeenState;
  fileShift?: FileShiftRegistry;
  requireReadBeforeEdit?: boolean;
  pathPolicy?: WorkspacePathPolicy;
  childEnv: NodeJS.ProcessEnv;
  secretEnvironment: SecretEnvironment;
}>): Promise<{
  host: ExtensionHost;
  mergeGate?: MergeGate;
  directGate?: DirectRollbackGate;
  rollbackGate?: import("./session-lifecycle.ts").RollbackGate;
  ensureExploreForUltra: () => Promise<unknown>;
}> {
  const host = createSessionHost(
    input.model,
    input.sink,
    input.options.runtimeConfig.general.defaultThinkingLevel,
  );
  if (input.runtimeEvents) {
    host.setRuntimeEvents(input.runtimeEvents);
  }
  for (const tool of createBuiltinTools({
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    pathPolicy: input.pathPolicy,
    writeQueue: input.fileWriteQueue,
    readSet: input.fileReadSet,
    grepSeen: input.grepSeen,
    fileShift: input.fileShift,
    contextId: "main",
    onFileShift: (info) => emitFileShift(info, input.runtimeEvents, input.sink),
    requireReadBeforeEdit: input.requireReadBeforeEdit,
    childEnv: input.childEnv,
  })) {
    host.registerTool(tool);
  }
  registerPerceptionCapability(host, { service: input.workspacePerception });
  registerConfiguredProviders(host, input.options.runtimeConfig);
  registerCacheColdWarning(host, {
    coldSecs: input.options.runtimeConfig.providerRuntime?.cacheColdSecs ?? DEFAULT_CACHE_COLD_SECS,
    runtimeEvents: input.runtimeEvents,
    sink: input.sink,
  });
  const worktreeSession = input.options.runtimeConfig.worktree?.session;
  const restoredCheckpoint = input.options.initialExecution?.checkpoint;
  const mergeGate = worktreeSession ? new MergeGate(worktreeSession, restoredCheckpoint) : undefined;
  let directGate: DirectRollbackGate | undefined;
  if (!mergeGate) {
    const gitRoot = await WorktreeSandbox.tryResolveMainRoot(input.workspaceRoot);
    if (gitRoot) {
      directGate = new DirectRollbackGate(gitRoot, restoredCheckpoint);
      await directGate.initSessionBaseline();
    }
  }
  const rollbackGate = mergeGate ?? directGate;
  await input.options.registerExtensions?.(host);
  // After extensions so explore prompt addendum and tool sit on the full host surface.
  // Ultra auto-enables explore even when [explore] enabled = false.
  const explore = await registerExploreCapability(host, {
    runtimeConfig: input.options.runtimeConfig,
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    env: input.options.env,
    secretEnvironment: input.secretEnvironment,
    childEnv: input.childEnv,
    onNotify: (message) => input.sink.notify?.(message, "info"),
    onStatus: (key, text) => input.sink.setStatus?.(key, text),
    workspacePerception: input.workspacePerception,
    subagentUi: input.subagentUi,
    fileShift: input.fileShift,
    onFileShift: (info) => emitFileShift(info, input.runtimeEvents, input.sink),
  });
  await registerPlanCapability(host, {
    workspaceRoot: input.workspaceRoot,
    sink: input.sink,
  });
  if (mergeGate) {
    registerMergeCommand(host, mergeGate, input.ask, input.sink);
  }
  // Rollback is registered in prepareSession after failure-capture offer is wired.
  // session_start is emitted from prepareSession after /agent filter is installed.
  return {
    host,
    mergeGate,
    directGate,
    rollbackGate,
    ensureExploreForUltra: () => explore.ensure("ultra"),
  };
}

/**
 * Observe each `provider_response` and surface Anthropic prompt-cache cold warnings.
 * Best-effort projection: a hint failure must never break the turn, and it never
 * issues keep-alive requests (report only, no token burn).
 */
function registerCacheColdWarning(
  host: ExtensionHost,
  input: Readonly<{
    coldSecs: number;
    runtimeEvents?: RuntimeEventEmitter;
    sink: SessionUiSink;
  }>,
): void {
  const tracker = new ProviderCacheColdTracker(input.coldSecs);
  host.on("provider_response", (payload) => {
    const record = payload as { providerApi?: unknown; usage?: { cacheTokens?: unknown } };
    const providerApi = typeof record.providerApi === "string" ? record.providerApi : "";
    const cacheTokens = typeof record.usage?.cacheTokens === "number" ? record.usage.cacheTokens : null;
    const warning = tracker.observe({ providerApi, cacheTokens, now: Date.now() });
    if (!warning) return;
    input.runtimeEvents?.emit("provider.cache_cold_warning", {
      since_last_hit_secs: warning.sinceLastHitSecs,
      cold_secs: warning.coldSecs,
    });
    input.sink.notify?.(
      `prompt cache likely cold: ${warning.sinceLastHitSecs}s since last hit `
      + `(> ${warning.coldSecs}s); this turn paid full uncached input.`,
      "warn",
    );
  });
}

/**
 * Project a cross-context file shift as a `workspace.file_shifted` RuntimeEvent + a
 * non-blocking hint. Report only — never auto-spawn a fixer or auto-revert.
 */
function emitFileShift(
  info: FileShiftInfo,
  runtimeEvents: RuntimeEventEmitter | undefined,
  sink: SessionUiSink,
): void {
  runtimeEvents?.emit("workspace.file_shifted", {
    path: info.path,
    writer: info.writer,
    readers: info.readers,
  });
  sink.notify?.(
    `file shifted underneath: ${info.path} written by ${info.writer} after `
    + `${info.readers.join(", ")} read it — that view may be stale.`,
    "warn",
  );
}

function createSessionClient(input: Readonly<{
  host: ExtensionHost;
  model: ModelInfo;
  secretEnvironment: SecretEnvironment;
}>): { client: LlmClient; registration: ProviderRegistration } {
  const registration = requireSessionRegistration(input.host, input.model);
  const client = createLlmClient({
    registration,
    apiKey: input.secretEnvironment.resolveProvider(registration),
  });
  return { client, registration };
}

function requireSessionRegistration(host: ExtensionHost, model: ModelInfo): ProviderRegistration {
  const registration = host.getProvider(model.provider);
  if (registration) return registration;
  throw new Error(
    `provider not registered: ${model.provider}. Run /connect or add it under [providers.*] in config.toml`,
  );
}

export function toDoneContract(verify: XioVerifyConfig): DoneContract | undefined {
  if (!verify.enabled || verify.commands.length === 0) {
    return undefined;
  }
  return {
    requireAllPass: verify.requireAllPass,
    commands: verify.commands.map((command) => ({
      name: command.name,
      argv: command.argv,
      cwd: command.cwd,
    })),
  };
}

export async function runSession(options: SessionOptions): Promise<number> {
  const session = await prepareSession(options);
  const { getGlobalTracer, isPerfEnabled } = await import("./perf/index.ts");
  const tracer = getGlobalTracer(options.env ?? process.env);
  tracer?.mark("prompt_ready", "success", { attrs: { ui: "stdout" } });
  if ((options.env ?? process.env).XIO_PERF_BOOT_EXIT === "1") {
    if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
      tracer?.mark("first_frame", "success", { attrs: { ui: "stdout", boot_exit: true } });
    }
    if (isPerfEnabled(options.env ?? process.env) && tracer) {
      const { writeSync } = await import("node:fs");
      for (const span of tracer.getSpans()) {
        writeSync(process.stdout.fd, `${JSON.stringify(span)}\n`);
      }
    }
    await session.close();
    return 0;
  }
  try {
    if (options.promptOnce !== undefined) {
      const result = await session.runPrompt(options.promptOnce);
      return result.success ? 0 : 1;
    }
    if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
      tracer?.mark("first_frame", "success", { attrs: { ui: "stdout" } });
    }
    return await runRepl(session);
  } finally {
    await session.close();
  }
}

async function runRepl(session: PreparedSession): Promise<number> {
  const rl = createInterface({ input, output, terminal: true });
  let busy = false;
  const onSigInt = () => {
    if (busy) {
      session.abortTurn();
      output.write("\n^C (cancel turn — press Ctrl+C again while idle to exit)\n");
      return;
    }
    output.write("\n");
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", onSigInt);
  output.write("XioCode REPL — type a prompt, /help for commands, /exit to quit\n");
  output.write("Ctrl+C cancels the current turn; Ctrl+C again while idle exits.\n");
  try {
    for (;;) {
      const line = (await rl.question("xio> ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/exit" || line === "/quit") {
        return 0;
      }
      if (line === "/help") {
        output.write("Commands: /help /compact /connect /model /thinking /permission /plan /regress /status /merge /rollback /sandbox /exit\nSlash commands map to registered extension commands when available.\nShift+Tab cycles permission (auto|full|strict) in the Ink TUI.\n");
        continue;
      }
      if (line.startsWith("/")) {
        const [name, ...rest] = line.slice(1).split(/\s+/);
        if (!name) {
          continue;
        }
        try {
          const result = await session.host.runCommand(name, rest.join(" "));
          if (result !== undefined) {
            output.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
          }
        } catch (error) {
          if (!isContextCompactionError(error)) {
            output.write(`${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        continue;
      }
      busy = true;
      try {
        await session.runPrompt(line);
      } catch (error) {
        if (!isContextCompactionError(error)) {
          output.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      } finally {
        busy = false;
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }
}
