/**
 * parallel_dispatch — one-confirm automated execution of the Trellis handoff.
 *
 * XioCode still owns none of the scheduling (ready/depends_on/dispatch live in
 * Trellis's task.py); this module shells out to it after explicit user
 * confirmation and streams progress into the session UI. Two human gates:
 * 1. approve the dispatch (task groups, write scopes, isolation shown first);
 * 2. approve the final merge of the integrated result into the target branch.
 * Declining either gate leaves the manual handoff commands as the fallback.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  detectTrellis,
  formatParallelPlanHandoff,
  formatTrellisDegradeNotice,
  parallelPlanPath,
  validateParallelPlan,
  type ParallelPlanV1,
} from "./parallel-plan.ts";

/** Same shape as xio-sandbox AskFn; declared locally to keep runtime→extensions clean. */
export type PlanAskFn = (question: string, detail?: string) => Promise<boolean>;

export type ParallelDispatchOptions = Readonly<{
  workspaceRoot: string;
  ask: PlanAskFn;
  notify?: (message: string, level?: string) => unknown;
  signal?: AbortSignal;
  /** Parent task dir hint passed to plan-import (created when missing). */
  parentHint?: string;
  /** Wall clock cap for the dispatch-ready phase. Default 30 minutes. */
  dispatchTimeoutMs?: number;
}>;

export type ParallelDispatchResult = Readonly<{
  ok: boolean;
  message: string;
}>;

const DEFAULT_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;
const STEP_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_LIMIT = 60;
const FORWARD_PATTERN =
  /ready:|blocked:|failed|running:|worker spawned|completed|verify|merg|integrat|Imported|Dry-run|ERROR|WARN|conflict|outside write_scope/i;

type TaskPyResult = Readonly<{ code: number; tail: string; stdoutLines: string[] }>;

async function runTaskPy(
  args: readonly string[],
  options: Readonly<{
    workspaceRoot: string;
    notify?: (message: string, level?: string) => unknown;
    signal?: AbortSignal;
    timeoutMs: number;
  }>,
): Promise<TaskPyResult> {
  return await new Promise((resolve) => {
    // detached: task.py re-spawns dispatch.py as a grandchild; killing the
    // process group on abort/timeout reaps both instead of orphaning the
    // dispatcher mid-run (spawned workers intentionally survive in their own
    // sessions — dispatch-ready can be re-run to pick the waves back up).
    const child = spawn(
      "python3",
      [path.join(".trellis", "scripts", "task.py"), ...args],
      {
        cwd: options.workspaceRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const killTree = () => {
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // group already gone — fall through to the direct kill
        }
      }
      child.kill("SIGTERM");
    };
    const tail: string[] = [];
    const stdoutLines: string[] = [];
    let settled = false;

    const pushLine = (line: string, fromStdout: boolean) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      tail.push(trimmed);
      if (tail.length > TAIL_LIMIT) tail.shift();
      if (fromStdout) stdoutLines.push(trimmed);
      if (FORWARD_PATTERN.test(trimmed)) {
        options.notify?.(`[trellis] ${stripAnsi(trimmed)}`, "info");
      }
    };

    const makeLineReader = (fromStdout: boolean) => {
      let buffer = "";
      return (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          pushLine(buffer.slice(0, idx), fromStdout);
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      };
    };
    child.stdout.on("data", makeLineReader(true));
    child.stderr.on("data", makeLineReader(false));

    const finish = (code: number, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (note) tail.push(note);
      resolve({ code, tail: tail.map(stripAnsi).join("\n"), stdoutLines });
    };

    const timer = setTimeout(() => {
      killTree();
      finish(-1, `timed out after ${Math.round(options.timeoutMs / 1000)}s`);
    }, options.timeoutMs);
    const onAbort = () => {
      killTree();
      finish(-1, "aborted");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish(-1, `spawn failed: ${error.message}`));
    child.on("close", (code) => finish(code ?? -1));
  });
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function planSummary(plan: ParallelPlanV1): string {
  // Everything the approver is authorizing must be visible here — including
  // the verify commands, which run as shell with the user's permissions.
  const lines = plan.children.map((child) => {
    const deps = child.depends_on.length ? child.depends_on.join(",") : "-";
    const scope = child.write_scope?.length ? child.write_scope.join(", ") : "(unrestricted)";
    const verify = child.verify ? `\n  verify: ${child.verify}` : "";
    return `${child.slug} [${child.isolation ?? "worktree"}] deps:${deps} scope: ${scope}${verify}`;
  });
  return lines.join("\n");
}

