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
  /** Semantic cutoff hash (comments/line-numbers stripped for read; blast-radius line numbers stripped for edit/write). */
  cutoffHash?: string;
  /** Portable file paths discovered by `glob` or referenced in `edit`/`write` blast-radius alerts. */
  discoveryItems?: readonly string[];
  resultBytes: number;
  isError: boolean;
}>;

export type ObservationValidationOptions = Readonly<{
  /**
   * Enable Early Cutoff:
   * - `read`: cut off when comment-free, line-number-free code slice is unchanged
   * - `glob` / `grep`: cut off when current discovery set is a pure additive superset of recorded items
   * - `edit` / `write`: cut off when target edit succeeded and only blast-radius line numbers or additive files changed
   */
  earlyCutoff?: boolean;
  /** Optional symbols of interest for `read` slice projection. */
  symbols?: readonly string[];
  /** Invoked when a discovery (`glob`) or blast-radius step cuts off on newly added files. */
  onDiscoveryDelta?: (addedPaths: readonly string[]) => void;
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

function stripCommentsPreservingStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i++;
        if (c === "\\" && i < source.length) {
          out += source[i];
          i++;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Compute semantic cutoff hash for `read` (strips `1|` line-number prefixes, comments, and blank lines)
 * or `edit`/`write` (keeps the primary edit confirmation line + blast-radius references without `:lineNum`).
 */
export function computeCutoffHash(tool: string, text: string, root: string, symbols?: readonly string[]): string | undefined {
  const portable = withoutRoot(text, root);
  if (tool === "read") {
    const unnumbered = portable
      .split("\n")
      .filter((line) => !line.startsWith("[file has "))
      .map((line) => line.replace(/^\s*\d+\|/, ""))
      .join("\n");
    const uncommented = stripCommentsPreservingStrings(unnumbered)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!symbols || symbols.length === 0) {
      return createHash("sha256").update(uncommented.join("\n")).digest("hex").slice(0, 16);
    }
    const patterns = symbols.map((sym) => new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    const slice = uncommented.filter((line) => patterns.some((re) => re.test(line)));
    return createHash("sha256").update(slice.join("\n")).digest("hex").slice(0, 16);
  }
  if (MUTATE.has(tool)) {
    // Primary confirmation line (before [Blast Radius Alert]) must match on target path & fuzzy status.
    const primaryLine = portable.split("\n")[0]?.replace(/;\s*write-back ok sha256=[0-9a-f]+/, "; write-back ok") ?? "";
    return createHash("sha256").update(primaryLine).digest("hex").slice(0, 16);
  }
  return undefined;
}

export function extractDiscoveryItems(tool: string, text: string, root: string): readonly string[] | undefined {
  const portable = withoutRoot(text, root);
  if (tool === "glob") {
    return portable
      .split("\n")
      .map((line) => line.replace(/^<root>\/?/, "").replace(/^\.\//, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("[") && line !== "(no matches)")
      .sort();
  }
  if (MUTATE.has(tool)) {
    const refs: string[] = [];
    for (const line of portable.split("\n")) {
      const match = /^\s*-\s+([^:]+):\d+\s+\(/.exec(line);
      if (match?.[1]) refs.push(match[1].replace(/^<root>\/?/, "").trim());
    }
    return [...new Set(refs)].sort();
  }
  return undefined;
}

/** One log entry for a finished tool call; undefined for tools that are neither an observation nor an edit. */
export function toObservationEntry(call: ChatToolCall, result: ToolExecuteResult, root: string): ObservationEntry | undefined {
  const kind = OBSERVE.has(call.name) ? "observe" : MUTATE.has(call.name) ? "mutate" : undefined;
  if (!kind) return undefined;
  const text = resultText(result);
  const cutoffHash = computeCutoffHash(call.name, text, root);
  const discoveryItems = extractDiscoveryItems(call.name, text, root);
  return {
    kind,
    tool: call.name,
    args: normaliseArgs(call.arguments, root) as Record<string, unknown>,
    resultHash: hashObservation(call.name, text, root),
    ...(cutoffHash ? { cutoffHash } : {}),
    ...(discoveryItems ? { discoveryItems } : {}),
    resultBytes: Buffer.byteLength(text),
    isError: result.isError === true,
  };
}

/**
 * Hands a worker's log to the kernel together with the way to re-run one step in another directory.
 *
 * When `options.earlyCutoff` is false/omitted, every observation and edit blast-radius note must match
 * byte-for-byte on its normalized hash. When `options.earlyCutoff` is true, comment/line-number shifts
 * on `read` and pure additive file discovery on `glob` / `edit` blast-radius alerts are cut off and
 * reported via `options.onDiscoveryDelta`.
 */
export function observationValidation(
  log: readonly ObservationEntry[],
  options?: ObservationValidationOptions,
): ObservationValidation {
  const recorded = new Map<KernelObservationEntry, ObservationEntry>();
  for (const entry of log) {
    const kernelEntry: KernelObservationEntry & { cutoffHash?: string } = {
      kind: entry.kind,
      call: { tool: entry.tool, args: entry.args },
      resultHash: entry.resultHash,
      ...(options?.earlyCutoff && entry.cutoffHash ? { cutoffHash: entry.cutoffHash } : {}),
    };
    recorded.set(kernelEntry, entry);
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
  const lastReplayText = new Map<KernelObservationEntry, string>();
  let step = 0;
  const validation: ObservationValidation & {
    canCutoff?: (
      entry: KernelObservationEntry,
      replayed: { resultHash?: string; cutoffHash?: string; index: number },
      root: string,
    ) => boolean;
  } = {
    log: [...recorded.keys()],
    closedWorld: true,
    async replay(entry, root) {
      const original = recorded.get(entry);
      const tool = (await toolsFor(root)).find((candidate) => candidate.name === entry.call.tool);
      if (!original || !tool) throw new Error(`replay: no recorded ${entry.call.tool} call to re-run`);
      const result = await tool.execute(`replay-${++step}`, withRoot(entry.call.args, root) as Record<string, unknown>);
      const text = resultText(result);
      if (entry.kind === "mutate" && result.isError === true && !original.isError) {
        throw new Error(`replay: ${entry.call.tool} no longer applies: ${text}`);
      }
      lastReplayText.set(entry, text);
      return hashObservation(entry.call.tool, text, root);
    },
    ...(options?.earlyCutoff
      ? {
          canCutoff(entry: KernelObservationEntry, _replayed: { resultHash?: string; cutoffHash?: string; index: number }, root: string): boolean {
            const original = recorded.get(entry);
            const text = lastReplayText.get(entry);
            if (!original || text === undefined) return false;

            if (entry.call.tool === "read") {
              const currentCutoff = computeCutoffHash("read", text, root, options.symbols);
              const expectedCutoff = options.symbols?.length ? undefined : original.cutoffHash;
              return expectedCutoff !== undefined && currentCutoff === expectedCutoff;
            }

            if (entry.call.tool === "glob" && original.discoveryItems) {
              const currentItems = extractDiscoveryItems("glob", text, root) ?? [];
              const currentSet = new Set(currentItems);
              const isSuperset = original.discoveryItems.every((item) => currentSet.has(item));
              if (isSuperset) {
                const recordedSet = new Set(original.discoveryItems);
                const added = currentItems.filter((item) => !recordedSet.has(item));
                if (added.length > 0) options.onDiscoveryDelta?.(added);
                return true;
              }
              return false;
            }

            if (MUTATE.has(entry.call.tool)) {
              const currentCutoff = computeCutoffHash(entry.call.tool, text, root);
              if (!original.cutoffHash || currentCutoff !== original.cutoffHash) return false;
              const currentRefs = extractDiscoveryItems(entry.call.tool, text, root) ?? [];
              const recordedRefs = new Set(original.discoveryItems ?? []);
              const added = currentRefs.filter((item) => !recordedRefs.has(item));
              if (added.length > 0) options.onDiscoveryDelta?.(added);
              return true;
            }

            return false;
          },
        }
      : {}),
  };
  return validation;
}
