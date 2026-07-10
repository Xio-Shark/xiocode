import path from "node:path";

import type { ToolResult } from "./types.ts";
import { FileOutlineGenerator } from "./file-outline-generator.ts";

export type ResultDenoiserOptions = Readonly<{
  maxReadLines?: number;
  maxGrepResults?: number;
  maxBashChars?: number;
  maxGlobResults?: number;
  maxSearchContextChars?: number;
  maxStackFrames?: number;
  enableOutlineGeneration?: boolean;
  outlineThreshold?: number;
  smartOutlineThreshold?: number;
}>;

const DEFAULTS = {
  maxReadLines: 500,
  maxGrepResults: 20,
  maxBashChars: 4_000,
  maxGlobResults: 50,
  maxSearchContextChars: 8_000,
  maxStackFrames: 5,
  enableOutlineGeneration: true,
  outlineThreshold: 500,
  smartOutlineThreshold: 5000,
} as const;
const LF_CODE = 10;
const CR_CODE = 13;

type ContentBlock = Record<string, unknown> & Readonly<{ type: string }>;

const STACK_TRACE_PATTERNS = [
  /^\s+at\s+.+\s+\(.+:\d+:\d+\)$/m, // Node.js: "  at func (file.ts:10:5)"
  /^\s+at\s+.+:\d+:\d+$/m, // Node.js short: "  at file.ts:10:5"
  /^\s*File\s+".+",\s+line\s+\d+,\s+in\s+.+$/m, // Python: '  File "file.py", line 10, in func'
  /^\s+at\s+[\w:]+::[\w:]+$/m, // Rust: "  at crate::module::func"
  /^\s+at\s+[\w.$]+\.[\w$]+\(.+:\d+\)$/m, // Java: "  at Class.method(File.java:10)"
  /^\s+at\s+[\w.$]+\.[\w$]+\(Native Method\)$/m, // Java Native: "  at Class.method(Native Method)"
] as const;

export class ResultDenoiser {
  private readonly options: Required<ResultDenoiserOptions>;

  constructor(options: ResultDenoiserOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async process(toolName: string, result: ToolResult, args?: Record<string, unknown>): Promise<ToolResult> {
    if (toolName === "read") {
      return this.processRead(result, args);
    }
    if (toolName === "grep") {
      return this.withContent(result, truncateLineList(result.content, this.options.maxGrepResults, "matches"));
    }
    if (toolName === "bash") {
      const text = toText(result.content);
      const truncated = truncateText(text, this.options.maxBashChars);
      return this.withContent(result, truncateStackTrace(truncated, this.options.maxStackFrames));
    }
    if (toolName === "glob" || toolName === "find" || toolName === "ls") {
      return this.withContent(result, groupPathResults(result.content, this.options.maxGlobResults));
    }
    if (toolName === "search_context") {
      return this.withContent(result, truncateTextLikeContent(result.content, this.options.maxSearchContextChars));
    }
    return this.withNormalizedContent(result);
  }

  private async processRead(result: ToolResult, args?: Record<string, unknown>): Promise<ToolResult> {
    const content = toText(result.content);
    const filePath = this.extractFilePath(result, args);

    // Try outline generation if enabled and file is large enough
    if (this.options.enableOutlineGeneration && filePath) {
      const lineCount = countLines(content);

      // For very large files, try smart outline with signatures first
      if (lineCount > this.options.smartOutlineThreshold) {
        const smartOutline = await FileOutlineGenerator.generateSmartOutline(filePath, content, this.options.smartOutlineThreshold);
        if (smartOutline) {
          return this.withContent(result, smartOutline);
        }
      }

      if (lineCount > this.options.outlineThreshold) {
        const outline = await FileOutlineGenerator.generate(filePath, content);
        if (outline) {
          const outlineText = FileOutlineGenerator.formatOutline(outline);
          return this.withContent(result, outlineText);
        }
      }
    }

    // Fallback to line truncation
    return this.withContent(result, truncateLines(content, this.options.maxReadLines));
  }

  private extractFilePath(result: ToolResult, args?: Record<string, unknown>): string | null {
    // Try args first (from Read tool call)
    if (args && typeof args.file_path === "string") {
      return args.file_path;
    }

    // Fallback to metadata
    if (result.metadata && typeof result.metadata === "object") {
      const meta = result.metadata as Record<string, unknown>;
      if (typeof meta.file_path === "string") {
        return meta.file_path;
      }
    }

    return null;
  }

  private withContent(result: ToolResult, content: unknown): ToolResult {
    return {
      ...result,
      content: normalizeToolContent(result.content, content),
      metadata: { ...result.metadata, denoised: true },
    };
  }

  private withNormalizedContent(result: ToolResult): ToolResult {
    return {
      ...result,
      content: normalizeToolContent(result.content, result.content),
    };
  }
}

function truncateLines(text: string, maxLines: number): string {
  if (maxLines === Number.POSITIVE_INFINITY) {
    return text;
  }
  if (maxLines < 0) {
    return truncateLinesWithKnownCount(text, countLines(text), maxLines);
  }
  const scan = scanLineEnds(text, Math.trunc(maxLines));
  if (scan.total <= maxLines) {
    return text;
  }
  const kept = joinLineSlices(text, scan.keptLineEnds);
  return `${kept}\n... (${scan.total - maxLines} more lines, total ${scan.total})`;
}

function truncateLinesWithKnownCount(text: string, totalLines: number, maxLines: number): string {
  if (totalLines <= maxLines) {
    return text;
  }
  const keptLineCount = sliceEndLineCount(totalLines, maxLines);
  const kept = firstLines(text, keptLineCount);
  return `${kept}\n... (${totalLines - maxLines} more lines, total ${totalLines})`;
}

function scanLineEnds(text: string, keepLimit: number): { readonly keptLineEnds: readonly number[]; readonly total: number } {
  const keptLineEnds: number[] = [];
  let total = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== LF_CODE) {
      continue;
    }
    if (keptLineEnds.length < keepLimit) {
      keptLineEnds.push(index);
    }
    total++;
  }
  return { keptLineEnds, total };
}

