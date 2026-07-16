/**
 * Canonical transcript projection for append-to-scrollback (route B) and tests.
 *
 * Finalized blocks are immutable and safe for Ink `<Static>` (preview lines only).
 * Full tool output is retained on each block for the Ctrl+O transcript viewer.
 * In-flight tools are keyed by callId so parallel same-name calls pair correctly.
 */

import {
  TOOL_OUTPUT_PREVIEW_LINES,
  formatExploreToolLabel,
  formatToolOutputForDisplay,
  isExploreToolName,
  previewText,
} from "../runtime/session-ui.ts";
import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import { renderMarkdownLines } from "./markdown.ts";
import { theme, truncateToolDetail } from "./theme.ts";

import type { TuiEvent } from "./session-bridge.ts";

export type HistoryBlock = Readonly<{
  id: number;
  /** Preview lines rendered into the main buffer via `<Static>`. */
  lines: readonly string[];
  kind: "user" | "assistant" | "tool" | "notice" | "thinking" | "command" | "subagent";
  error?: boolean;
  /** Full tool output retained for the transcript viewer (not only the 8-line preview). */
  output?: string;
  title?: string;
  detail?: string;
  callId?: string;
  /** When true, Static shows the truncated preview; viewer can still open full output. */
  previewCollapsed?: boolean;
  thoughtSeconds?: number;
  workerId?: number;
  model?: string;
}>;

/**
 * Chunked live text: appends push in place (exclusive ownership of `chunks`).
 * Compacts when the chunk list grows so paint/commit joins stay amortized linear.
 * Sticky preview reads the tail only (no full join per frame).
 */
export type LiveTextBuffer = Readonly<{
  chunks: readonly string[];
  length: number;
}>;

/** Compact many small deltas into one chunk to keep later joins O(n) amortized. */
export const LIVE_TEXT_COMPACT_CHUNKS = 48;

export function emptyLiveText(): LiveTextBuffer {
  return { chunks: [], length: 0 };
}

export function appendLiveText(buffer: LiveTextBuffer, delta: string): LiveTextBuffer {
  if (delta.length === 0) return buffer;
  // Exclusive ownership: reduceScrollback never shares a buffer across live identities.
  const chunks = buffer.chunks as string[];
  chunks.push(delta);
  const length = buffer.length + delta.length;
  if (chunks.length >= LIVE_TEXT_COMPACT_CHUNKS) {
    const joined = chunks.join("");
    return { chunks: [joined], length: joined.length };
  }
  return { chunks, length };
}

export function liveTextString(buffer: LiveTextBuffer): string {
  if (buffer.chunks.length === 0) return "";
  if (buffer.chunks.length === 1) return buffer.chunks[0]!;
  return buffer.chunks.join("");
}

/**
 * Tail of the live buffer up to `budget` characters without joining the whole stream.
 * O(chunks from end) until budget is filled — paint path must not call liveTextString.
 */
export function liveTextTail(buffer: LiveTextBuffer, budget: number): string {
  if (buffer.length === 0 || budget <= 0) return "";
  if (buffer.length <= budget) {
    return liveTextString(buffer);
  }
  let remaining = budget;
  const parts: string[] = [];
  for (let i = buffer.chunks.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const chunk = buffer.chunks[i]!;
    if (chunk.length <= remaining) {
      parts.push(chunk);
      remaining -= chunk.length;
    } else {
      parts.push(chunk.slice(chunk.length - remaining));
      remaining = 0;
    }
  }
  parts.reverse();
  return parts.join("");
}

export function liveTextFromString(text: string): LiveTextBuffer {
  if (text.length === 0) return emptyLiveText();
  return { chunks: [text], length: text.length };
}

/** Streaming thinking or assistant text (at most one active stream). */
export type LiveBlock = Readonly<{
  kind: "thinking" | "assistant";
  /** Chunked stream body (preferred). */
  buffer: LiveTextBuffer;
  startedAt?: number;
}>;

/** Max characters of live stream shown in the sticky region (full buffer retained). */
export const LIVE_PREVIEW_CHAR_BUDGET = 4_000;

