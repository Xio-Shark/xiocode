/**
 * Canonical transcript projection for fullscreen windowing, optional Static, and tests.
 *
 * Finalized blocks are immutable and safe for either Ink `<Static>` or windowed history.
 * Full thinking/tool/subagent output is retained for the Ctrl+O transcript viewer.
 * In-flight tools are keyed by callId so parallel same-name calls pair correctly.
 */

import {
  exploreReportBody,
  exploreReportStatus,
  formatExploreToolLabel,
  formatToolExpandHint,
  formatToolOutputForDisplay,
  isExploreToolName,
} from "../runtime/session-ui.ts";
import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import { renderMarkdownLines } from "./markdown.ts";
import { STREAM_CURSOR } from "./motion.ts";
import { theme, truncateToolDetail } from "./theme.ts";

import type { TuiEvent } from "./session-bridge.ts";

export type HistoryBlock = Readonly<{
  id: number;
  /** Preview lines rendered into the main buffer via `<Static>`. */
  lines: readonly string[];
  kind: "user" | "assistant" | "tool" | "notice" | "thinking" | "command" | "subagent";
  error?: boolean;
  /** Full thinking / tool / subagent transcript retained for Ctrl+O. */
  output?: string;
  title?: string;
  detail?: string;
  callId?: string;
  /**
   * When true (default for thinking/tools/subagents with body), Static shows compact chrome only.
   * Full body is never written into immutable Static lines — open Ctrl+O.
   */
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
  /** Thinking is folded when committed, but its full buffer stays retained. */
  collapsed?: boolean;
  thoughtSeconds?: number;
}>;

/** Max characters of live stream shown in the sticky region (full buffer retained). */
export const LIVE_PREVIEW_CHAR_BUDGET = 4_000;

/** Max nested `└` preview rows under a finished tool header (full body stays in Ctrl+O). */
export const TOOL_PREVIEW_ROWS = 3;

/** Max tail rows of the live thinking stream echoed while the model is working. */
export const THINKING_LIVE_PREVIEW_ROWS = 2;

/** Char budget for the live thinking tail (avoids full-buffer joins per paint). */
const THINKING_LIVE_TAIL_CHARS = 600;

