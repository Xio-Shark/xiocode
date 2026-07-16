import { readFile } from "node:fs/promises";

import {
  AGENT_TAPE_SCHEMA_VERSION,
  type AgentTapeV1,
  type TapeStep,
  type TapeTurn,
} from "./types.ts";

export class AgentTapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTapeError";
  }
}

/** Validate and normalize a tape object (from JSON or inline fixture). */
export function parseAgentTape(value: unknown): AgentTapeV1 {
  const record = asRecord(value);
  if (!record) {
    throw new AgentTapeError("tape must be an object");
  }
  if (record.schema_version !== AGENT_TAPE_SCHEMA_VERSION) {
    throw new AgentTapeError(
      `unsupported tape schema_version: ${String(record.schema_version)} (expected ${AGENT_TAPE_SCHEMA_VERSION})`,
    );
  }
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new AgentTapeError("tape.name must be a non-empty string");
  }
  if (!Array.isArray(record.turns) || record.turns.length === 0) {
    throw new AgentTapeError("tape.turns must be a non-empty array");
  }
  const turns: TapeTurn[] = record.turns.map((turn, index) => parseTurn(turn, index));
  return {
    schema_version: AGENT_TAPE_SCHEMA_VERSION,
    name: record.name,
    turns,
  };
}

export async function loadAgentTape(filePath: string): Promise<AgentTapeV1> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentTapeError(
      `invalid JSON tape ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseAgentTape(parsed);
}

function parseTurn(value: unknown, index: number): TapeTurn {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.steps)) {
    throw new AgentTapeError(`turns[${index}].steps must be an array`);
  }
  if (record.steps.length === 0) {
    throw new AgentTapeError(`turns[${index}].steps must not be empty`);
  }
  return {
    steps: record.steps.map((step, stepIndex) => parseStep(step, index, stepIndex)),
  };
}

function parseStep(value: unknown, turnIndex: number, stepIndex: number): TapeStep {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    throw new AgentTapeError(`turns[${turnIndex}].steps[${stepIndex}] missing type`);
  }
  const loc = `turns[${turnIndex}].steps[${stepIndex}]`;
  switch (record.type) {
    case "delta": {
      if (record.channel !== "text" && record.channel !== "thinking") {
        throw new AgentTapeError(`${loc}: delta.channel must be text|thinking`);
      }
      if (!Array.isArray(record.chunks) || record.chunks.some((c) => typeof c !== "string")) {
        throw new AgentTapeError(`${loc}: delta.chunks must be string[]`);
      }
      return {
        type: "delta",
        channel: record.channel,
        chunks: record.chunks as string[],
      };
    }
    case "tool_call": {
      if (typeof record.id !== "string" || typeof record.name !== "string") {
        throw new AgentTapeError(`${loc}: tool_call requires id and name`);
      }
      const args = asRecord(record.arguments) ?? {};
      return {
        type: "tool_call",
        id: record.id,
        name: record.name,
        arguments: args,
      };
    }
    case "usage":
      return {
        type: "usage",
        inputTokens: numberOrNull(record.inputTokens),
        outputTokens: numberOrNull(record.outputTokens),
        cacheTokens: numberOrNull(record.cacheTokens),
        reasoningTokens: numberOrNull(record.reasoningTokens),
      };
    case "error": {
      if (typeof record.class !== "string" || record.class.length === 0) {
        throw new AgentTapeError(`${loc}: error.class required`);
      }
      return {
        type: "error",
        class: record.class,
        message: typeof record.message === "string" ? record.message : undefined,
      };
    }
    case "hang": {
      const ms = typeof record.ms === "number" && Number.isFinite(record.ms) ? record.ms : 0;
      return { type: "hang", ms: Math.max(0, ms) };
    }
    case "barrier": {
      if (typeof record.id !== "string" || record.id.length === 0) {
        throw new AgentTapeError(`${loc}: barrier.id required`);
      }
      return { type: "barrier", id: record.id };
    }
    case "done":
      return { type: "done" };
    default:
      throw new AgentTapeError(`${loc}: unknown step type ${record.type}`);
  }
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
