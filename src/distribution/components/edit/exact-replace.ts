import fs from 'node:fs';
import type { Component } from '../../../host/lifecycle.ts';

export type LineEnding = '\r\n' | '\n';

export class MatchNotFoundError extends Error {
  public readonly filePath: string;
  public readonly targetContent: string;

  constructor(filePath: string, targetContent: string) {
    super(`Target content not found in file: ${filePath}`);
    this.name = 'MatchNotFoundError';
    this.filePath = filePath;
    this.targetContent = targetContent;
  }
}

export class AmbiguousMatchError extends Error {
  public readonly filePath: string;
  public readonly count: number;

  constructor(filePath: string, count: number) {
    super(
      `Target content matched ${count} times in ${filePath}. Exact replacement requires strictly 1 unique match.`
    );
    this.name = 'AmbiguousMatchError';
    this.filePath = filePath;
    this.count = count;
  }
}

export function detectLineEnding(content: string): LineEnding {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  // 计算单独的 \n
  const matches = content.match(/\r?\n/g) || [];
  const lfOnlyCount = matches.length - crlfCount;
  return crlfCount > lfOnlyCount ? '\r\n' : '\n';
}

export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function convertLineEndings(content: string, ending: LineEnding): string {
  const normalized = normalizeNewlines(content);
  if (ending === '\r\n') {
    return normalized.replace(/\n/g, '\r\n');
  }
  return normalized;
}

export interface ReplaceOptions {
  filePath: string;
  targetContent: string;
  replacementContent: string;
}

export interface ReplaceResult {
  filePath: string;
  detectedLineEnding: LineEnding;
  bytesWritten: number;
}

export class ExactReplaceEditStrategy implements Component {
  public readonly name = 'exact_replace';

  public replace(options: ReplaceOptions): ReplaceResult {
    const { filePath, targetContent, replacementContent } = options;

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const rawContent = fs.readFileSync(filePath, 'utf8');
    const lineEnding = detectLineEnding(rawContent);

    const normContent = normalizeNewlines(rawContent);
    const normTarget = normalizeNewlines(targetContent);
    const normReplacement = normalizeNewlines(replacementContent);

    // 检查匹配次数
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = normContent.indexOf(normTarget, pos);
      if (idx === -1) break;
      count++;
      pos = idx + normTarget.length;
    }

    if (count === 0) {
      throw new MatchNotFoundError(filePath, targetContent);
    }
    if (count > 1) {
      throw new AmbiguousMatchError(filePath, count);
    }

    // 替换单处匹配
    const replacedNorm = normContent.replace(normTarget, normReplacement);
    // 严格格式化回原换行符写盘
    const finalContent = convertLineEndings(replacedNorm, lineEnding);
    fs.writeFileSync(filePath, finalContent, 'utf8');

    return {
      filePath,
      detectedLineEnding: lineEnding,
      bytesWritten: Buffer.byteLength(finalContent, 'utf8'),
    };
  }
}