/** Non-empty body rows as nested tree lines (`  └ …`), truncated per row. */
function nestedPreviewLines(body: string, maxRows: number): string[] {
  if (body.length === 0 || maxRows <= 0) return [];
  const rows: string[] = [];
  for (const row of body.split("\n")) {
    if (row.trim().length === 0) continue;
    rows.push(`  ${theme.sym.nest} ${truncateToolDetail(row.trim(), 96)}`);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

/** ` · Ns` elapsed suffix for live rows; hidden under one second to avoid flicker. */
function elapsedSuffix(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return "";
  const seconds = Math.round((now - startedAt) / 1000);
  return seconds >= 1 ? ` ${theme.sym.meta} ${seconds}s` : "";
}

/** One in-flight tool call keyed by provider callId (or a synthetic id). */
export type InFlightTool = Readonly<{
  callId: string;
  name: string;
  detail: string;
  startedAt?: number;
}>;

export type SubagentActivity = Readonly<
  | { kind: "starting" }
  | { kind: "thinking"; startedAt: number }
  | { kind: "responding" }
  | { kind: "tool"; name: string; detail: string; startedAt: number }
  | { kind: "working" }
>;

/** One in-flight explore subagent worker (nested loop UI). */
export type InFlightSubagent = Readonly<{
  workerId: number;
  model: string;
  role?: string;
  /** Short purpose label chosen by the primary agent (falls back to role/goal). */
  name?: string;
  goal: string;
  live?: LiveBlock;
  inFlightTools: readonly InFlightTool[];
  /** Full nested transcript retained for the completed Ctrl+O viewer. */
  lines: readonly string[];
  startedAt: number;
  activity: SubagentActivity;
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
          name: event.name,
          goal: event.goal,
          inFlightTools: [],
          lines: [],
          startedAt: Date.now(),
          activity: { kind: "starting" },
        },
      ],
    };
  }

  if (event.kind === "subagent-thinking-delta") {
    const workers = updateInFlightSubagent(state.inFlightSubagents, event.workerId, (worker) => {
      let next = worker;
      if (next.live?.kind === "assistant") {
        next = commitSubagentAssistant(next);
      }
      const live = next.live;
      if (!live || live.kind !== "thinking") {
        const startedAt = Date.now();
        return {
          ...next,
          live: { kind: "thinking", buffer: liveTextFromString(event.text), startedAt },
          activity: { kind: "thinking", startedAt },
        };
      }
      return {
        ...next,
        live: { ...live, buffer: appendLiveText(live.buffer, event.text) },
        activity: { kind: "thinking", startedAt: live.startedAt ?? next.startedAt },
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
          activity: { kind: "responding" },
        };
      }
      return {
        ...next,
        live: { ...next.live, buffer: appendLiveText(next.live.buffer, event.text) },
        activity: { kind: "responding" },
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
        return { ...commitSubagentAssistant(next), activity: { kind: "responding" } };
      }
      if (event.text.length === 0) {
        return { ...next, live: undefined, activity: { kind: "responding" } };
      }
      return {
        ...next,
        live: undefined,
        lines: [...next.lines, ...formatSubagentAssistantLines(event.text)],
        activity: { kind: "responding" },
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
      const startedAt = Date.now();
      return {
        ...next,
        live: undefined,
        inFlightTools: [
          ...next.inFlightTools,
          {
            callId,
            name: event.name,
            detail: event.detail,
            startedAt,
          },
        ],
        activity: {
          kind: "tool",
          name: event.name,
          detail: event.detail,
          startedAt,
        },
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
      const nextRunning = remaining.at(-1);
      return {
        ...worker,
        inFlightTools: remaining,
        lines: [...worker.lines, ...toolLines],
        activity: nextRunning
          ? {
              kind: "tool",
              name: nextRunning.name,
              detail: nextRunning.detail,
              startedAt: nextRunning.startedAt ?? Date.now(),
            }
          : { kind: "working" },
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
    if (finalized.inFlightTools.length > 0) {
      finalized = {
        ...finalized,
        lines: [
          ...finalized.lines,
          ...finalized.inFlightTools.map((tool) => {
            const detail = tool.detail.trim().length > 0 ? ` ${truncateToolDetail(tool.detail)}` : "";
            return `  ${theme.sym.tool} ${tool.name}${detail} interrupted`;
          }),
        ],
        inFlightTools: [],
      };
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
  const display = formatToolOutputForDisplay(input.output) || input.output;
  const reportStatus = explore ? exploreReportStatus(display) : undefined;
  const exploreLabel = input.error
    ? "failed"
    : reportStatus && reportStatus !== "ok"
      ? reportStatus
      : "done";
  const title = explore ? `subagent ${exploreLabel}` : input.name;
  const mark = explore ? theme.sym.explore : theme.sym.tool;
  const detailPart = input.detail.trim().length > 0 ? ` ${truncateToolDetail(input.detail)}` : "";
  const statusPart = explore ? "" : (input.error ? " failed" : " done");
  const lineCount = display.length === 0 ? 0 : display.split("\n").length;
  const lines: string[] = [
    `${mark} ${title}${detailPart}${statusPart} ${theme.sym.meta} ${formatToolExpandHint(lineCount)}`,
  ];
  // Tree preview: a few nested `└` rows under the header. Explore keeps one factual
  // peek; full bodies stay in Ctrl+O so scrollback can reach session start.
  if (explore) {
    const peek = exploreReportBody(display)?.split("\n").find((row) => row.trim().length > 0);
    if (peek) {
      lines.push(`  ${theme.sym.nest} ${truncateToolDetail(peek.trim(), 96)}`);
    }
  } else {
    lines.push(...nestedPreviewLines(display, TOOL_PREVIEW_ROWS));
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
    previewCollapsed: true,
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

/** One flattened, styled transcript row for line-granular fullscreen windowing. */
export type RenderLine = Readonly<{
  blockId: number;
  kind: HistoryBlock["kind"];
  error: boolean;
  explore: boolean;
  /** True for the first source line of an assistant block (bold header). */
  boldFirst: boolean;
  /** Compact kinds (tool/thinking/subagent) truncate; others wrap. */
  compact: boolean;
  /** 0-based index of this line within its owning block. */
  indexInBlock: number;
  text: string;
}>;

/**
 * Flatten history blocks into styled render lines so the fullscreen window can
 * scroll **by line** (a block taller than the viewport is partially visible
 * instead of jumping/overflowing atomically — the old block-granular window
 * dropped tall blocks the moment the user scrolled).
 *
 * offset semantics match {@link sliceTranscriptWindow}: 0 = bottom (latest),
 * increasing offset scrolls upward, counted in lines.
 */
export function sliceTranscriptLineWindow(
  blocks: readonly HistoryBlock[],
  viewport: number,
  offset: number,
  folded?: ReadonlySet<number>,
): Readonly<{
  lines: readonly RenderLine[];
  offset: number;
  maxOffset: number;
  hiddenAbove: number;
  hiddenBelow: number;
  totalLines: number;
}> {
  const size = Math.max(1, Math.floor(viewport));
  const flat: RenderLine[] = [];
  for (const block of blocks) {
    const explore = isExploreHistoryBlock(block);
    const compact = block.kind === "tool"
      || block.kind === "thinking"
      || block.kind === "subagent";
    const boldable = block.kind === "assistant";
    // Folded compact blocks keep only their title row (the rest stays in
    // `output` for the Ctrl+O viewer); user/assistant blocks never fold.
    const isFolded = compact && folded?.has(block.id) === true;
    // Every block occupies at least one row so empty blocks stay addressable.
    const source = isFolded
      ? [block.lines[0] ?? block.title ?? ""]
      : block.lines.length > 0
        ? block.lines
        : [""];
    source.forEach((text, index) => {
      flat.push({
        blockId: block.id,
        kind: block.kind,
        error: block.error === true,
        explore,
        boldFirst: boldable && index === 0,
        compact,
        indexInBlock: index,
        text,
      });
    });
  }
  const totalLines = flat.length;
  const maxOffset = Math.max(0, totalLines - size);
  const clamped = Math.max(0, Math.min(Math.floor(offset), maxOffset));
  const endExclusive = totalLines - clamped;
  const start = Math.max(0, endExclusive - size);
  return {
    lines: flat.slice(start, endExclusive),
    offset: clamped,
    maxOffset,
    hiddenAbove: start,
    hiddenBelow: clamped,
    totalLines,
  };
}

/** Every folded block with retained full output, in transcript order. */
export function expandableHistoryBlocks(state: ScrollbackState): readonly HistoryBlock[] {
  return state.blocks.filter((block) =>
    (block.kind === "thinking" || block.kind === "tool" || block.kind === "subagent")
    && (block.output?.length ?? 0) > 0
  );
}

/** Latest thinking/tool/subagent block with retained full output for Ctrl+O. */
export function latestExpandableToolBlock(state: ScrollbackState): HistoryBlock | undefined {
  return expandableHistoryBlocks(state).at(-1);
}

/** Previous/next retained transcript block for the Ctrl+O viewer. */
export function adjacentExpandableHistoryBlock(
  state: ScrollbackState,
  currentId: number,
  delta: -1 | 1,
): HistoryBlock | undefined {
  const blocks = expandableHistoryBlocks(state);
  if (blocks.length === 0) return undefined;
  const index = blocks.findIndex((block) => block.id === currentId);
  if (index < 0) return delta < 0 ? blocks.at(-1) : blocks[0];
  const next = Math.max(0, Math.min(blocks.length - 1, index + delta));
  return blocks[next];
}

function collapseThinking(state: ScrollbackState): ScrollbackState {
  if (!state.live || state.live.kind !== "thinking") return state;
  const startedAt = state.live.startedAt ?? Date.now();
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  return {
    ...state,
    live: {
      ...state.live,
      collapsed: true,
      thoughtSeconds: seconds,
    },
  };
}

function liveStreamToBlock(live: LiveBlock, id: number): HistoryBlock {
  if (live.kind === "thinking") {
    const text = liveTextString(live.buffer);
    const startedAt = live.startedAt ?? Date.now();
    const seconds = live.thoughtSeconds
      ?? Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    return {
      id,
      kind: "thinking",
      lines: [
        `${theme.sym.think} Thought for ${seconds}s ${theme.sym.meta} ${formatToolExpandHint(lineCount)}`,
        ...nestedPreviewLines(text, 1),
      ],
      output: text,
      title: "thinking",
      detail: `${seconds}s`,
      previewCollapsed: true,
      thoughtSeconds: seconds,
    };
  }
  return { id, kind: "assistant", lines: assistantBlockLines(liveTextString(live.buffer)) };
}

/** Format live stream + in-flight tools + subagent workers for the sticky region. */
export function formatLiveLines(
  live: LiveBlock | undefined,
  inFlightTools: readonly InFlightTool[] = [],
  inFlightSubagents: readonly InFlightSubagent[] = [],
  options: Readonly<{ charBudget?: number; now?: number; spinnerFrame?: string }> = {},
): readonly string[] {
  const budget = options.charBudget ?? LIVE_PREVIEW_CHAR_BUDGET;
  const now = options.now ?? Date.now();
  const spin = options.spinnerFrame;
  const lines: string[] = [];
  if (live?.kind === "thinking") {
    lines.push(`${theme.sym.think} Thinking…${spin ? ` ${spin}` : ""}${elapsedSuffix(live.startedAt, now)}`);
    // Echo the thinking tail while working so reasoning is visible before commit.
    const tail = liveTextTail(live.buffer, THINKING_LIVE_TAIL_CHARS);
    const rows = tail.split("\n").filter((row) => row.trim().length > 0);
    for (const row of rows.slice(-THINKING_LIVE_PREVIEW_ROWS)) {
      lines.push(`  ${theme.sym.nest} ${truncateToolDetail(row.trim(), 96)}`);
    }
  } else if (live?.kind === "assistant") {
    const preview = boundLivePreviewFromBuffer(live.buffer, budget);
    // Stream cursor marks "still generating" (motion-gated via spinnerFrame).
    lines.push(`${theme.sym.answer} ${preview}${spin ? STREAM_CURSOR : ""}`);
  }
  for (const tool of inFlightTools) {
    const detail = tool.detail.trim().length > 0 ? ` ${truncateToolDetail(tool.detail)}` : "";
    const explore = isExploreToolName(tool.name);
    const mark = explore ? theme.sym.explore : theme.sym.tool;
    const title = explore ? formatExploreToolLabel({ running: true }) : tool.name;
    lines.push(`${mark} ${title}${detail}${spin ? ` ${spin}` : ""}${elapsedSuffix(tool.startedAt, now)}`);
  }
  for (const worker of inFlightSubagents) {
    lines.push(...formatInFlightSubagentLines(worker, budget, now));
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
  const text = liveTextString(worker.live.buffer);
  const body = text.length > 0 ? indentLines(text, "    ") : [];
  return {
    ...worker,
    live: undefined,
    lines: [...worker.lines, `  ${theme.sym.think} think ${seconds}s`, ...body],
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
    lines: [...worker.lines, ...formatSubagentAssistantLines(text)],
  };
}

function formatSubagentAssistantLines(text: string): string[] {
  if (text.length === 0) return [];
  const rows = text.split("\n");
  const firstContent = rows.findIndex((row) => row.trim().length > 0);
  if (firstContent < 0) return rows.map(() => "    ");
  return rows.map((row, index) =>
    index === firstContent ? `  ${theme.sym.answer} ${row}` : `    ${row}`);
}

function formatInFlightSubagentLines(
  worker: InFlightSubagent,
  charBudget: number,
  now: number,
): string[] {
  const name = worker.name ? ` · ${truncateToolDetail(worker.name, 28)}` : "";
  const role = worker.role ? ` [${worker.role}]` : "";
  const goal = worker.goal.trim().length > 0 ? ` ${truncateToolDetail(worker.goal)}` : "";
  const activity = formatSubagentActivity(worker, charBudget, now);
  return [
    `${theme.sym.explore} subagent #${worker.workerId}${name} · ${worker.model}${role}${goal} ${theme.sym.meta} ${activity}`,
  ];
}

/** Human activity label for one running worker ("Thinking 5s" / "Running: read …"). */
export function formatSubagentActivity(worker: InFlightSubagent, charBudget: number, now: number): string {
  const elapsed = Math.max(1, Math.round((now - worker.startedAt) / 1000));
  if (worker.activity.kind === "thinking") {
    const active = Math.max(1, Math.round((now - worker.activity.startedAt) / 1000));
    return `Thinking ${active}s`;
  }
  if (worker.activity.kind === "responding") {
    return `Responding ${elapsed}s`;
  }
  if (worker.activity.kind === "tool") {
    const active = Math.max(1, Math.round((now - worker.activity.startedAt) / 1000));
    const detail = worker.activity.detail.trim().length > 0
      ? ` ${truncateToolDetail(worker.activity.detail, Math.min(48, charBudget))}`
      : "";
    const more = Math.max(0, worker.inFlightTools.length - 1);
    return `Running: ${worker.activity.name}${detail}${more > 0 ? ` +${more}` : ""} ${theme.sym.meta} ${active}s`;
  }
  if (worker.activity.kind === "starting") {
    return `Starting ${theme.sym.meta} ${elapsed}s`;
  }
  return `Working ${theme.sym.meta} ${elapsed}s`;
}

function buildSubagentInnerToolLines(input: Readonly<{
  name: string;
  detail: string;
  error: boolean;
  output: string;
}>): string[] {
  const detailPart = input.detail.trim().length > 0 ? ` ${truncateToolDetail(input.detail)}` : "";
  const status = input.error ? "failed" : "done";
  const display = formatToolOutputForDisplay(input.output) || input.output;
  const body = display.length > 0
    ? indentLines(display, `    ${theme.sym.nest} `)
    : [];
  return [
    `  ${theme.sym.tool} ${input.name}${detailPart} ${status}`,
    ...body,
  ];
}

function buildSubagentHistoryBlock(input: Readonly<{
  id: number;
  worker: InFlightSubagent;
  success: boolean;
  status?: string;
}>): HistoryBlock {
  const { worker } = input;
  const name = worker.name ? ` · ${truncateToolDetail(worker.name, 28)}` : "";
  const role = worker.role ? ` [${worker.role}]` : "";
  const goal = worker.goal.trim().length > 0 ? ` ${truncateToolDetail(worker.goal)}` : "";
  const statusLabel = input.status ?? (input.success ? "done" : "failed");
  const seconds = Math.max(1, Math.round((Date.now() - worker.startedAt) / 1000));
  // Collapse tool-call history into Ctrl+O. Keep one assistant peek if present.
  const assistantPeek = [...worker.lines].reverse().find((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith(theme.sym.answer);
  });
  const fullOutput = worker.lines.join("\n");
  const lineCount = fullOutput.length === 0 ? 0 : fullOutput.split("\n").length;
  const header = `${theme.sym.explore} subagent #${worker.workerId}${name} · ${worker.model}${role}${goal}`
    + ` (${statusLabel} ${theme.sym.meta} ${seconds}s)`
    + ` ${theme.sym.meta} ${formatToolExpandHint(lineCount)}`;
  const lines = [header];
  if (assistantPeek) {
    lines.push(`  ${theme.sym.nest} ${truncateToolDetail(assistantPeek.trimStart().slice(theme.sym.answer.length).trim(), 96)}`);
  }
  return {
    id: input.id,
    kind: "subagent",
    lines,
    error: !input.success,
    output: fullOutput,
    title: `subagent #${worker.workerId}`,
    workerId: worker.workerId,
    model: worker.model,
    detail: worker.goal,
    previewCollapsed: true,
  };
}

function isExploreHistoryBlock(block: HistoryBlock): boolean {
  if (block.kind === "subagent") return true;
  if (block.kind === "tool" && isExploreToolName(block.title)) return true;
  return block.lines.some((line) => line.includes(theme.sym.explore));
}

export { isExploreHistoryBlock };