/** One in-flight tool call keyed by provider callId (or a synthetic id). */
export type InFlightTool = Readonly<{
  callId: string;
  name: string;
  detail: string;
  startedAt?: number;
}>;

/** One in-flight explore subagent worker (nested loop UI). */
export type InFlightSubagent = Readonly<{
  workerId: number;
  model: string;
  role?: string;
  goal: string;
  live?: LiveBlock;
  inFlightTools: readonly InFlightTool[];
  /** Inner lines committed during flight (tools, collapsed thinking). */
  lines: readonly string[];
  startedAt: number;
}>;

export type ScrollbackState = Readonly<{
  blocks: readonly HistoryBlock[];
  /** Active thinking/assistant stream; tools live in `inFlightTools`. */
  live: LiveBlock | undefined;
  inFlightTools: readonly InFlightTool[];
  inFlightSubagents: readonly InFlightSubagent[];
  nextId: number;
  /** Monotonic synthetic id counter when the provider omits callId. */
  nextSyntheticId: number;
  /** Synthetic id counter for nested subagent tools. */
  nextSubagentSyntheticId: number;
}>;

export function emptyScrollbackState(): ScrollbackState {
  return {
    blocks: [],
    live: undefined,
    inFlightTools: [],
    inFlightSubagents: [],
    nextId: 1,
    nextSyntheticId: 1,
    nextSubagentSyntheticId: 1,
  };
}

export function commitLive(state: ScrollbackState): ScrollbackState {
  if (!state.live) return state;
  const block = liveStreamToBlock(state.live, state.nextId);
  return {
    ...state,
    blocks: [...state.blocks, block],
    live: undefined,
    nextId: state.nextId + 1,
  };
}

/**
 * Finalized assistant text: markdown-rendered once at commit time (never in
 * the delta hot path). First line carries the answer mark; continuation lines
 * are separate entries so Ink wraps each source line independently.
 */
function assistantBlockLines(text: string): readonly string[] {
  const rendered = renderMarkdownLines(text);
  if (rendered.length === 0) return [`${theme.sym.answer} ${text}`];
  return [`${theme.sym.answer} ${rendered[0]!}`, ...rendered.slice(1)];
}

