import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ImmunityRule, ImmunityTrigger } from "./types.ts";

export function resolveRepoId(cwd: string): string {
  return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

const FILE_PATH_RE = /(?:[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9_-]+|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|toml|yaml|yml|css|html|sh))/g;

export function extractReferencedFiles(text: string): string[] {
  const matches = text.match(FILE_PATH_RE);
  if (!matches) return [];
  return Array.from(new Set(matches.map((p) => p.replace(/^[./]+/, ""))));
}

export type DistillRollbackInput = Readonly<{
  repoId: string;
  kind: "turn" | "session";
  summary: string;
  affectedFiles?: readonly string[];
  now?: () => Date;
}>;

export function distillFromRollback(input: DistillRollbackInput): ImmunityRule {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const trigger: ImmunityTrigger = input.kind === "turn" ? "rollback_turn" : "rollback";
  const files = input.affectedFiles && input.affectedFiles.length > 0
    ? Array.from(input.affectedFiles)
    : extractReferencedFiles(input.summary);

  let lesson: string;
  if (files.length > 0) {
    const fileList = files.slice(0, 5).join(", ");
    const suffix = files.length > 5 ? ` and ${files.length - 5} more` : "";
    lesson = `Previous modification to [${fileList}${suffix}] was rejected by ${input.kind} rollback. Exercise extreme caution and do not re-apply the discarded diff.`;
  } else {
    lesson = `Previous turn/session was discarded via user rollback (${input.summary.slice(0, 120)}). Re-evaluate the approach rather than repeating it.`;
  }

  return {
    id: `im_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    repoId: input.repoId,
    createdAt: now,
    trigger,
    lesson,
    detail: input.summary,
    affectedFiles: files.length > 0 ? files : undefined,
  };
}

export type DistillHardSteerInput = Readonly<{
  repoId: string;
  text: string;
  now?: () => Date;
}>;

export function distillFromHardSteer(input: DistillHardSteerInput): ImmunityRule {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const cleaned = input.text.trim().replace(/^!+\s*/, "");
  const files = extractReferencedFiles(cleaned);

  const lesson = `User explicit intervention: "${cleaned}". Strictly adhere to this user constraint and avoid violating it.`;

  return {
    id: `im_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    repoId: input.repoId,
    createdAt: now,
    trigger: "hard_steer",
    lesson,
    detail: input.text,
    affectedFiles: files.length > 0 ? files : undefined,
  };
}

export function deduplicateAndMergeRules(
  existing: readonly ImmunityRule[],
  newRule: ImmunityRule,
  maxRules = 10,
): ImmunityRule[] {
  const normalizedNew = newRule.lesson.toLowerCase().trim();
  const filtered = existing.filter((item) => {
    const normalizedItem = item.lesson.toLowerCase().trim();
    if (normalizedItem === normalizedNew) return false;
    // If same affected files and same trigger, supersede
    if (
      item.trigger === newRule.trigger &&
      item.affectedFiles &&
      newRule.affectedFiles &&
      item.affectedFiles.length > 0 &&
      item.affectedFiles.every((f) => newRule.affectedFiles!.includes(f))
    ) {
      return false;
    }
    return true;
  });

  const merged = [newRule, ...filtered];
  // Sort latest first and cap
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return merged.slice(0, maxRules);
}
