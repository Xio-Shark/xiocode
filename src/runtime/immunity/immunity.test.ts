import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import {
  deduplicateAndMergeRules,
  distillFromHardSteer,
  distillFromRollback,
  extractReferencedFiles,
} from "./distill.ts";
import { ImmunityStore } from "./store.ts";
import type { ImmunityRule } from "./types.ts";

describe("Immunity Distillation & Store", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempDir = undefined;
    }
  });

  it("extracts referenced files accurately from text", () => {
    const text = "Restored modified files: src/auth.ts, config/settings.json and ./utils/jwt.ts";
    const files = extractReferencedFiles(text);
    expect(files).toContain("src/auth.ts");
    expect(files).toContain("config/settings.json");
    expect(files).toContain("utils/jwt.ts");
  });

  it("distills rollback event into a negative rule", () => {
    const rule = distillFromRollback({
      repoId: "test-repo",
      kind: "turn",
      summary: "Restored src/auth.ts",
      affectedFiles: ["src/auth.ts"],
    });

    expect(rule.repoId).toBe("test-repo");
    expect(rule.trigger).toBe("rollback_turn");
    expect(rule.affectedFiles).toEqual(["src/auth.ts"]);
    expect(rule.lesson).toContain("src/auth.ts");
    expect(rule.lesson).toContain("rejected by turn rollback");
  });

  it("distills hard steer event into a negative rule", () => {
    const rule = distillFromHardSteer({
      repoId: "test-repo",
      text: "!Do not delete the legacy bcrypt password hash verification in auth.ts",
    });

    expect(rule.repoId).toBe("test-repo");
    expect(rule.trigger).toBe("hard_steer");
    expect(rule.lesson).toContain("Do not delete the legacy bcrypt password hash verification in auth.ts");
    expect(rule.affectedFiles).toContain("auth.ts");
  });

  it("deduplicates identical lessons and enforces max capacity", () => {
    const baseDate = new Date("2026-09-01T12:00:00Z");
    const r1: ImmunityRule = {
      id: "1",
      repoId: "test",
      createdAt: baseDate.toISOString(),
      trigger: "hard_steer",
      lesson: "Do not touch config.json",
    };
    const r2: ImmunityRule = {
      id: "2",
      repoId: "test",
      createdAt: new Date("2026-09-01T12:01:00Z").toISOString(),
      trigger: "hard_steer",
      lesson: "Do not touch config.json", // duplicate lesson
    };
    const r3: ImmunityRule = {
      id: "3",
      repoId: "test",
      createdAt: new Date("2026-09-01T12:02:00Z").toISOString(),
      trigger: "rollback_turn",
      lesson: "Failed on src/main.ts",
    };

    const merged = deduplicateAndMergeRules([r1], r2, 5);
    expect(merged.length).toBe(1);
    expect(merged[0]?.id).toBe("2"); // latest replaces

    const mergedWithR3 = deduplicateAndMergeRules(merged, r3, 5);
    expect(mergedWithR3.length).toBe(2);
    expect(mergedWithR3[0]?.id).toBe("3"); // sorted desc
  });

  it("persists rules atomically and formats prompt section", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-immunity-test-"));
    const store = new ImmunityStore({ baseDir: tempDir });

    const rule1 = await store.recordRollback({
      repoId: "repo-alpha",
      kind: "session",
      summary: "Restored all files back to baseline",
    });

    const rule2 = await store.recordHardSteer({
      repoId: "repo-alpha",
      text: "!Keep the port 3000 default in server.ts",
    });

    const loaded = await store.loadRules("repo-alpha");
    expect(loaded.length).toBe(2);
    expect(loaded.map((r) => r.id)).toContain(rule1.id);
    expect(loaded.map((r) => r.id)).toContain(rule2.id);

    const promptText = store.formatPromptSection(loaded);
    expect(promptText).toContain("[Project Immunity & Negative Constraints]");
    expect(promptText).toContain("Keep the port 3000 default in server.ts");
    expect(promptText).toContain("user rollback");

    // Empty rules formatting returns empty string
    expect(store.formatPromptSection([])).toBe("");
  });
});