export function reduceScrollback(state: ScrollbackState, event: TuiEvent): ScrollbackState {
  if (event.kind === "thinking-delta") {
    let next = state;
    if (next.live && next.live.kind !== "thinking") {
      next = commitLive(next);
    }
    if (!next.live || next.live.kind !== "thinking") {
      return {
        ...next,
        live: { kind: "thinking", buffer: liveTextFromString(event.text), startedAt: Date.now() },
      };
    }
    return {
      ...next,
      live: { ...next.live, buffer: appendLiveText(next.live.buffer, event.text) },
    };
  }

  if (event.kind === "assistant-delta") {
    let next = state;
    if (next.live && next.live.kind === "thinking") {
      next = commitLive(collapseThinking(next));
    }
    if (!next.live || next.live.kind !== "assistant") {
      return {
        ...next,
        live: { kind: "assistant", buffer: liveTextFromString(event.text) },
      };
    }
    return {
      ...next,
      live: { ...next.live, buffer: appendLiveText(next.live.buffer, event.text) },
    };
  }

  if (event.kind === "assistant-text") {
    let next = state;
    if (next.live?.kind === "thinking") {
      next = commitLive(collapseThinking(next));
    }
    // Idempotent: if we already streamed the answer, commit stream and ignore full final.
    if (next.live?.kind === "assistant") {
      return commitLive(next);
    }
    if (event.text.length > 0) {
      return {
        ...next,
        blocks: [...next.blocks, {
          id: next.nextId,
          kind: "assistant",
          lines: assistantBlockLines(event.text),
        }],
        live: undefined,
        nextId: next.nextId + 1,
      };
    }
    return { ...next, live: undefined };
  }

  if (event.kind === "tool-start") {
    let next = state;
    if (next.live?.kind === "thinking") {
      next = commitLive(collapseThinking(next));
    } else if (next.live) {
      next = commitLive(next);
    }
    let callId = event.callId?.trim() ?? "";
    let nextSyntheticId = next.nextSyntheticId;
    if (callId.length === 0) {
      callId = `synthetic-${nextSyntheticId}`;
      nextSyntheticId += 1;
    }
    // Do not replace other in-flight tools — parallel starts stack.
    return {
      ...next,
      live: undefined,
      nextSyntheticId,
      inFlightTools: [
        ...next.inFlightTools,
        {
          callId,
          name: event.name,
          detail: event.detail,
          startedAt: Date.now(),
        },
      ],
    };
  }

  if (event.kind === "tool-end") {
    let next = state;
    if (next.live?.kind === "thinking") {
      next = commitLive(collapseThinking(next));
    }
    const match = matchInFlightTool(next.inFlightTools, event);
    const remaining = match
      ? next.inFlightTools.filter((tool) => tool.callId !== match.callId)
      : next.inFlightTools;
    const titleName = match?.name ?? event.name;
    const detail = match?.detail ?? "";
    const callId = match?.callId ?? event.callId;
    const block = buildToolHistoryBlock({
      id: next.nextId,
      name: titleName,
      detail,
      callId,
      error: event.error,
      output: event.output,
    });
    return {
      ...next,
      blocks: [...next.blocks, block],
      inFlightTools: remaining,
      live: undefined,
      nextId: next.nextId + 1,
    };
  }

  if (event.kind === "notice") {
    let next = commitLive(state.live?.kind === "thinking" ? collapseThinking(state) : state);
    next = commitLive(next);
    return {
      ...next,
      blocks: [...next.blocks, {
        id: next.nextId,
        kind: "notice",
        lines: [`${event.level === "error" ? "!" : theme.sym.meta} ${event.text}`],
        error: event.level === "error",
      }],
      live: undefined,
      nextId: next.nextId + 1,
    };
  }

  if (event.kind === "context-compaction") {
    const e = event.event;
    let text: string | undefined;
    if (e.stage === "start") text = "Context compacting…";
    else if (e.stage === "success") text = `Context compacted: ${e.before} -> ${e.after} messages.`;
    else if (e.stage === "skip") text = "Context is already compact.";
    else if (e.stage === "failure") text = `Context compaction failed: ${e.error}`;
    if (!text) return state;
    return reduceScrollback(state, {
      kind: "notice",
      text,
      level: e.stage === "failure" ? "error" : undefined,
    });
  }

  if (event.kind === "subagent-start") {
    return {
      ...state,
      inFlightSubagents: [
        ...state.inFlightSubagents,
        {
          workerId: event.workerId,
          model: event.model,
          role: event.role,
          goal: event.goal,
          inFlightTools: [],
          lines: [],
          startedAt: Date.now(),
        },
      ],
    };
  }

  if (event.kind === "subagent-thinking-delta") {
    const workers = updateInFlightSubagent(state.inFlightSubagents, event.workerId, (worker) => {
      let live = worker.live;
      if (live && live.kind !== "thinking") {
        live = undefined;
      }
      if (!live || live.kind !== "thinking") {
        return {
          ...worker,
          live: { kind: "thinking", buffer: liveTextFromString(event.text), startedAt: Date.now() },
        };
      }
      return {
        ...worker,
        live: { ...live, buffer: appendLiveText(live.buffer, event.text) },
      };
    });
    return workers === state.inFlightSubagents ? state : { ...state, inFlightSubagents: workers };
  }

  if (event.kind === "subagent-assistant-delta") {
    const workers = updateInFlightSubagent(state.inFlightSubagents, event.workerId, (worker) => {
      let next = worker;
      if (next.live?.kind === "thinking") {
        next = commitSubagentThinking(next);
      }
      if (!next.live || next.live.kind !== "assistant") {
        return {
          ...next,
          live: { kind: "assistant", buffer: liveTextFromString(event.text) },
        };
      }
      return {
        ...next,
        live: { ...next.live, buffer: appendLiveText(next.live.buffer, event.text) },
      };
    });
    return workers === state.inFlightSubagents ? state : { ...state, inFlightSubagents: workers };
  }

  if (event.kind === "subagent-assistant-text") {
    const workers = updateInFlightSubagent(state.inFlightSubagents, event.workerId, (worker) => {
      let next = worker;
      if (next.live?.kind === "thinking") {
        next = commitSubagentThinking(next);
      }
      if (next.live?.kind === "assistant") {
        return { ...next, live: undefined };
      }
      if (event.text.length === 0) {
        return { ...next, live: undefined };
      }
      return {
        ...next,
        live: undefined,
        lines: [...next.lines, formatSubagentAssistantLine(event.text)],
      };
    });
    return workers === state.inFlightSubagents ? state : { ...state, inFlightSubagents: workers };
  }

  if (event.kind === "subagent-tool-start") {
    let nextSyntheticId = state.nextSubagentSyntheticId;
    const workers = updateInFlightSubagent(state.inFlightSubagents, event.workerId, (worker) => {
      let next = worker;
      if (next.live?.kind === "thinking") {
        next = commitSubagentThinking(next);
      } else if (next.live?.kind === "assistant") {
        next = commitSubagentAssistant(next);
      }
      let callId = event.callId?.trim() ?? "";
      if (callId.length === 0) {
        callId = `sub-synthetic-${nextSyntheticId}`;
        nextSyntheticId += 1;
      }
      return {
        ...next,
        live: undefined,
        inFlightTools: [
          ...next.inFlightTools,
          {
            callId,
            name: event.name,
            detail: event.detail,
            startedAt: Date.now(),
          },
        ],
      };
    });
    if (workers === state.inFlightSubagents) return state;
    return { ...state, inFlightSubagents: workers, nextSubagentSyntheticId: nextSyntheticId };
  }

  if (event.kind === "subagent-tool-end") {
    const workers = updateInFlightSubagent(state.inFlightSubagents, event.workerId, (worker) => {
      const match = matchInFlightTool(worker.inFlightTools, event);
      const remaining = match
        ? worker.inFlightTools.filter((tool) => tool.callId !== match.callId)
        : worker.inFlightTools;
      const titleName = match?.name ?? event.name;
      const detail = match?.detail ?? "";
      const toolLines = buildSubagentInnerToolLines({
        name: titleName,
        detail,
        error: event.error,
        output: event.output,
      });
      return {
        ...worker,
        inFlightTools: remaining,
        lines: [...worker.lines, ...toolLines],
      };
    });
    return workers === state.inFlightSubagents ? state : { ...state, inFlightSubagents: workers };
  }

  if (event.kind === "subagent-end") {
    const worker = state.inFlightSubagents.find((entry) => entry.workerId === event.workerId);
    if (!worker) return state;
    let finalized = worker;
    if (finalized.live?.kind === "thinking") {
      finalized = commitSubagentThinking(finalized);
    } else if (finalized.live?.kind === "assistant") {
      finalized = commitSubagentAssistant(finalized);
    }
    const block = buildSubagentHistoryBlock({
      id: state.nextId,
      worker: finalized,
      success: event.success,
      status: event.status,
    });
    return {
      ...state,
      blocks: [...state.blocks, block],
      inFlightSubagents: state.inFlightSubagents.filter((entry) => entry.workerId !== event.workerId),
      nextId: state.nextId + 1,
    };
  }

  return state;
}

