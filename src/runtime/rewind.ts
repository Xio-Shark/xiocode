/**
 * Rewind: go back to the start of an earlier turn — files, conversation, or both.
 *
 * Each turn start leaves a rewind point: the kernel snapshot taken before the
 * turn (direct mode) and the length of the conversation before the turn's
 * prompt. Points are journaled as kernel facts, so a resumed session still
 * lists them; the snapshot's own `journalSeq` ties the files to the same log.
 *
 * Nothing is guessed: a point whose snapshot was pruned cannot restore files,
 * and a point whose prompt is no longer where it was (the conversation was
 * compacted since) cannot restore the conversation. Both say why.
 */

import crypto from "node:crypto";

import type { SessionHistory } from "./context-compaction.ts";
import type { ChatMessage } from "./types.ts";

export type RewindMode = "both" | "code" | "conversation";

export type RewindAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reason: string }>;

export type RewindPointView = Readonly<{
  /** 1-based, oldest first; what `/rewind <n>` takes. */
  index: number;
  at: string;
  /** The turn's prompt (first line, bounded), or a placeholder when it is gone. */
  prompt: string;
  code: RewindAvailability;
  conversation: RewindAvailability;
}>;

export type RewindOutcome = Readonly<{
  skipped: boolean;
  summary: string;
  /** The rewound turn's prompt, for putting back into the composer. */
  prompt?: string;
}>;

/** File side of rewind (direct-mode kernel snapshots). */
export type RewindFileGate = Readonly<{
  hasTurnSnapshot: (snapshotId: string) => boolean;
  restoreTurnSnapshot: (
    snapshotId: string,
    label: string,
    ask: (question: string, detail?: string) => Promise<boolean>,
    notify?: (message: string) => void,
  ) => Promise<Readonly<{ skipped: boolean; unchanged?: boolean; summary: string }>>;
  dropTurnSnapshotsAfter: (snapshotId: string) => Promise<void>;
}>;

/** Kernel journal access (facts survive a restart with the session's domain). */
export type RewindJournal = Readonly<{
  recordFact: (type: `XIOCODE_${string}`, payload: Record<string, unknown>) => number;
  listFacts: (type: `XIOCODE_${string}`) => readonly Readonly<{
    seq: number;
    timestamp: string;
    payload: Record<string, unknown>;
  }>[];
}>;

export const REWIND_POINT_FACT = "XIOCODE_REWIND_POINT";
export const REWIND_FACT = "XIOCODE_REWIND";
const MAX_POINTS = 50;
const PREVIEW_CHARS = 72;

type Point = Readonly<{
  at: string;
  messageCount: number;
  promptHash: string;
  snapshotId?: string;
}>;

export class RewindLedger {
  readonly #history: SessionHistory;
  readonly #gate: RewindFileGate | undefined;
  readonly #journal: RewindJournal | undefined;
  readonly #ask: (question: string, detail?: string) => Promise<boolean>;
  readonly #notify: ((message: string) => void) | undefined;
  readonly #isBusy: () => boolean;
  #points: Point[];

  constructor(deps: Readonly<{
    history: SessionHistory;
    gate?: RewindFileGate;
    journal?: RewindJournal;
    ask: (question: string, detail?: string) => Promise<boolean>;
    notify?: (message: string) => void;
    isBusy?: () => boolean;
  }>) {
    this.#history = deps.history;
    this.#gate = deps.gate;
    this.#journal = deps.journal;
    this.#ask = deps.ask;
    this.#notify = deps.notify;
    this.#isBusy = deps.isBusy ?? (() => false);
    this.#points = deps.journal ? replayJournal(deps.journal) : [];
  }

  /** Snapshot ids the file gate must keep alive at startup (oldest first). */
  retainedSnapshotIds(): string[] {
    return this.#points.flatMap((point) => (point.snapshotId ? [point.snapshotId] : []));
  }

  /** Records the point for a turn about to start; `messageCount` excludes the turn's prompt. */
  record(input: Readonly<{ messageCount: number; prompt: string; snapshotId?: string }>): void {
    const point: Point = {
      at: new Date().toISOString(),
      messageCount: input.messageCount,
      promptHash: hash(input.prompt),
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    };
    this.#journal?.recordFact(REWIND_POINT_FACT, { ...point });
    this.#points.push(point);
    if (this.#points.length > MAX_POINTS) this.#points.splice(0, this.#points.length - MAX_POINTS);
  }

