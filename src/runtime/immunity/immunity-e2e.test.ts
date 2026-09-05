import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { ImmunityStore } from "./store.ts";
import { ContextInjector } from "../../../extensions/xio-evolve/src/context-injector.ts";
import { ExtensionHost } from "../extension-host.ts";
import { registerRollbackCommand } from "../session-lifecycle.ts";

describe("Immunity End-to-End Integration", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempDir = undefined;
    }
  });

  it("completes full loop: rollback -> auto synthesize -> context injection -> slash command", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-immunity-e2e-"));
    const immunityStore = new ImmunityStore({ baseDir: tempDir });
    const repoId = "repo-e2e-test";

    const host = new ExtensionHost({
      initialModel: { id: "test-model", name: "Test", provider: "mock" },
    });

    // 1. Wire rollback command with onRollbackSuccess
    registerRollbackCommand(
      host,
      {
        promptRollback: async () => ({ ok: true, skipped: false, summary: "Restored src/server.ts and package.json" }),
        promptRollbackTurn: async () => ({ ok: true, skipped: false, summary: "Restored src/server.ts and package.json" }),
      },
      async () => true,
      undefined,
      async (input) => {
        await immunityStore.recordRollback({
          repoId,
          kind: input.kind,
          summary: input.summary,
        });
      },
    );

    // Register /immunity command
    host.registerCommand("immunity", {
      description: "Inspect or reset project negative immunity constraints.",
      handler: async (args) => {
        const trimmed = String(args ?? "").trim().toLowerCase();
        if (trimmed === "clear") {
          await immunityStore.clearRules(repoId);
          return "Cleared all project immunity constraints.";
        }
        const rules = await immunityStore.loadRules(repoId);
        if (rules.length === 0) return "No immunity constraints.";
        return immunityStore.formatPromptSection(rules);
      },
    });

    // 2. Trigger rollback
    const rollbackHandler = host.getCommand("rollback")?.handler;
    expect(rollbackHandler).toBeDefined();
    const rollbackRes = await rollbackHandler!("turn", host.createContext());
    expect(rollbackRes).toContain("Restored src/server.ts");

    // 3. Verify rules in store
    const rules = await immunityStore.loadRules(repoId);
    expect(rules.length).toBe(1);
    expect(rules[0]?.trigger).toBe("rollback_turn");
    expect(rules[0]?.lesson).toContain("src/server.ts");

    // 4. Verify context injector pulls the immunity section
    const injector = new ContextInjector({
      exec: async () => {
        const error = new Error("Command failed: git status --short");
        Object.assign(error, { stderr: "fatal: not a git repository: .git" });
        throw error;
      },
      immunityStore,
      repoId,
    });
    const injectedContext = await injector.inject();
    expect(injectedContext).toContain("[Project Immunity & Negative Constraints]");
    expect(injectedContext).toContain("src/server.ts");

    // 5. Verify /immunity slash command
    const immunityHandler = host.getCommand("immunity")?.handler;
    expect(immunityHandler).toBeDefined();
    const commandOutput = await immunityHandler!("", host.createContext());
    expect(commandOutput).toContain("[Project Immunity & Negative Constraints]");

    // 6. Verify /immunity clear
    const clearOutput = await immunityHandler!("clear", host.createContext());
    expect(clearOutput).toContain("Cleared");
    const rulesAfterClear = await immunityStore.loadRules(repoId);
    expect(rulesAfterClear.length).toBe(0);
  });
});
