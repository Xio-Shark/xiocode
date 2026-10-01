/**
 * Reusing a verification result only while it is still true.
 *
 * A done-contract command that passed is recorded together with what it read
 * (kernel read evidence). Before running it again, the kernel is asked whether
 * that result still describes the workspace. Only `fresh` lets the earlier
 * pass stand; `stale` and `unknown` both mean: run it again.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { EvidenceStatus } from "@xioflow/kernel";

export const EVIDENCE_EVENT = "XIOCODE_EVIDENCE";

export type CommandEvidence = Readonly<{
  /** The earlier passing result was kept; the command did not run this time. */
  reused: boolean;
  /** What the kernel said about the earlier passing result, when there was one. */
  previous?: EvidenceStatus;
}>;

export function evidenceKey(argv: readonly string[], cwd: string): string {
  return createHash("sha256").update(JSON.stringify([argv, cwd])).digest("hex").slice(0, 32);
}

const PYTHON_RUNNERS = /^(python(\d+(\.\d+)?)?|pytest|py\.test)$/;

/**
 * A command that finds a valid cache entry only stats the source and never
 * reads it, so the source is missing from its read set. For runners where we
 * know how to take that cache out of the way, do so and tell the kernel
 * (`statCaches: "ruled_out"`); for every other command the kernel keeps
 * answering `unknown` when files outside the read set changed.
 *
 * Python: bytecode goes to (and is looked up in) an empty directory, so every
 * imported module is compiled from its source. This is the configuration the
 * read-set measurements were made with; it costs the compile time on each run.
 */
export function withoutStatCaches(argv: readonly string[], env: NodeJS.ProcessEnv): Readonly<{
  env: NodeJS.ProcessEnv;
  statCaches?: "ruled_out";
  dispose: () => void;
}> {
  if (!PYTHON_RUNNERS.test(path.basename(argv[0] ?? ""))) return { env, dispose: () => {} };
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "xio-pycache-"));
  return {
    env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: emptyCache },
    statCaches: "ruled_out",
    dispose: () => fs.rmSync(emptyCache, { recursive: true, force: true }),
  };
}

/** One clause for the done-contract summary; empty when there is nothing to say about evidence. */
export function describeEvidence(evidence: CommandEvidence | undefined, cwd: string): string {
  if (!evidence) return "";
  const previous = evidence.previous;
  if (evidence.reused) {
    return previous?.status === "fresh" && previous.basis === "reads_unchanged"
      ? " (not re-run: nothing it read has changed since it passed)"
      : " (not re-run: nothing in the workspace has changed since it passed)";
  }
  if (previous?.status === "stale") {
    // The kernel reports resolved paths; resolve cwd the same way before making them relative.
    const base = fs.realpathSync(cwd);
    const shown = previous.changed.slice(0, 3).map((file) => path.relative(base, file) || ".").join(", ");
    const more = previous.changed.length > 3 || previous.truncated ? ", …" : "";
    return ` (re-run: ${shown}${more} changed since the last pass)`;
  }
  if (previous?.status === "unknown" && (previous.reason === "changed_outside_read_set" || previous.reason === "reads_unobserved")) {
    return " (re-run: files changed since the last pass, and it cannot be shown that this command does not depend on them)";
  }
  return "";
}
