import type {
  LlmClient,
  ModelInfo,
  ProviderToolChoice,
  ProviderToolChoiceScope,
  ToolDefinition,
} from "../types.ts";

/**
 * Live session config — getters return the latest values.
 * Must not be mutated by a turn that already created a TurnSnapshot.
 */
export type LiveConfigView = Readonly<{
  model: ModelInfo;
  /** Provider request model id (usually model.id). */
  modelId: string;
  providerName?: string;
  providerApi: string;
  client: LlmClient;
  parallelToolCalls: boolean;
  tools: readonly ToolDefinition[];
  maxTokens?: number;
  toolChoice?: ProviderToolChoice;
  toolChoiceScope?: ProviderToolChoiceScope;
}>;

/**
 * Immutable view of config actually used for one provider request.
 * Created at the provider boundary; live config changes take effect only on
 * the next snapshot (after save-point).
 */
export type TurnSnapshot = Readonly<{
  id: string;
  createdAt: number;
  model: ModelInfo;
  modelId: string;
  providerName?: string;
  providerApi: string;
  client: LlmClient;
  parallelToolCalls: boolean;
  tools: readonly ToolDefinition[];
  maxTokens?: number;
  toolChoice?: ProviderToolChoice;
  toolChoiceScope?: ProviderToolChoiceScope;
}>;

let snapshotSeq = 0;

/** Build a frozen TurnSnapshot from the current live config view. */
export function createTurnSnapshot(live: LiveConfigView): TurnSnapshot {
  snapshotSeq += 1;
  const tools = Object.freeze(live.tools.slice()) as readonly ToolDefinition[];
  return Object.freeze({
    id: `snap-${snapshotSeq}-${Date.now().toString(36)}`,
    createdAt: Date.now(),
    model: Object.freeze({ ...live.model }),
    modelId: live.modelId,
    ...(live.providerName !== undefined ? { providerName: live.providerName } : {}),
    providerApi: live.providerApi,
    client: live.client,
    parallelToolCalls: live.parallelToolCalls,
    tools,
    ...(live.maxTokens !== undefined ? { maxTokens: live.maxTokens } : {}),
    ...(live.toolChoice !== undefined ? { toolChoice: live.toolChoice } : {}),
    ...(live.toolChoiceScope !== undefined ? { toolChoiceScope: live.toolChoiceScope } : {}),
  });
}

/** Test helper: reset snapshot id sequence. */
export function resetTurnSnapshotSeqForTests(): void {
  snapshotSeq = 0;
}