/**
 * Pair tool-end with an in-flight start.
 * Prefer exact callId; name-based fallback only when exactly one unambiguous match.
 */
export function matchInFlightTool(
  tools: readonly InFlightTool[],
  event: Readonly<{ name: string; callId?: string }>,
): InFlightTool | undefined {
  if (event.callId) {
    const byId = tools.find((tool) => tool.callId === event.callId);
    if (byId) return byId;
  }
  const sameName = tools.filter((tool) => tool.name === event.name);
  if (sameName.length === 1) return sameName[0];
  // No callId and multiple same-name tools: take the oldest unfinished of that name.
  if (!event.callId && sameName.length > 1) return sameName[0];
  // Mismatched/missing id with no same-name open tool: leave unmatched (orphan end).
  return undefined;
}

export function buildToolHistoryBlock(input: Readonly<{
  id: number;
  name: string;
  detail: string;
  callId?: string;
  error: boolean;
  output: string;
}>): HistoryBlock {
  const explore = isExploreToolName(input.name);
  const status = input.error ? "failed" : "done";
  const title = explore ? formatExploreToolLabel({ status }) : input.name;
  const mark = explore ? theme.sym.explore : theme.sym.tool;
  const detailPart = input.detail.trim().length > 0 ? ` ${truncateToolDetail(input.detail)}` : "";
  const statusPart = explore ? "" : ` ${status}`;
  const lines: string[] = [`${mark} ${title}${detailPart}${statusPart}`];
  const display = formatToolOutputForDisplay(input.output) || input.output;
  const lineCount = display.length === 0 ? 0 : display.split("\n").length;
  const previewCollapsed = lineCount > TOOL_OUTPUT_PREVIEW_LINES;
  if (display.length > 0) {
    const preview = previewText(display, TOOL_OUTPUT_PREVIEW_LINES);
    for (const row of preview.text.split("\n")) {
      lines.push(`  ${theme.sym.nest} ${row}`);
    }
    if (preview.truncated) {
      lines.push(`  ${theme.sym.nest} … (truncated · Ctrl+O full output)`);
    }
  } else {
    lines.push(`  ${theme.sym.nest} (empty)`);
  }
  return {
    id: input.id,
    kind: "tool",
    lines,
    error: input.error,
    output: display,
    title: input.name,
    detail: input.detail,
    callId: input.callId,
    previewCollapsed,
  };
}

