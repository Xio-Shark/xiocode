import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensurePrivateDir, writePrivateFileAtomic } from "../private-fs.ts";
import {
  deduplicateAndMergeRules,
  distillFromHardSteer,
  distillFromRollback,
  type DistillHardSteerInput,
  type DistillRollbackInput,
} from "./distill.ts";
import type { ImmunityFileFormat, ImmunityRule } from "./types.ts";

export type ImmunityStoreOptions = Readonly<{
  baseDir?: string;
  maxRulesPerRepo?: number;
}>;

export class ImmunityStore {
  private readonly baseDir: string;
  private readonly maxRules: number;

  constructor(options: ImmunityStoreOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.homedir(), ".xiocode", "immunity");
    this.maxRules = options.maxRulesPerRepo ?? 10;
  }

  private getFilePath(repoId: string): string {
    const safeRepoId = repoId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.baseDir, `${safeRepoId}.json`);
  }

  async loadRules(repoId: string): Promise<ImmunityRule[]> {
    if (!repoId) return [];
    const filePath = this.getFilePath(repoId);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ImmunityFileFormat>;
      if (Array.isArray(parsed.rules)) {
        return parsed.rules as ImmunityRule[];
      }
      return [];
    } catch {
      return [];
    }
  }

  async recordRule(newRule: ImmunityRule): Promise<ImmunityRule[]> {
    if (!newRule.repoId) return [];
    await ensurePrivateDir(this.baseDir);
    const existing = await this.loadRules(newRule.repoId);
    const updated = deduplicateAndMergeRules(existing, newRule, this.maxRules);
    const payload: ImmunityFileFormat = {
      version: 1,
      updatedAt: new Date().toISOString(),
      rules: updated,
    };
    const filePath = this.getFilePath(newRule.repoId);
    await writePrivateFileAtomic(filePath, JSON.stringify(payload, null, 2), {
      durable: true,
    });
    return updated;
  }

  async recordRollback(input: DistillRollbackInput): Promise<ImmunityRule> {
    const rule = distillFromRollback(input);
    await this.recordRule(rule);
    return rule;
  }

  async recordHardSteer(input: DistillHardSteerInput): Promise<ImmunityRule> {
    const rule = distillFromHardSteer(input);
    await this.recordRule(rule);
    return rule;
  }

  async clearRules(repoId: string): Promise<void> {
    if (!repoId) return;
    const filePath = this.getFilePath(repoId);
    const payload: ImmunityFileFormat = {
      version: 1,
      updatedAt: new Date().toISOString(),
      rules: [],
    };
    await writePrivateFileAtomic(filePath, JSON.stringify(payload, null, 2), {
      durable: true,
    });
  }

  formatPromptSection(rules: readonly ImmunityRule[]): string {
    if (!rules || rules.length === 0) return "";
    const lines = [
      "[Project Immunity & Negative Constraints]",
      "The following constraints were established from previous user rollbacks or direct interventions in this repository.",
      "Strictly respect these constraints and do NOT repeat past discarded mistakes:",
    ];
    for (const rule of rules) {
      lines.push(`- (${rule.trigger}) ${rule.lesson}`);
    }
    return lines.join("\n");
  }
}
