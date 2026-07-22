/**
 * parallel-plan.v1 — Trellis DAG plan artifact produced by xiocode under ultra.
 * XioCode only drafts + handoff; Trellis owns import/dispatch/integrate.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PLAN_DIR } from "./types.ts";

export const PARALLEL_PLAN_VERSION = "parallel-plan.v1" as const;
export const PARALLEL_PLAN_FILE = "parallel-plan.json";

export type ParallelPlanChild = Readonly<{
  slug: string;
  title: string;
  description?: string;
  depends_on: readonly string[];
  isolation?: "worktree" | "shared";
  write_scope?: readonly string[];
  verify?: string;
}>;

export type ParallelPlanV1 = Readonly<{
  version: typeof PARALLEL_PLAN_VERSION;
  parent?: Readonly<{ slug?: string; title?: string; priority?: string }>;
  children: readonly ParallelPlanChild[];
}>;

export type TrellisPresence = Readonly<{
  hasTrellis: boolean;
  hasGit: boolean;
  taskPy: string;
}>;

export async function detectTrellis(workspaceRoot: string): Promise<TrellisPresence> {
  const root = path.resolve(workspaceRoot);
  const taskPy = path.join(root, ".trellis", "scripts", "task.py");
  const gitDir = path.join(root, ".git");
  const hasTrellis = await exists(taskPy);
  const hasGit = await exists(gitDir);
  return { hasTrellis, hasGit, taskPy };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function parallelPlanPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), PLAN_DIR, PARALLEL_PLAN_FILE);
}

export function validateParallelPlan(raw: unknown): { ok: true; plan: ParallelPlanV1 } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["plan root must be an object"] };
  }
  const data = raw as Record<string, unknown>;
  if (data.version !== PARALLEL_PLAN_VERSION) {
    errors.push(`version must be ${PARALLEL_PLAN_VERSION}`);
  }
  if (!Array.isArray(data.children) || data.children.length === 0) {
    errors.push("children must be a non-empty array");
    return { ok: false, errors };
  }
  const slugs = new Set<string>();
  const children: ParallelPlanChild[] = [];
  for (let i = 0; i < data.children.length; i++) {
    const c = data.children[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`children[${i}] must be an object`);
      continue;
    }
    const row = c as Record<string, unknown>;
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!slug) errors.push(`children[${i}]: slug required`);
    if (!title) errors.push(`children[${i}]: title required`);
    if (slug && slugs.has(slug)) errors.push(`duplicate slug: ${slug}`);
    if (slug) slugs.add(slug);
    const isolation = row.isolation;
    if (isolation !== undefined && isolation !== "worktree" && isolation !== "shared") {
      errors.push(`children[${i}]: isolation must be worktree|shared`);
    }
    const depends_on = Array.isArray(row.depends_on)
      ? row.depends_on.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      : [];
    const write_scope = Array.isArray(row.write_scope)
      ? row.write_scope.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      : undefined;
    if (isolation === "worktree" && (!write_scope || write_scope.length === 0)) {
      errors.push(`children[${i}] (${slug}): isolation=worktree requires write_scope`);
    }
    children.push({
      slug,
      title,
      description: typeof row.description === "string" ? row.description : undefined,
      depends_on,
      isolation: isolation === "worktree" || isolation === "shared" ? isolation : undefined,
      write_scope,
      verify: typeof row.verify === "string" ? row.verify : undefined,
    });
  }
  for (const child of children) {
    for (const dep of child.depends_on) {
      if (!slugs.has(dep)) {
        errors.push(`${child.slug}: depends_on unknown sibling ${dep}`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      version: PARALLEL_PLAN_VERSION,
      parent: data.parent && typeof data.parent === "object" && !Array.isArray(data.parent)
        ? (data.parent as ParallelPlanV1["parent"])
        : undefined,
      children,
    },
  };
}

export async function writeParallelPlan(
  workspaceRoot: string,
  plan: ParallelPlanV1,
): Promise<string> {
  const out = parallelPlanPath(workspaceRoot);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return out;
}

export function formatParallelPlanHandoff(parentDirHint = "<parent-dir>"): string {
  return [
    "Trellis handoff (do **not** auto-run unless the user confirms):",
    `  python3 .trellis/scripts/task.py plan-import ${parentDirHint} .claude/plan/parallel-plan.json`,
    `  python3 .trellis/scripts/task.py plan-import ${parentDirHint} .claude/plan/parallel-plan.json --yes`,
    `  python3 .trellis/scripts/task.py dispatch-ready ${parentDirHint} --yes`,
  ].join("\n");
}

export function formatTrellisDegradeNotice(presence: TrellisPresence): string {
  if (!presence.hasTrellis && !presence.hasGit) {
    return "并行写码派发不可用：当前目录无 `.trellis/` 且不是 git 仓库。回退串行改码（或仅用 explore 只读探索）。";
  }
  if (!presence.hasTrellis) {
    return "并行写码派发不可用：未检测到 `.trellis/scripts/task.py`。回退串行改码；explore 只读并发仍可用。";
  }
  if (!presence.hasGit) {
    return "并行写码派发降级：有 Trellis 但无 git，无法预建 worktree。可产出 parallel-plan 草案，但 isolation=worktree 物化会失败；优先 shared/串行。";
  }
  return "";
}

/** Injected when thinking=ultra and Trellis is present. */
export const ULTRA_PARALLEL_PLAN_ADDENDUM = [
  "## Ultra → Trellis parallel-plan.v1",
  "When thinking=ultra and the task is multi-file / multi-deliverable (not a trivial single-file fix):",
  "1. Decompose into independently verifiable children with `depends_on`, `isolation`, and `write_scope`.",
  "2. Write-domain overlap between edge-free siblings → add a depends_on edge or merge tasks.",
  "3. Persist the draft via `plan` action=`parallel_draft` (or write `.claude/plan/parallel-plan.json`).",
  "4. Show the user the one-command Trellis handoff (`task.py plan-import …`); **never** auto-spawn workers.",
  "5. Schema version must be `parallel-plan.v1`. XioCode does not own ready/depends_on/dispatch — Trellis does.",
  "If `.trellis/` or git is missing, say so explicitly and stay serial / explore-only.",
].join("\n");
