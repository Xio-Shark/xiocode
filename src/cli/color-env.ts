/**
 * no-color.org support.
 *
 * chalk 5 (inlined into Ink) honours FORCE_COLOR only; NO_COLOR is not read at
 * all. Translate the convention before Ink is imported — importing this module
 * for its side effect from the CLI entry is enough.
 */

/** Set FORCE_COLOR=0 when NO_COLOR is present and FORCE_COLOR was not chosen explicitly. */
export function applyNoColorEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env["NO_COLOR"]) return;
  if (env["FORCE_COLOR"] !== undefined) return;
  env["FORCE_COLOR"] = "0";
}

applyNoColorEnv();