function joinLineSlices(text: string, lineEnds: readonly number[]): string {
  const lines: string[] = [];
  let lineStart = 0;
  for (const lineEnd of lineEnds) {
    lines.push(lineSlice(text, lineStart, lineEnd));
    lineStart = lineEnd + 1;
  }
  return lines.join("\n");
}

function sliceEndLineCount(totalLines: number, maxLines: number): number {
  if (maxLines >= 0) {
    return Math.trunc(maxLines);
  }
  return Math.max(totalLines + Math.trunc(maxLines), 0);
}

function countLines(text: string): number {
  let total = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === LF_CODE) {
      total++;
    }
  }
  return total;
}

function firstLines(text: string, lineCount: number): string {
  if (lineCount <= 0) {
    return "";
  }
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < text.length && lines.length < lineCount; index++) {
    if (text.charCodeAt(index) !== LF_CODE) {
      continue;
    }
    lines.push(lineSlice(text, lineStart, index));
    lineStart = index + 1;
  }
  if (lines.length < lineCount) {
    lines.push(text.slice(lineStart));
  }
  return lines.join("\n");
}

function lineSlice(text: string, start: number, newlineIndex: number): string {
  const end = text.charCodeAt(newlineIndex - 1) === CR_CODE ? newlineIndex - 1 : newlineIndex;
  return text.slice(start, end);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} more chars)`;
}

function truncateSandboxContent(value: unknown, maxChars: number): unknown {
  const block = singleTextBlock(value);
  if (!block) {
    return truncateText(toText(value), maxChars);
  }
  return [{ ...block, text: truncateText(block.text, maxChars) }];
}

function truncateTextLikeContent(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    return truncateText(value, maxChars);
  }
  const block = singleTextBlock(value);
  if (!block) {
    return truncateText(toText(value), maxChars);
  }
  return [{ ...block, text: truncateText(block.text, maxChars) }];
}

function truncateLineList(value: unknown, maxItems: number, label: string): string {
  const lines = boundedNonEmptyLines(value, maxItems);
  if (lines.total <= maxItems) {
    return lines.items.join("\n");
  }
  return `${lines.items.join("\n")}\n... (${lines.total - maxItems} more ${label})`;
}

function groupPathResults(value: unknown, maxItems: number): string {
  const lines = boundedNonEmptyLines(value, maxItems);
  const grouped = lines.items.map((item) => `${path.dirname(item)}\t${path.basename(item)}`);
  const suffix = lines.total > maxItems ? `\n... (${lines.total - maxItems} more paths)` : "";
  return `${grouped.join("\n")}${suffix}`;
}

function boundedNonEmptyLines(value: unknown, maxItems: number): { readonly items: readonly string[]; readonly total: number } {
  const keepLimit = maxItems < 0 ? Number.POSITIVE_INFINITY : Math.trunc(maxItems);
  const lines = Array.isArray(value) ? collectArrayLines(value, keepLimit) : collectTextLines(toText(value), keepLimit);
  if (maxItems < 0) {
    return { items: lines.items.slice(0, maxItems), total: lines.total };
  }
  return lines;
}

function collectArrayLines(value: readonly unknown[], keepLimit: number): { readonly items: readonly string[]; readonly total: number } {
  const blockText = textFromContentBlocks(value);
  if (blockText !== null) {
    return collectTextLines(blockText, keepLimit);
  }
  const items: string[] = [];
  let total = 0;
  for (const item of value) {
    const line = String(item);
    if (line.length === 0) {
      continue;
    }
    total++;
    if (items.length < keepLimit) {
      items.push(line);
    }
  }
  return { items, total };
}

function collectTextLines(text: string, keepLimit: number): { readonly items: readonly string[]; readonly total: number } {
  const items: string[] = [];
  let total = 0;
  let lineStart = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== LF_CODE) {
      continue;
    }
    if (collectLine({ text, start: lineStart, end: index, stripCr: true }, items, keepLimit)) {
      total++;
    }
    lineStart = index + 1;
  }
  const hasFinalLine = collectLine({ text, start: lineStart, end: text.length, stripCr: false }, items, keepLimit);
  return {
    items,
    total: hasFinalLine ? total + 1 : total,
  };
}

function collectLine(state: { readonly text: string; readonly start: number; readonly end: number; readonly stripCr: boolean }, items: string[], keepLimit: number): boolean {
  const line = state.stripCr ? lineSlice(state.text, state.start, state.end) : state.text.slice(state.start, state.end);
  if (line.length === 0) {
    return false;
  }
  if (items.length < keepLimit) {
    items.push(line);
  }
  return true;
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const blockText = textFromContentBlocks(value);
    if (blockText !== null) {
      return blockText;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value ?? "");
}

function singleTextBlock(value: unknown): (Record<string, unknown> & { text: string }) | null {
  if (!Array.isArray(value) || value.length !== 1) {
    return null;
  }
  const block = value[0];
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return null;
  }
  const record = block as Record<string, unknown>;
  return typeof record.text === "string" ? ({ ...record, text: record.text }) : null;
}

function normalizeToolContent(originalContent: unknown, content: unknown): readonly unknown[] {
  if (isContentBlockList(content)) {
    return content;
  }
  const text = typeof content === "string" ? content : toText(content);
  return replaceTextBlocks(originalContent, text);
}

function replaceTextBlocks(originalContent: unknown, text: string): readonly unknown[] {
  if (!isContentBlockList(originalContent)) {
    return [{ type: "text", text }];
  }
  let replaced = false;
  const blocks: unknown[] = [];
  for (const block of originalContent) {
    if (block.type === "text") {
      if (!replaced) {
        blocks.push({ ...block, text });
        replaced = true;
      }
      continue;
    }
    blocks.push(block);
  }
  return replaced ? blocks : [{ type: "text", text }, ...originalContent];
}

function textFromContentBlocks(content: readonly unknown[]): string | null {
  const texts: string[] = [];
  for (const item of content) {
    const text = textContentBlockText(item);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function textContentBlockText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record?.type !== "text") {
    return undefined;
  }
  return typeof record.text === "string" ? record.text : undefined;
}

function isContentBlockList(value: unknown): value is readonly ContentBlock[] {
  return Array.isArray(value) && value.every((item) => typeof asRecord(item)?.type === "string");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function detectStackTrace(text: string): boolean {
  return STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

function truncateStackTrace(text: string, maxFrames: number): string {
  if (!detectStackTrace(text)) {
    return text;
  }

  const lines = text.split("\n");
  const errorLines: string[] = [];
  const frameLines: string[] = [];
  let inStackTrace = false;

  for (const line of lines) {
    const isFrame = STACK_TRACE_PATTERNS.some((pattern) => pattern.test(line));

    if (isFrame) {
      inStackTrace = true;
      frameLines.push(line);
    } else if (!inStackTrace || frameLines.length === 0) {
      errorLines.push(line);
    }
  }

  if (frameLines.length <= maxFrames + 1) {
    return text;
  }

  const topFrames = frameLines.slice(0, maxFrames);
  const originFrame = frameLines[frameLines.length - 1]!; // Always exists because frameLines.length > maxFrames + 1
  const truncatedCount = frameLines.length - maxFrames - 1;

  const result = [...errorLines, ...topFrames];
  if (truncatedCount > 0) {
    result.push(`    ... (truncated ${truncatedCount} frames) ...`);
  }
  result.push(originFrame);

  return result.join("\n");
}

function truncateStackTraceContent(value: unknown, maxFrames: number): unknown {
  const block = singleTextBlock(value);
  if (!block) {
    return typeof value === "string" ? truncateStackTrace(value, maxFrames) : value;
  }
  return [{ ...block, text: truncateStackTrace(block.text, maxFrames) }];
}
