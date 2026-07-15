import { createHash } from "node:crypto";

import { redactSecrets } from "./privacy.ts";

import type { EvidenceCitation, EvidenceRecord } from "./types.ts";

export class EvidenceStaleError extends Error {
  readonly citation: EvidenceCitation;

  constructor(citation: EvidenceCitation, reason: string) {
    super(`evidence stale: ${reason} (${citation.path}:${citation.startLine}-${citation.endLine})`);
    this.name = "EvidenceStaleError";
    this.citation = citation;
  }
}

export class EvidenceStore {
  readonly #records = new Map<string, EvidenceRecord>();

  static contentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  static citationKey(citation: EvidenceCitation): string {
    return `${citation.path}|${citation.startLine}|${citation.endLine}|${citation.hash}`;
  }

  putFromText(input: Readonly<{
    path: string;
    text: string;
    startLine?: number;
    endLine?: number;
    fileHash?: string;
  }>): EvidenceRecord {
    const lines = input.text.split("\n");
    const startLine = input.startLine && input.startLine > 0 ? Math.floor(input.startLine) : 1;
    const endLine = input.endLine && input.endLine >= startLine
      ? Math.floor(input.endLine)
      : lines.length;
    const slice = lines.slice(startLine - 1, endLine).join("\n");
    const redacted = redactSecrets(slice);
    const hash = input.fileHash ?? EvidenceStore.contentHash(input.text);
    const record: EvidenceRecord = {
      path: input.path.replace(/\\/g, "/"),
      startLine,
      endLine,
      hash,
      text: redacted,
      capturedAt: Date.now(),
    };
    this.#records.set(EvidenceStore.citationKey(record), record);
    return record;
  }

  get(citation: EvidenceCitation): EvidenceRecord {
    const key = EvidenceStore.citationKey(citation);
    const found = this.#records.get(key);
    if (!found) {
      throw new EvidenceStaleError(citation, "missing");
    }
    if (found.hash !== citation.hash) {
      throw new EvidenceStaleError(citation, "hash mismatch");
    }
    return found;
  }

  /**
   * Bounded raw read for agent consumption. Throws EvidenceStaleError when invalid.
   */
  readEvidence(
    citation: EvidenceCitation,
    options: Readonly<{ maxChars?: number }> = {},
  ): Readonly<{ text: string; citation: EvidenceCitation; truncated: boolean }> {
    const record = this.get(citation);
    const maxChars = options.maxChars ?? 12_000;
    if (record.text.length <= maxChars) {
      return { text: record.text, citation, truncated: false };
    }
    return {
      text: `${record.text.slice(0, maxChars)}\n[truncated by maxChars=${maxChars}]`,
      citation,
      truncated: true,
    };
  }

  invalidatePath(relativePath: string): number {
    const normalized = relativePath.replace(/\\/g, "/");
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (record.path === normalized || record.path.startsWith(`${normalized}/`)) {
        this.#records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.#records.size;
  }
}
