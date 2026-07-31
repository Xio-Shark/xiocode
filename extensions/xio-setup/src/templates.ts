/**
 * `xio-setup templates` — distribute project starter files (AGENTS.md,
 * .trellis/spec) into the current workspace.
 *
 * Reuses the retrospective norms allowlist (AGENTS.md | CLAUDE.md |
 * .trellis/spec/**) and the staged WorkspaceMutationService writer — no
 * second path-policy implementation. Existing files are never overwritten;
 * writing requires explicit confirmation (--yes or interactive y/N).
 */

import { access } from "node:fs/promises";
import path from "node:path";

import {
  applyNormsWrites,
  resolveNormsAllowlistPath,
} from "../../xio-evolve/src/retrospective/norms-write.ts";

export type SetupTemplate = Readonly<{
  id: string;
  title: string;
  /** Relative path from workspace root — must pass the norms allowlist. */
  relativePath: string;
  content: string;
}>;

const AGENTS_TEMPLATE = `# AGENTS.md — project guide for coding agents

## Project
<!-- One paragraph: what this project is; main entry points. -->

## Commands
<!-- Build / test / lint commands agents should run before finishing. -->

## Conventions
<!-- Code style, review expectations, things agents must never do. -->
`;

const SPEC_TEMPLATE = `# Project spec — conventions and invariants

<!-- Managed under .trellis/spec: durable project conventions that tasks
     reference. Keep entries short and declarative. -->

## Architecture invariants

## Verification expectations
`;

export const SETUP_TEMPLATES: readonly SetupTemplate[] = [
  {
    id: "agents",
    title: "AGENTS.md starter (project guide for coding agents)",
    relativePath: "AGENTS.md",
    content: AGENTS_TEMPLATE,
  },
  {
    id: "spec",
    title: ".trellis/spec starter (durable project conventions)",
    relativePath: ".trellis/spec/project.md",
    content: SPEC_TEMPLATE,
  },
] as const;

export function getSetupTemplate(id: string): SetupTemplate | undefined {
  return SETUP_TEMPLATES.find((template) => template.id === id);
}

/** Markers that make a directory look like a project/workspace root. */
const WORKSPACE_ROOT_MARKERS = [".git", "package.json", "pyproject.toml", ".trellis"] as const;

export async function isWorkspaceRoot(dir: string): Promise<boolean> {
  for (const marker of WORKSPACE_ROOT_MARKERS) {
    if (await exists(path.join(dir, marker))) return true;
  }
  return false;
}

export type TemplatePlan = Readonly<{
  /** Allowlisted and not yet present — safe to write after confirmation. */
  pending: readonly SetupTemplate[];
  /** Already present in the workspace — never overwritten. */
  skippedExisting: readonly SetupTemplate[];
  /** Failed the allowlist (path escape / outside allowlist). */
  rejected: readonly { template: SetupTemplate; reason: string }[];
}>;

export async function planTemplates(
  workspaceRoot: string,
  templates: readonly SetupTemplate[],
): Promise<TemplatePlan> {
  const pending: SetupTemplate[] = [];
  const skippedExisting: SetupTemplate[] = [];
  const rejected: { template: SetupTemplate; reason: string }[] = [];
  for (const template of templates) {
    const check = resolveNormsAllowlistPath(workspaceRoot, template.relativePath);
    if (!check.ok) {
      rejected.push({ template, reason: check.reason });
      continue;
    }
    if (await exists(check.absolutePath)) {
      skippedExisting.push(template);
      continue;
    }
    pending.push(template);
  }
  return { pending, skippedExisting, rejected };
}

export type TemplateDistributeResult = TemplatePlan & Readonly<{
  written: readonly string[];
}>;

/**
 * Write the plan's pending templates. Does not ask — caller must have
 * obtained confirmation. Rejected/existing entries are reported, not written.
 */
export async function distributeTemplates(
  workspaceRoot: string,
  templates: readonly SetupTemplate[],
): Promise<TemplateDistributeResult> {
  const plan = await planTemplates(workspaceRoot, templates);
  if (plan.pending.length === 0) {
    return { ...plan, written: [] };
  }
  const result = await applyNormsWrites({
    workspaceRoot,
    files: plan.pending.map((template) => ({
      relativePath: template.relativePath,
      content: template.content,
      summary: template.title,
    })),
  });
  if (result.rejected.length > 0) {
    return {
      ...plan,
      pending: [],
      rejected: [
        ...plan.rejected,
        ...result.rejected.map((reason) => ({
          template: plan.pending[0]!,
          reason,
        })),
      ],
      written: [],
    };
  }
  return { ...plan, written: result.written };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