export function appendUserBlock(state: ScrollbackState, text: string): ScrollbackState {
  let next = commitLive(state.live?.kind === "thinking" ? collapseThinking(state) : state);
  next = commitLive(next);
  return {
    ...next,
    blocks: [...next.blocks, {
      id: next.nextId,
      kind: "user",
      lines: [`${theme.sym.prompt} ${text}`],
    }],
    live: undefined,
    nextId: next.nextId + 1,
  };
}

export function blocksFromRestoredMessages(
  messages: ReadonlyArray<Readonly<{ role: string; content?: string; name?: string }>>,
): ScrollbackState {
  let state = emptyScrollbackState();
  for (const message of messages) {
    if (message.role === "system") {
      if (message.name === CONTEXT_SUMMARY_NAME) {
        state = reduceScrollback(state, {
          kind: "notice",
          text: "Earlier context was compacted.",
        });
        continue;
      }
      if (message.name === SESSION_RECOVERY_NAME && typeof message.content === "string") {
        state = reduceScrollback(state, {
          kind: "notice",
          text: message.content,
          level: "warning",
        });
        continue;
      }
      continue;
    }
    if (message.role === "user" && typeof message.content === "string" && message.content.length > 0) {
      state = appendUserBlock(state, message.content);
    } else if (message.role === "assistant" && typeof message.content === "string" && message.content.length > 0) {
      state = {
        ...state,
        blocks: [...state.blocks, {
          id: state.nextId,
          kind: "assistant",
          lines: assistantBlockLines(message.content),
        }],
        live: undefined,
        nextId: state.nextId + 1,
      };
    }
  }
  return state;
}

/**
 * Toggle expand metadata on the latest long tool / thinking block.
 * Does not mutate Static history lines; the overlay viewer reads retained fields.
 */
export function toggleLatestScrollbackExpandable(state: ScrollbackState): ScrollbackState {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index]!;
    if (block.kind === "thinking" && (block.thoughtSeconds !== undefined || block.lines.length > 0)) {
      // Thinking is already collapsed to a duration label in route B; nothing to expand in Static.
      continue;
    }
    if (block.kind === "tool" && (block.output?.length ?? 0) > 0) {
      const lineCount = block.output!.split("\n").length;
      if (lineCount <= TOOL_OUTPUT_PREVIEW_LINES) continue;
      const next = [...state.blocks];
      next[index] = { ...block, previewCollapsed: !block.previewCollapsed };
      return { ...state, blocks: next };
    }
  }
  return state;
}

