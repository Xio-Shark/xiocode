import { describe, expect, it } from "vitest";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InvalidTransitionError, reduceTransition, replayPendingEvents } from "../src/run-ledger/reducer.ts";
import {
  failureSignature,
  goalFingerprint,
  ImprovementRunService,
  LedgerClaimError,
  RepeatedFailureStop,
} from "../src/run-ledger/service.ts";
import { LedgerLockError, LedgerStoreError, RunLedgerStore } from "../src/run-ledger/store.ts";
import {
  decodeRunState,
  LedgerDecodeError,
  RUN_STATE_SCHEMA,
  type ImprovementRunState,
} from "../src/run-ledger/types.ts";

import type { ImproveGoal } from "../src/types.ts";

const GOAL: ImproveGoal = {
  id: "goal-1",
  source: "queue",
  title: "improve something",
  prompt: "do the thing",
};

function baseState(overrides: Partial<ImprovementRunState> = {}): ImprovementRunState {
  return {
    schema: RUN_STATE_SCHEMA,
    run_id: "run-1",
    revision: 0,
    goal: {
      id: GOAL.id,
      fingerprint: goalFingerprint(GOAL),
      source: "queue",
      source_ref: null,
      title: GOAL.title,
    },
    attempt: 1,
    parent_run_id: null,
    repository: {
      repo_id: "repo",
      common_dir: "/tmp/repo/.git",
      base_revision: "abc123",
      baseline_tree: null,
    },
    candidate: { worktree_path: null, branch: null, revision: null, base_ref: null, baseline_tree: null },
    phase: "created",
    disposition: "running",
    outcome: null,
    failure_signature: null,
    evidence: {
      verifier_receipt: null,
      private_case_id: null,
      private_status: null,
      eval_id: null,
      capability_status: null,
      merge_receipt: null,
    },
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

async function withTempStore(run: (store: RunLedgerStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-ledger-"));
  try {
    await run(new RunLedgerStore({ root: path.join(root, "runs") }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeService(store: RunLedgerStore, revisions: Record<string, string> = {}): ImprovementRunService {
  return new ImprovementRunService({
    store,
    revisionOf: async (root) => {
      const revision = revisions[root];
      if (!revision) throw new Error(`no revision for ${root}`);
      return revision;
    },
  });
}

describe("run-ledger reducer", () => {
  it("advances the happy path with monotonic revisions", () => {
    let state = baseState();
    for (const to of ["candidate_ready", "applying", "verifying", "awaiting_merge"] as const) {
      const result = reduceTransition(state, { to, reason: `to_${to}` });
      expect(result.state.revision).toBe(state.revision + 1);
      expect(result.event.state_revision).toBe(result.state.revision);
      expect(result.event.from).toBe(state.phase);
      state = result.state;
    }
    const terminal = reduceTransition(state, { to: "terminal", outcome: "merged", reason: "user_approved" });
    expect(terminal.state.outcome).toBe("merged");
    expect(terminal.state.disposition).toBe("done");
  });

  it("rejects skipping phases and merge outcomes outside awaiting_merge", () => {
    expect(() => reduceTransition(baseState(), { to: "verifying", reason: "skip" }))
      .toThrow(InvalidTransitionError);
    expect(() => reduceTransition(baseState(), { to: "terminal", outcome: "merged", reason: "cheat" }))
      .toThrow(/only valid from awaiting_merge/);
    expect(() => reduceTransition(baseState({ phase: "terminal", outcome: "abandoned", disposition: "done" }), {
      to: "candidate_ready",
      reason: "resurrect",
    })).toThrow(/terminal/);
  });

  it("allows failure outcomes from any nonterminal phase and stale retreat", () => {
    const applying = baseState({ phase: "applying" });
    const failed = reduceTransition(applying, { to: "terminal", outcome: "infra_error", reason: "spawn_failed" });
    expect(failed.state.outcome).toBe("infra_error");
    const awaiting = baseState({ phase: "awaiting_merge", disposition: "await_user" });
    const retreat = reduceTransition(awaiting, { to: "verifying", reason: "stale_candidate" });
    expect(retreat.state.phase).toBe("verifying");
  });

  it("keeps terminal outcome when appending audit-only notes", () => {
    const terminal = baseState({ phase: "terminal", outcome: "rejected", disposition: "done", revision: 5 });
    const note = reduceTransition(terminal, { to: "terminal", kind: "note", reason: "archive_note" });
    expect(note.state.outcome).toBe("rejected");
    expect(note.state.revision).toBe(6);
    expect(() => reduceTransition(terminal, { to: "terminal", kind: "override", reason: "no" }))
      .toThrow(/terminal/);
  });

  it("replays pending WAL events and rejects revision gaps", () => {
    const start = baseState();
    const step1 = reduceTransition(start, { to: "candidate_ready", reason: "worktree_created" });
    const step2 = reduceTransition(step1.state, { to: "applying", reason: "agent_started" });
    // State lost the second commit; replay settles it.
    const settled = replayPendingEvents(step1.state, [step1.event, step2.event]);
    expect(settled.revision).toBe(2);
    expect(settled.phase).toBe("applying");
    // A gap (revision 3 directly) fails closed.
    const gapped = { ...step2.event, state_revision: 4 };
    expect(() => replayPendingEvents(step1.state, [gapped])).toThrow(/revision gap/);
  });
});

describe("run-ledger store", () => {
  it("claims run ids atomically via mkdir", async () => {
    await withTempStore(async (store) => {
      const state = baseState();
      expect(await store.createRun(state)).toBe(true);
      expect(await store.createRun(state)).toBe(false);
      expect(await store.listRunIds()).toEqual(["run-1"]);
    });
  });

  it("settles an incomplete transition (event without state replace) on load", async () => {
    await withTempStore(async (store) => {
      const start = baseState();
      await store.createRun(start);
      const step1 = reduceTransition(start, { to: "candidate_ready", reason: "worktree_created" });
      await store.commitTransition(step1.state, step1.event);
      // Simulate crash: append the next event but never replace state.json.
      const step2 = reduceTransition(step1.state, { to: "applying", reason: "agent_started" });
      await appendFile(
        path.join(store.runDir("run-1"), "events.jsonl"),
        `${JSON.stringify(step2.event)}\n`,
        "utf8",
      );
      const { state, repaired } = await store.loadRun("run-1");
      expect(repaired).toBe(true);
      expect(state.phase).toBe("applying");
      expect(state.revision).toBe(2);
      const diagnostics = await store.readDiagnostics("run-1");
      expect(diagnostics.some((entry) => entry.code === "incomplete_transition_settled")).toBe(true);
    });
  });

  it("fails closed on malformed, oversize and symlinked control files", async () => {
    await withTempStore(async (store, root) => {
      const state = baseState();
      await store.createRun(state);
      const statePath = path.join(store.runDir("run-1"), "state.json");
      await writeFile(statePath, "{broken", "utf8");
      await expect(store.loadRun("run-1")).rejects.toThrow(LedgerDecodeError);

      await writeFile(statePath, `{"schema":"xio-improve-run.v2"}`, "utf8");
      await expect(store.loadRun("run-1")).rejects.toThrow(/unsupported schema/);

      await writeFile(statePath, `${JSON.stringify({ pad: "x".repeat(300 * 1024) })}`, "utf8");
      await expect(store.loadRun("run-1")).rejects.toThrow(/bounded read limit/);

      const outside = path.join(root, "outside.json");
      await writeFile(outside, "{}", "utf8");
      await rm(statePath);
      await symlink(outside, statePath);
      await expect(store.loadRun("run-1")).rejects.toThrow(/non-regular control file/);
    });
  });

  it("rejects run ids that escape the ledger root", async () => {
    await withTempStore(async (store) => {
      expect(() => store.runDir("../escape")).toThrow(LedgerStoreError);
      expect(() => store.runDir("a/b")).toThrow(LedgerStoreError);
    });
  });

  it("rejects unknown state fields (future-incompatible schema)", () => {
    const raw = { ...baseState(), surprise: true };
    expect(() => decodeRunState(raw)).toThrow(/unknown field/);
  });

  it("enforces per-run lock against live holders and takes over stale locks", async () => {
    await withTempStore(async (store) => {
      await store.createRun(baseState());
      const release = await store.acquireLock("run-1");
      await expect(store.acquireLock("run-1")).rejects.toThrow(LedgerLockError);
      await release();
      // Stale lock: dead pid is taken over with a diagnostic.
      await writeFile(
        path.join(store.runDir("run-1"), ".lock"),
        `${JSON.stringify({ pid: 999999999, at: "x" })}\n`,
        "utf8",
      );
      const second = await store.acquireLock("run-1");
      await second();
      const diagnostics = await store.readDiagnostics("run-1");
      expect(diagnostics.some((entry) => entry.code === "stale_lock_takeover")).toBe(true);
    });
  });

  it("redacts secrets before persisting state", async () => {
    await withTempStore(async (store) => {
      const secret = `sk-${"abcd".repeat(12)}`;
      const state = baseState({
        goal: { ...baseState().goal, title: `uses ${secret}` },
      });
      await store.createRun(state);
      const raw = await readFile(path.join(store.runDir("run-1"), "state.json"), "utf8");
      expect(raw).not.toContain(secret);
    });
  });
});

describe("goal claim and dedupe", () => {
  const claimInput = {
    goal: GOAL,
    repoId: "repo",
    commonDir: "/tmp/repo/.git",
    baseRevision: "abc123",
  };

  it("claims once, then refuses silent duplicates (active and terminal)", async () => {
    await withTempStore(async (store) => {
      const service = makeService(store);
      const first = await service.claim(claimInput);
      expect(first.state.phase).toBe("created");
      await expect(service.claim(claimInput)).rejects.toThrow(LedgerClaimError);
      await expect(service.claim(claimInput)).rejects.toThrow(/already claimed/);

      const terminal = await service.terminate(first.state, { outcome: "abandoned", reason: "test" });
      expect(terminal.outcome).toBe("abandoned");
      await expect(service.claim(claimInput)).rejects.toThrow(/use retry/);
    });
  });

  it("retry creates a new attempt with lineage and never overwrites the old run", async () => {
    await withTempStore(async (store) => {
      const service = makeService(store);
      const first = await service.claim(claimInput);
      await service.terminate(first.state, { outcome: "verifier_red", reason: "red" });
      await expect(service.claim(claimInput, { retryOf: "missing" })).rejects.toThrow(/does not claim/);
      const retry = await service.claim(claimInput, { retryOf: first.runId });
      expect(retry.state.attempt).toBe(2);
      expect(retry.state.parent_run_id).toBe(first.runId);
      const previous = await service.load(first.runId);
      expect(previous.outcome).toBe("verifier_red");
    });
  });

  it("refuses retry while the previous attempt is still active", async () => {
    await withTempStore(async (store) => {
      const service = makeService(store);
      const first = await service.claim(claimInput);
      await expect(service.claim(claimInput, { retryOf: first.runId })).rejects.toThrow(/still created/);
    });
  });

  it("stops after repeated identical failure signatures unless overridden once", async () => {
    await withTempStore(async (store) => {
      const service = makeService(store);
      const signature = failureSignature({
        goalFingerprint: goalFingerprint(GOAL),
        baseRevision: "abc123",
        candidateRevision: "rev-1",
        failureClass: "verifier_red",
        failedChecks: ["npm run check"],
      });
      let handle = await service.claim(claimInput);
      await service.terminate(handle.state, { outcome: "verifier_red", reason: "red", failureSignature: signature });
      handle = await service.claim(claimInput, { retryOf: handle.runId });
      await service.terminate(handle.state, { outcome: "verifier_red", reason: "red", failureSignature: signature });
      handle = await service.claim(claimInput, { retryOf: handle.runId });
      await service.terminate(handle.state, { outcome: "verifier_red", reason: "red", failureSignature: signature });
      // Third identical failure: manual stop without an explicit override.
      await expect(service.claim(claimInput, { retryOf: handle.runId })).rejects.toThrow(RepeatedFailureStop);
      const overridden = await service.claim(claimInput, {
        retryOf: handle.runId,
        overrideReason: "operator investigated flake",
      });
      expect(overridden.state.attempt).toBe(4);
      const { events } = await store.loadRun(overridden.runId);
      expect(events.some((event) => event.kind === "override" && /operator investigated/.test(event.reason)))
        .toBe(true);
    });
  });
});

describe("evidence receipts and merge eligibility", () => {
  it("blocks merge ask when the candidate changed after verification", async () => {
    await withTempStore(async (store) => {
      const worktree = "/tmp/wt";
      const revisions: Record<string, string> = { [worktree]: "rev-1" };
      const service = makeService(store, revisions);
      let handle = await service.claim({
        goal: GOAL,
        repoId: "repo",
        commonDir: "/tmp/repo/.git",
        baseRevision: "abc123",
      });
      let state = await service.advance(handle.state, {
        to: "candidate_ready",
        reason: "worktree_created",
        candidate: { worktree_path: worktree, branch: "xio/test" },
      });
      state = await service.advance(state, { to: "applying", reason: "agent_started" });
      state = await service.advance(state, { to: "verifying", reason: "apply_finished" });
      const receipt = await service.recordVerifierReceipt(state, {
        worktreePath: worktree,
        revisionBefore: "rev-1",
        commands: ["npm run check"],
        ok: true,
        exitCode: 0,
        output: "all green",
        startedAt: "2026-07-31T00:00:00.000Z",
      });
      expect(receipt.receipt.stale_reasons).toEqual([]);
      state = await service.advance(state, {
        to: "awaiting_merge",
        reason: "verifier_green",
        candidate: { revision: receipt.revisionAfter },
        evidence: { verifier_receipt: receipt.ref },
        evidence_refs: [receipt.ref],
      });

      const fresh = await service.checkMergeEligibility(state);
      expect(fresh.eligible).toBe(true);

      // Candidate mutated after verification: eligibility must go stale.
      revisions[worktree] = "rev-2";
      const stale = await service.checkMergeEligibility(state);
      expect(stale.eligible).toBe(false);
      expect(stale.staleReasons.join("\n")).toMatch(/candidate changed after verification/);

      const continuation = await service.continuation(state, {
        worktreeExists: async () => true,
      });
      expect(continuation.next_action).toMatch(/re-run verifier/);
    });
  });

  it("projects continuation for interrupted apply and missing worktree", async () => {
    await withTempStore(async (store) => {
      const service = makeService(store, { "/tmp/wt": "rev-1" });
      const handle = await service.claim({
        goal: GOAL,
        repoId: "repo",
        commonDir: "/tmp/repo/.git",
        baseRevision: "abc123",
      });
      let state = await service.advance(handle.state, {
        to: "candidate_ready",
        reason: "worktree_created",
        candidate: { worktree_path: "/tmp/wt", branch: "xio/test" },
      });
      state = await service.advance(state, { to: "applying", reason: "agent_started" });

      const interrupted = await service.continuation(state, { worktreeExists: async () => true });
      expect(interrupted.next_action).toMatch(/inspect worktree.*resume.*abandon/i);

      const missing = await service.continuation(state, { worktreeExists: async () => false });
      expect(missing.blockers.some((blocker) => blocker.code === "worktree_missing")).toBe(true);
      expect(missing.next_action).toMatch(/repair or abandon/);
    });
  });
});

describe("fingerprints", () => {
  it("is stable across runs and distinguishes different goals", () => {
    expect(goalFingerprint(GOAL)).toBe(goalFingerprint({ ...GOAL }));
    expect(goalFingerprint(GOAL)).not.toBe(goalFingerprint({ ...GOAL, prompt: "different" }));
    expect(goalFingerprint(GOAL)).not.toBe(goalFingerprint({ ...GOAL, source: "seed" }));
  });

  it("failure signature covers stable facts and check ids", () => {
    const base = {
      goalFingerprint: "fp",
      baseRevision: "abc",
      candidateRevision: "rev-1",
      failureClass: "verifier_red",
      failedChecks: ["a", "b"],
    };
    expect(failureSignature(base)).toBe(failureSignature({ ...base, failedChecks: ["b", "a"] }));
    expect(failureSignature(base)).not.toBe(failureSignature({ ...base, failureClass: "gate_blocked" }));
  });
});