export async function runParallelDispatch(
  options: ParallelDispatchOptions,
): Promise<ParallelDispatchResult> {
  const presence = await detectTrellis(options.workspaceRoot);
  if (!presence.hasTrellis || !presence.hasGit) {
    return { ok: false, message: formatTrellisDegradeNotice(presence) };
  }

  const planFile = parallelPlanPath(options.workspaceRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `parallel_dispatch: cannot read ${planFile} (${message}) — run parallel_draft first`,
    };
  }
  const checked = validateParallelPlan(raw);
  if (!checked.ok) {
    return { ok: false, message: `parallel_dispatch: plan invalid: ${checked.errors.join("; ")}` };
  }
  const plan = checked.plan;
  const parentHint = options.parentHint?.trim()
    || plan.parent?.slug
    || "parallel";
  const planRel = path.relative(path.resolve(options.workspaceRoot), planFile) || planFile;

  // ---- Gate 1: approve the dispatch ----
  const approved = await options.ask(
    `Dispatch ${plan.children.length} parallel Trellis worker(s) with isolated worktrees?`,
    planSummary(plan),
  );
  if (!approved) {
    return {
      ok: false,
      message: [
        "parallel dispatch declined — manual handoff:",
        formatParallelPlanHandoff(parentHint),
      ].join("\n"),
    };
  }

  const common = { workspaceRoot: options.workspaceRoot, notify: options.notify };
  const importResult = await runTaskPy(
    ["plan-import", parentHint, planRel, "--yes"],
    { ...common, signal: options.signal, timeoutMs: STEP_TIMEOUT_MS },
  );
  if (importResult.code !== 0) {
    return { ok: false, message: `plan-import failed:\n${importResult.tail}` };
  }
  // plan-import prints the parent task dir as its last stdout line for chaining.
  const parentRel = importResult.stdoutLines.at(-1) ?? parentHint;
  options.notify?.(`[trellis] imported → ${parentRel}`, "info");

  const dispatchResult = await runTaskPy(
    ["dispatch-ready", parentRel, "--yes"],
    {
      ...common,
      signal: options.signal,
      timeoutMs: options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
    },
  );
  if (dispatchResult.code !== 0) {
    return {
      ok: false,
      message: [
        "dispatch-ready failed (fail-closed — dependents stay blocked):",
        dispatchResult.tail,
        `Retry manually: python3 .trellis/scripts/task.py dispatch-ready ${parentRel} --yes`,
      ].join("\n"),
    };
  }

  const reviewResult = await runTaskPy(
    ["integrate", parentRel],
    { ...common, signal: options.signal, timeoutMs: STEP_TIMEOUT_MS },
  );
  if (reviewResult.code !== 0) {
    return { ok: false, message: `integrate (review) failed:\n${reviewResult.tail}` };
  }

  // ---- Gate 2: approve the final merge ----
  const mergeApproved = await options.ask(
    "All workers finished and the integrated tree verified green. Merge into the target branch?",
    reviewResult.tail,
  );
  if (!mergeApproved) {
    return {
      ok: true,
      message: [
        "integration branch kept, final merge skipped (human gate).",
        `Apply later: python3 .trellis/scripts/task.py integrate ${parentRel} --yes`,
      ].join("\n"),
    };
  }

  const mergeResult = await runTaskPy(
    ["integrate", parentRel, "--yes"],
    { ...common, signal: options.signal, timeoutMs: STEP_TIMEOUT_MS },
  );
  if (mergeResult.code !== 0) {
    return { ok: false, message: `final merge failed:\n${mergeResult.tail}` };
  }
  return {
    ok: true,
    message: [
      `parallel dispatch complete: ${plan.children.length} task(s) merged via ${parentRel}.`,
      mergeResult.tail.split("\n").slice(-6).join("\n"),
    ].join("\n"),
  };
}