/** Latest tool block with retained full output longer than the preview window. */
export function latestExpandableToolBlock(state: ScrollbackState): HistoryBlock | undefined {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index]!;
    if (block.kind !== "tool" || !block.output) continue;
    if (block.output.split("\n").length > TOOL_OUTPUT_PREVIEW_LINES) return block;
  }
  return undefined;
}

function collapseThinking(state: ScrollbackState): ScrollbackState {
  if (!state.live || state.live.kind !== "thinking") return state;
  const startedAt = state.live.startedAt ?? Date.now();
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  return {
    ...state,
    live: {
      ...state.live,
      buffer: liveTextFromString(`${theme.sym.think} think ${seconds}s`),
    },
  };
}

function liveStreamToBlock(live: LiveBlock, id: number): HistoryBlock {
  if (live.kind === "thinking") {
    const text = liveTextString(live.buffer);
    const line = text.startsWith(theme.sym.think) ? text : `${theme.sym.think} think`;
    const secondsMatch = /think (\d+)s/.exec(line);
    return {
      id,
      kind: "thinking",
      lines: [line],
      thoughtSeconds: secondsMatch ? Number(secondsMatch[1]) : undefined,
    };
  }
  return { id, kind: "assistant", lines: assistantBlockLines(liveTextString(live.buffer)) };
}

/** Format live stream + in-flight tools + subagent workers for the sticky region. */
export function formatLiveLines(
  live: LiveBlock | undefined,
  inFlightTools: readonly InFlightTool[] = [],
  inFlightSubagents: readonly InFlightSubagent[] = [],
  options: Readonly<{ charBudget?: number }> = {},
): readonly string[] {
  const budget = options.charBudget ?? LIVE_PREVIEW_CHAR_BUDGET;
  const lines: string[] = [];
  if (live?.kind === "thinking") {
    const preview = boundLivePreviewFromBuffer(live.buffer, budget);
    lines.push(`${theme.sym.think} thinking…`, ...indentLines(preview, "  "));
  } else if (live?.kind === "assistant") {
    const preview = boundLivePreviewFromBuffer(live.buffer, budget);
    lines.push(`${theme.sym.answer} ${preview}`);
  }
  for (const tool of inFlightTools) {
    const detail = tool.detail.trim().length > 0 ? ` ${truncateToolDetail(tool.detail)}` : "";
    const explore = isExploreToolName(tool.name);
    const mark = explore ? theme.sym.explore : theme.sym.tool;
    const title = explore ? formatExploreToolLabel({ running: true }) : tool.name;
    lines.push(`${mark} ${title}${detail}`);
  }
  for (const worker of inFlightSubagents) {
    lines.push(...formatInFlightSubagentLines(worker, budget));
  }
  return lines;
}

/** Keep the tail of a long live stream for sticky display; full buffer is retained separately. */
export function boundLivePreview(text: string, charBudget: number): string {
  if (text.length <= charBudget) return text;
  return `…${text.slice(text.length - charBudget)}`;
}

/** Preview from chunked buffer without a full-stream join. */
export function boundLivePreviewFromBuffer(buffer: LiveTextBuffer, charBudget: number): string {
  if (buffer.length <= charBudget) {
    return liveTextString(buffer);
  }
  return `…${liveTextTail(buffer, charBudget)}`;
}

function indentLines(text: string, prefix: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n").map((row) => `${prefix}${row}`);
}

function updateInFlightSubagent(
  workers: readonly InFlightSubagent[],
  workerId: number,
  update: (worker: InFlightSubagent) => InFlightSubagent,
): readonly InFlightSubagent[] {
  const index = workers.findIndex((entry) => entry.workerId === workerId);
  if (index < 0) return workers;
  const next = [...workers];
  next[index] = update(workers[index]!);
  return next;
}

