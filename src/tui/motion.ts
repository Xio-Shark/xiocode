/**
 * Terminal motion primitives for the Ink TUI: shared-phase spinner + stream cursor.
 *
 * All animated chrome derives its frame from one wall-clock (`animClock` in app.ts),
 * so every spinner on screen stays in phase and one timer drives all motion.
 * Frame cadence is 120ms (~8fps) — well above the 60ms flash-safety floor and
 * cheap for Ink's diff renderer.
 */

/** Braille spinner — renders on every modern terminal, single cell wide. */
export const SPINNER_FRAMES: readonly string[] = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
];

/** Spinner frame period; also the busy tick interval of the animation clock. */
export const SPINNER_INTERVAL_MS = 120;

/** Reduced-motion tick: elapsed-seconds labels still update, spinners freeze. */
export const REDUCED_TICK_MS = 1_000;

/** Half-block cursor appended to the live assistant stream (▊ = "still generating"). */
export const STREAM_CURSOR = "▊";

export type MotionEnv = Readonly<Record<string, string | undefined>>;

/**
 * Motion opt-out: dumb terminals get no animation frames; users can force it
 * off with XIO_ANIMATION=off (reduced-motion preference, WCAG 2.2.2).
 */
export function motionEnabled(env: MotionEnv = process.env): boolean {
  if (env["TERM"] === "dumb") return false;
  const pref = env["XIO_ANIMATION"]?.toLowerCase();
  if (pref === "off" || pref === "none" || pref === "reduced") return false;
  return true;
}

/** Time-phased spinner frame; same `now` ⇒ same frame everywhere on screen. */
export function spinnerFrameAt(now: number, frames: readonly string[] = SPINNER_FRAMES): string {
  const index = Math.floor(now / SPINNER_INTERVAL_MS) % frames.length;
  return frames[index] ?? frames[0] ?? "";
}