  list(): RewindPointView[] {
    const messages = this.#history.getMessages();
    return this.#points.map((point, i) => {
      const promptIndex = locatePrompt(messages, point);
      return {
        index: i + 1,
        at: point.at,
        prompt: promptIndex === undefined ? "(prompt no longer in the conversation)" : preview(messages[promptIndex]!.content),
        code: this.#codeAvailability(point),
        conversation: promptIndex === undefined
          ? { available: false, reason: "the conversation was compacted after this turn" }
          : { available: true },
      };
    });
  }

  async rewind(index: number, mode: RewindMode): Promise<RewindOutcome> {
    if (this.#isBusy()) throw new Error("rewind is unavailable while a turn is running; stop it first");
    const point = this.#points[index - 1];
    if (!point) throw new Error(`no rewind point ${index} (there are ${this.#points.length})`);
    const messages = this.#history.getMessages();
    const promptIndex = locatePrompt(messages, point);
    const wantsCode = mode !== "conversation";
    const wantsConversation = mode !== "code";
    const code = this.#codeAvailability(point);
    if (wantsCode && !code.available) throw new Error(`cannot restore files to turn ${index}: ${code.reason}`);
    if (wantsConversation && promptIndex === undefined) {
      throw new Error(`cannot rewind the conversation to turn ${index}: it was compacted after this turn`);
    }

    const lines: string[] = [];
    if (wantsCode) {
      const result = await this.#gate!.restoreTurnSnapshot(point.snapshotId!, `the start of turn ${index}`, this.#ask, this.#notify);
      if (result.skipped && !result.unchanged) {
        return { skipped: true, summary: "Rewind cancelled; files and conversation are unchanged." };
      }
      lines.push(result.unchanged ? `Files already match the start of turn ${index}.` : result.summary);
    }
    let prompt: string | undefined;
    if (wantsConversation) {
      prompt = messages[promptIndex!]!.content;
      await this.#history.replace(messages.slice(0, point.messageCount));
      lines.push(`Conversation rewound to before turn ${index}; its prompt is back in the input.`);
    } else {
      lines.push("Conversation kept as it is.");
    }

    // Files and conversation back at turn `index`: that turn and later ones no
    // longer happened. A files-only rewind leaves the conversation's points.
    const keep = wantsConversation ? index - 1 : this.#points.length;
    if (mode === "both") await this.#gate!.dropTurnSnapshotsAfter(point.snapshotId!);
    this.#points.splice(keep);
    this.#journal?.recordFact(REWIND_FACT, {
      mode,
      turn: index,
      keep,
      messageCount: point.messageCount,
      ...(point.snapshotId ? { snapshotId: point.snapshotId } : {}),
    });
    return { skipped: false, summary: lines.join("\n"), ...(prompt !== undefined ? { prompt } : {}) };
  }

  #codeAvailability(point: Point): RewindAvailability {
    if (!this.#gate) {
      return { available: false, reason: "file rewind needs direct mode in a git repository" };
    }
    if (!point.snapshotId) return { available: false, reason: "no snapshot was taken when this turn started" };
    if (!this.#gate.hasTurnSnapshot(point.snapshotId)) {
      return { available: false, reason: "its snapshot is no longer retained (only recent turns keep one)" };
    }
    return { available: true };
  }
}

/** Snapshot ids of the journaled rewind points, oldest first (to keep them alive at startup). */
export function rewindSnapshotIds(journal: RewindJournal): string[] {
  return replayJournal(journal).flatMap((point) => (point.snapshotId ? [point.snapshotId] : []));
}

/** Rebuilds the point list from journaled facts (points, then rewinds that cut it). */
function replayJournal(journal: RewindJournal): Point[] {
  const facts = [
    ...journal.listFacts(REWIND_POINT_FACT).map((fact) => ({ ...fact, kind: "point" as const })),
    ...journal.listFacts(REWIND_FACT).map((fact) => ({ ...fact, kind: "rewind" as const })),
  ].sort((a, b) => a.seq - b.seq);
  const points: Point[] = [];
  for (const fact of facts) {
    const p = fact.payload;
    if (fact.kind === "rewind") {
      if (typeof p.keep === "number") points.splice(p.keep);
      continue;
    }
    if (typeof p.messageCount !== "number" || typeof p.promptHash !== "string") continue;
    points.push({
      at: typeof p.at === "string" ? p.at : fact.timestamp,
      messageCount: p.messageCount,
      promptHash: p.promptHash,
      ...(typeof p.snapshotId === "string" ? { snapshotId: p.snapshotId } : {}),
    });
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
  }
  return points;
}

/**
 * Index of the point's prompt: the first user message at `messageCount`
 * (a turn-start context message may precede it). Undefined when compaction
 * moved or summarized it away.
 */
function locatePrompt(messages: readonly ChatMessage[], point: Point): number | undefined {
  for (let i = point.messageCount; i < Math.min(messages.length, point.messageCount + 2); i += 1) {
    const message = messages[i]!;
    if (message.role === "user") return hash(message.content) === point.promptHash ? i : undefined;
  }
  return undefined;
}

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function preview(text: string): string {
  const line = text.split("\n").find((part) => part.trim().length > 0)?.trim() ?? "";
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/** `/rewind` without arguments: the list, newest last, with what each point can restore. */
export function formatRewindPoints(points: readonly RewindPointView[]): string {
  if (points.length === 0) return "Nothing to rewind to yet: points are recorded when a turn starts.";
  const lines = points.map((point) => {
    const what = [
      point.code.available ? "files" : undefined,
      point.conversation.available ? "conversation" : undefined,
    ].filter(Boolean).join(" + ") || "nothing restorable";
    return `  ${point.index}. ${point.prompt}  [${what}]`;
  });
  return [
    "Rewind points (start of each turn):",
    ...lines,
    "/rewind <n> [both|code|conversation]  (default: both)",
  ].join("\n");
}
