import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { MergeGate } from "./merge-gate.ts";
import { WorktreeSandbox } from "./worktree-sandbox.ts";

import type { AskFn } from "./merge-gate.ts";
import type { WorktreeConfig, WorktreeSession } from "./worktree-sandbox.ts";
import type { XioExtensionAPI } from "../../../src/runtime/index.ts";

export type SandboxExtensionOptions = Readonly<{
  enabled?: boolean;
  session?: WorktreeSession;
  worktreeConfig?: WorktreeConfig;
  mergeGate?: MergeGate;
  ask?: AskFn;
}>;

export function registerXioSandbox(api: XioExtensionAPI, options: SandboxExtensionOptions = {}): SandboxExtensionOptions {
  const enabled = options.enabled ?? true;
  if (!enabled || !options.session) {
    return { enabled: false };
  }

  const gate = options.mergeGate ?? new MergeGate(options.session);

  api.on("session_start", (_event, ctx) => {
    ctx?.ui?.setStatus?.("xio-sandbox", `worktree ${options.session!.sessionId}`);
    ctx?.ui?.notify?.(
      `Worktree sandbox: ${options.session!.worktreePath}`,
      "info",
    );
  });

  api.registerCommand("sandbox", {
    description: "Show XioCode worktree sandbox status.",
    handler: async (_args, ctx) => {
      const session = gate.session;
      const dirty = await WorktreeSandbox.hasUnmergedChanges(session);
      const merged = gate.merged || await WorktreeSandbox.isMerged(session);
      const text = `worktree=${session.worktreePath} branch=${session.branch} merged=${merged} dirty=${dirty}`;
      ctx?.ui?.setStatus?.("xio-sandbox", merged ? "merged" : dirty ? "dirty" : "clean");
      ctx?.ui?.notify?.(text, "info");
      return text;
    },
  });

  return {
    enabled: true,
    session: options.session,
    worktreeConfig: options.worktreeConfig,
    mergeGate: gate,
    ask: options.ask,
  };
}

export async function defaultAsk(question: string): Promise<boolean> {
  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export { MergeGate } from "./merge-gate.ts";
export { WorktreeSandbox, DEFAULT_WORKTREE_CONFIG } from "./worktree-sandbox.ts";
export type { DiffSummary, MergeResult, AskFn } from "./merge-gate.ts";
export type { WorktreeSession, WorktreeConfig, WorktreeCreateOptions } from "./worktree-sandbox.ts";
