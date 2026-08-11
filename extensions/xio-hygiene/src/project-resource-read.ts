import path from "node:path";

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
    if (error instanceof WorkspacePathError) {
      return { ok: false, code: error.code, message: error.message };
    }
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "PATH_IO";
    return {
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isMissingResource(result: Readonly<{ ok: false; code: string }>): boolean {
  return result.code === "NOT_FOUND" || result.code === "ENOENT";
}
