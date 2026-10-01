/**
 * What a parallel worker saw and did, as a replayable log.
 *
 * A worker's decisions depend only on what its read-only tools returned. If
 * every one of those observations comes out the same on a newer base, its
 * edits are still justified there, even though files it read were changed.
 * The kernel checks exactly that at commit (`observationValidation`), and only
 * after its file-level validation reported a conflict.
 */
import { createHash } from "node:crypto";

import type { ObservationEntry as KernelObservationEntry, ObservationValidation } from "@xioflow/kernel";

import { createBuiltinTools } from "./tools/builtin.ts";
import type { ChatToolCall, ToolDefinition, ToolExecuteResult } from "./types.ts";
import { WorkspacePathPolicy } from "./workspace-path-policy.ts";

export type ObservationEntry = Readonly<{
  kind: "observe" | "mutate";
  tool: string;
  /** Arguments with the fork's absolute path replaced by a placeholder. */
  args: Record<string, unknown>;
  /** Hash of the normalised result text: everything the worker was shown for this call. */
  resultHash: string;
  resultBytes: number;
  isError: boolean;
}>;

const OBSERVE = new Set(["read", "grep", "glob"]);
const MUTATE = new Set(["write", "edit"]);
const ROOT_PLACEHOLDER = "<root>";

/** Everything the model was shown; a part that is not text (an image) is kept as its JSON so a change in it still shows. */
export function resultText(result: ToolExecuteResult): string {
  return result.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : JSON.stringify(part))).join("");
}

function withRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.split(ROOT_PLACEHOLDER).join(root);
  if (Array.isArray(value)) return value.map((item) => withRoot(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withRoot(item, root)]));
  }
  return value;
}

function withoutRoot(text: string, root: string): string {
  return root.length > 0 ? text.split(root).join(ROOT_PLACEHOLDER) : text;
}

function normaliseArgs(value: unknown, root: string): unknown {
  if (typeof value === "string") return withoutRoot(value, root);
  if (Array.isArray(value)) return value.map((item) => normaliseArgs(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normaliseArgs(item, root)]));
  }
  return value;
}

/**
 * The comparable form of an observation. Replaying in another directory must
 * give the same text when the content is the same: absolute paths become a
 * placeholder, and search results are sorted, because a multi-threaded search
 * returns lines in no stable order.
 */
export function normalizeObservation(tool: string, text: string, root: string): string {
  const portable = withoutRoot(text, root);
  // write / edit: the result can end with a list of references found by a search (the blast-radius note).
  if (tool === "grep" || tool === "glob" || MUTATE.has(tool)) return portable.split("\n").sort().join("\n");
  return portable;
}

export function hashObservation(tool: string, text: string, root: string): string {
  return createHash("sha256").update(normalizeObservation(tool, text, root)).digest("hex").slice(0, 16);
}

/** One log entry for a finished tool call; undefined for tools that are neither an observation nor an edit. */
export function toObservationEntry(call: ChatToolCall, result: ToolExecuteResult, root: string): ObservationEntry | undefined {
  const kind = OBSERVE.has(call.name) ? "observe" : MUTATE.has(call.name) ? "mutate" : undefined;
  if (!kind) return undefined;
  const text = resultText(result);
  return {
    kind,
    tool: call.name,
    args: normaliseArgs(call.arguments, root) as Record<string, unknown>,
    resultHash: hashObservation(call.name, text, root),
    resultBytes: Buffer.byteLength(text),
    isError: result.isError === true,
  };
}

/**
 * Hands a worker's log to the kernel together with the way to re-run one step in another directory.
 *
 * Each directory gets one set of tools, used for the whole log, so that "read before edit" holds during
 * the replay as it did for the worker. An edit is replayed as it ran: the kernel only gets this far when
 * nobody else touched the files this worker wrote, so the edit meets the same content.
 *
 * What an edit returns is an observation too: it can list references to the changed symbol in other files,
 * and a worker that saw a different list might have edited differently. So every step carries its result
 * hash, edits included. An edit that fails where it had succeeded is reported as not applicable.
 */
export function observationValidation(log: readonly ObservationEntry[]): ObservationValidation {
  const recorded = new Map<KernelObservationEntry, ObservationEntry>();
  for (const entry of log) {
    recorded.set({
      kind: entry.kind,
      call: { tool: entry.tool, args: entry.args },
      resultHash: entry.resultHash,
    }, entry);
  }
  const toolsByRoot = new Map<string, Promise<readonly ToolDefinition[]>>();
  const toolsFor = (root: string) => {
    let tools = toolsByRoot.get(root);
    if (!tools) {
      tools = WorkspacePathPolicy.create({ workspaceRoot: root, cwd: root })
        .then((pathPolicy) => createBuiltinTools({ cwd: root, workspaceRoot: root, pathPolicy, contextId: "parallel-replay", grepOutline: false }));
      toolsByRoot.set(root, tools);
    }
    return tools;
  };
  let step = 0;
  return {
    log: [...recorded.keys()],
    closedWorld: true,
    async replay(entry, root) {
      const original = recorded.get(entry);
      const tool = (await toolsFor(root)).find((candidate) => candidate.name === entry.call.tool);
      if (!original || !tool) throw new Error(`replay: no recorded ${entry.call.tool} call to re-run`);
      const result = await tool.execute(`replay-${++step}`, withRoot(entry.call.args, root) as Record<string, unknown>);
      if (entry.kind === "mutate" && result.isError === true && !original.isError) {
        throw new Error(`replay: ${entry.call.tool} no longer applies: ${resultText(result)}`);
      }
      return hashObservation(entry.call.tool, resultText(result), root);
    },
  };
}
