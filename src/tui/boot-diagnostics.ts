/**
 * Interactive boot diagnostics.
 *
 * Extension and MCP setup warn through `console.warn` while the boot frame owns
 * the alternate screen. Those lines land above the brand header, break the
 * layout, and are the brightest text on screen. Collect them for the duration
 * of boot, then replay one collapsed notice into the App once it mounts.
 */

const CAPTURE_LIMIT = 32;

export type BootDiagnostics = Readonly<{
  /** Buffered warnings, oldest first. */
  take: () => readonly string[];
  /** Restore the original console.warn; idempotent. */
  restore: () => void;
}>;

export function captureBootDiagnostics(
  target: Pick<Console, "warn"> = console,
  limit: number = CAPTURE_LIMIT,
): BootDiagnostics {
  const original = target.warn;
  const messages: string[] = [];
  target.warn = (...args: unknown[]) => {
    if (messages.length < limit) {
      messages.push(args.map(formatWarning).join(" "));
    }
  };
  let restored = false;
  return {
    take: () => messages.slice(),
    restore: () => {
      if (restored) return;
      target.warn = original;
      restored = true;
    },
  };
}

function formatWarning(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Process-wide collector: extension setup warns before runInkSession exists. */
let active: BootDiagnostics | undefined;

/**
 * Begin buffering as early as the process knows it owns a terminal. Extension
 * and MCP setup runs before the Ink session is created, so this must be called
 * from the entry, not from the TUI. No-op when stderr is not a TTY.
 */
export function beginBootDiagnostics(): void {
  if (active) return;
  if (process.stderr.isTTY !== true) return;
  active = captureBootDiagnostics();
  // If the run never reaches the App (CLI error, one-shot prompt), hand the
  // buffered lines back instead of swallowing them.
  process.once("exit", () => {
    const rest = takeBootDiagnostics();
    for (const message of rest) process.stderr.write(`${message}\n`);
  });
}

/** Stop buffering and return what was collected; callers decide where it goes. */
export function takeBootDiagnostics(): readonly string[] {
  const collected = active?.take() ?? [];
  active?.restore();
  active = undefined;
  return collected;
}
