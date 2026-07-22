/**
 * Zero-dependency interactive boot chrome.
 * Mounts before Ink is imported so first_frame can stay under cold-start budgets.
 * Keystrokes buffer here and are drained into BootInputBuffer / App later.
 *
 * Visual chrome is intentionally silent: status lines used to append into the
 * parent shell scrollback. Ink boot (alternate screen) owns the logo + status.
 */

import { XIO_VERSION } from "../cli/version.ts";
import { getGlobalTracer } from "../runtime/perf/tracer.ts";
import type { BootInputBuffer } from "./boot-shell.ts";

export type EarlyBootHandle = Readonly<{
  /** Drain captured text (may include pending Enter as trailing submit flag). */
  drain: () => Readonly<{ text: string; pendingSubmit: boolean }>;
  /** Transfer buffered keys into a BootInputBuffer (for Ink shell handoff). */
  transferTo: (buffer: BootInputBuffer) => void;
  setStatus: (status: string) => void;
  unmount: () => void;
  firstFrameReady: () => Promise<void>;
}>;

export type StartEarlyBootOptions = Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  /** @deprecated Ignored — early boot no longer paints into the shell buffer. */
  write?: (chunk: string) => void;
  /** Capture stdin raw data (default: when stdin is TTY or boot-exit measure). */
  captureInput?: boolean;
}>;

/**
 * Buffer stdin for first_frame without painting shell scrollback.
 * Ink BootShell / App (alternate screen) show brand + status under the logo.
 */
export function startEarlyBoot(options: StartEarlyBootOptions): EarlyBootHandle {
  const env = options.env ?? process.env;
  const version = options.version ?? XIO_VERSION;
  void version;
  void options.cwd;
  const bootExit = env.XIO_PERF_BOOT_EXIT === "1";
  const captureInput = options.captureInput
    ?? (process.stdin.isTTY === true || bootExit);

  let text = "";
  let pendingSubmit = false;
  let unmounted = false;
  let status = "starting…";
  void status;

  const tracer = getGlobalTracer(env);
  const paint = tracer?.start("tui.paint", { attrs: { phase: "early_boot" } });
  let resolveFrame: (() => void) | undefined;
  let frameDone = false;
  const framePromise = new Promise<void>((resolve) => {
    resolveFrame = resolve;
  });

  // Mark first operable frame on next tick (listener attached; no shell paint).
  queueMicrotask(() => {
    if (unmounted) {
      resolveFrame?.();
      return;
    }
    tracer?.end(paint, "success");
    if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
      tracer?.mark("first_frame", "success", {
        attrs: {
          ui: "early_boot",
          operable: true,
          interactive: true,
          silent: true,
          ...(bootExit ? { boot_exit: true } : {}),
        },
      });
    }
    frameDone = true;
    resolveFrame?.();
  });

  const onData = (chunk: Buffer | string) => {
    if (unmounted) return;
    const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const ch of raw) {
      if (ch === "\u0003") {
        continue;
      }
      if (ch === "\u007f" || ch === "\b") {
        text = text.slice(0, -1);
        pendingSubmit = false;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (text.trim().length > 0) {
          pendingSubmit = true;
        }
        continue;
      }
      if (ch >= " " || ch === "\t") {
        text += ch;
        pendingSubmit = false;
      }
    }
  };

  if (captureInput && process.stdin.readable) {
    process.stdin.resume();
    process.stdin.on("data", onData);
  }

  return {
    drain() {
      const snap = { text, pendingSubmit };
      text = "";
      pendingSubmit = false;
      return snap;
    },
    transferTo(buffer) {
      if (text.length > 0) {
        buffer.setText(text);
      }
      if (pendingSubmit && text.trim().length > 0) {
        buffer.applyKey("", { return: true });
      }
      text = "";
      pendingSubmit = false;
    },
    setStatus(next) {
      // Status is shown by Ink BootShell under the logo — do not append to shell.
      status = next;
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      if (captureInput) {
        process.stdin.off("data", onData);
      }
      if (!frameDone) {
        resolveFrame?.();
      }
    },
    firstFrameReady: () => framePromise,
  };
}
