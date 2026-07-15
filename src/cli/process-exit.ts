/**
 * Finish the interactive CLI so residual handles cannot pin the event loop.
 *
 * MCP stdio close is best-effort force-killed in xio-hygiene; this is the final
 * backstop so the shell always regains the prompt after agent work returns.
 *
 * Set XIO_NO_FORCE_EXIT=1 to leave exit to Node (tests / embedding).
 */
export function exitCli(
  code: number,
  env: NodeJS.ProcessEnv = process.env,
): never | void {
  const exitCode = Number.isInteger(code) ? code : 1;
  process.exitCode = exitCode;
  if (env.XIO_NO_FORCE_EXIT === "1" || env.XIO_NO_FORCE_EXIT === "true") {
    return;
  }
  process.exit(exitCode);
}

/**
 * Soft backstop: if something still holds the loop after a short grace, exit.
 * Prefer {@link exitCli} for the normal agent path.
 */
export function scheduleForceExit(
  code: number,
  graceMs = 2_000,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.XIO_NO_FORCE_EXIT === "1" || env.XIO_NO_FORCE_EXIT === "true") {
    return;
  }
  const ms = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 2_000;
  const exitCode = Number.isInteger(code) ? code : 1;
  setTimeout(() => {
    process.exit(exitCode);
  }, ms);
}
