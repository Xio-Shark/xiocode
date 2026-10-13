import path from "node:path";
import { realpath } from "node:fs/promises";

import {
  WorkspacePathError,
  WorkspacePathPolicy,
} from "../../../src/runtime/workspace-path-policy.ts";

/**
 * Shared WorkspacePathPolicy for hygiene project-resource loaders.
 * Always keyed by the workspace cwd, plus explicit optional user-global roots.
 * Callers that skip project files must simply not request those paths — AGENTS
 * @imports are the exception and build a tighter policy in agents-md.ts.
 */
export async function createHygieneResourcePolicy(input: Readonly<{
  cwd: string;
  home: string;
  includeUserClaude?: boolean;
  includeUserCursor?: boolean;
  /** Authorize files directly under home (e.g. `~/.claude.json`). */
  includeUserHome?: boolean;
  includeUserSkills?: boolean;
}>): Promise<WorkspacePathPolicy> {
  const cwd = path.resolve(input.cwd);
  const home = path.resolve(input.home);
  const additionalRoots: Array<{ id: string; path: string; optional: boolean }> = [];

  if (input.includeUserClaude !== false) {
    additionalRoots.push({
      id: "user-claude",
      path: path.join(home, ".claude"),
      optional: true,
    });
  }
  if (input.includeUserCursor) {
    additionalRoots.push({
      id: "user-cursor",
      path: path.join(home, ".cursor"),
      optional: true,
    });
  }
  if (input.includeUserSkills) {
    // The user-global skill root is an explicit trust root, like ~/.claude
    // itself. Project skill roots remain children of the workspace policy.
    additionalRoots.push({ id: "user-skills", path: path.join(home, ".claude", "skills"), optional: true });
  }
  if (input.includeUserHome) {
    additionalRoots.push({
      id: "user-home",
      path: home,
      optional: true,
    });
  }

  return WorkspacePathPolicy.create({
    workspaceRoot: cwd,
    cwd,
    additionalRoots,
  });
}

/** User-selected global config files may be links; repository files may not. */
export async function readUserResourceText(filePath: string): ReturnType<typeof readAuthorizedResourceText> {
  try {
    const canonicalPath = await realpath(filePath);
    const policy = await WorkspacePathPolicy.create({ workspaceRoot: path.dirname(canonicalPath) });
    return await readAuthorizedResourceText(policy, canonicalPath);
  } catch (error) {
    return resourceReadError(error);
  }
}

export async function readAuthorizedResourceText(
  policy: WorkspacePathPolicy,
  filePath: string,
): Promise<
  | Readonly<{ ok: true; text: string; canonicalPath: string }>
  | Readonly<{ ok: false; code: string; message: string }>
> {
  try {
    const checked = await policy.resolve("project-resource", filePath);
    const text = (await policy.readProjectResource(filePath)).toString("utf8");
    return { ok: true, text, canonicalPath: checked.canonicalPath };
  } catch (error) {
    return resourceReadError(error);
  }
}

function resourceReadError(error: unknown): Readonly<{ ok: false; code: string; message: string }> {
  const code = error instanceof WorkspacePathError ? error.code
    : error && typeof error === "object" && "code" in error ? String(error.code) : "PATH_IO";
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}

export function isMissingResource(result: Readonly<{ ok: false; code: string }>): boolean {
  return result.code === "NOT_FOUND" || result.code === "ENOENT";
}