function commitSubagentThinking(worker: InFlightSubagent): InFlightSubagent {
  if (!worker.live || worker.live.kind !== "thinking") return worker;
  const startedAt = worker.live.startedAt ?? worker.startedAt;
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  return {
    ...worker,
    live: undefined,
    lines: [...worker.lines, `  ${theme.sym.explore} think ${seconds}s`],
  };
}

function commitSubagentAssistant(worker: InFlightSubagent): InFlightSubagent {
  if (!worker.live || worker.live.kind !== "assistant") return worker;
  const text = liveTextString(worker.live.buffer);
  if (text.length === 0) {
    return { ...worker, live: undefined };
  }
  return {
    ...worker,
    live: undefined,
    lines: [...worker.lines, formatSubagentAssistantLine(text)],
  };
}

function formatSubagentAssistantLine(text: string): string {
  const preview = boundLivePreview(text.trim(), LIVE_PREVIEW_CHAR_BUDGET);
  return `  ${theme.sym.explore} ${preview}`;
}

function formatInFlightSubagentLines(
  worker: InFlightSubagent,
  charBudget: number,
): string[] {
  const role = worker.role ? ` [${worker.role}]` : "";
  const goal = worker.goal.trim().length > 0 ? ` ${truncateToolDetail(worker.goal)}` : "";
  const lines = [`${theme.sym.explore} subagent #${worker.workerId} · ${worker.model}${role}${goal}`];
  lines.push(...worker.lines);
  if (worker.live?.kind === "thinking") {
    const preview = boundLivePreviewFromBuffer(worker.live.buffer, charBudget);
    lines.push(`  ${theme.sym.explore} thinking…`, ...indentLines(preview, "    "));
  } else if (worker.live?.kind === "assistant") {
    const preview = boundLivePreviewFromBuffer(worker.live.buffer, charBudget);
    lines.push(`  ${theme.sym.explore} ${preview}`);
  }
  for (const tool of worker.inFlightTools) {
    const detail = tool.detail.trim().length > 0 ? ` ${truncateToolDetail(tool.detail)}` : "";
    lines.push(`  ${theme.sym.explore} ${tool.name}${detail}`);
  }
  return lines;
}

function buildSubagentInnerToolLines(input: Readonly<{
  name: string;
  detail: string;
  error: boolean;
  output: string;
}>): string[] {
  const detailPart = input.detail.trim().length > 0 ? ` ${truncateToolDetail(input.detail)}` : "";
  const status = input.error ? "failed" : "done";
  const lines: string[] = [`  ${theme.sym.explore} ${input.name}${detailPart} ${status}`];
  const display = formatToolOutputForDisplay(input.output) || input.output;
  if (display.length > 0) {
    const preview = previewText(display, TOOL_OUTPUT_PREVIEW_LINES);
    for (const row of preview.text.split("\n")) {
      lines.push(`    ${theme.sym.nest} ${row}`);
    }
    if (preview.truncated) {
      lines.push(`    ${theme.sym.nest} … (truncated · Ctrl+O full output)`);
    }
  }
  return lines;
}

function buildSubagentHistoryBlock(input: Readonly<{
  id: number;
  worker: InFlightSubagent;
  success: boolean;
  status?: string;
}>): HistoryBlock {
  const { worker } = input;
  const role = worker.role ? ` [${worker.role}]` : "";
  const goal = worker.goal.trim().length > 0 ? ` ${truncateToolDetail(worker.goal)}` : "";
  const statusLabel = input.status ?? (input.success ? "done" : "failed");
  const header = `${theme.sym.explore} subagent #${worker.workerId} · ${worker.model}${role}${goal} (${statusLabel})`;
  const lines = [header, ...worker.lines];
  return {
    id: input.id,
    kind: "subagent",
    lines,
    error: !input.success,
    workerId: worker.workerId,
    model: worker.model,
    detail: worker.goal,
  };
}

function isExploreHistoryBlock(block: HistoryBlock): boolean {
  if (block.kind === "subagent") return true;
  if (block.kind === "tool" && isExploreToolName(block.title)) return true;
  return block.lines.some((line) => line.includes(theme.sym.explore));
}

export { isExploreHistoryBlock };
