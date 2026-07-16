/**
 * Zero-dependency interactive boot chrome.
 * Mounts before Ink is imported so first_frame can stay under cold-start budgets.
 * Keystrokes buffer here and are drained into BootInputBuffer / App later.
 */

import { writeSync } from "node:fs";

import { XIO_VERSION } from "../cli/version.ts";
import { getGlobalTracer } from "../runtime/perf/index.ts";
import { formatShortCwd } from "./theme.ts";
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
  write?: (chunk: string) => void;
  /** Capture stdin raw data (default: when stdin is TTY or boot-exit measure). */
  captureInput?: boolean;
}>;

/**
 * Print operable boot chrome immediately and optionally buffer stdin.
 * Does not import Ink/React.
 */
export function startEarlyBoot(options: StartEarlyBootOptions): EarlyBootHandle {
  const env = options.env ?? process.env;
  const version = options.version ?? XIO_VERSION;
  const write = options.write ?? ((chunk: string) => {
    writeSync(process.stdout.fd, chunk);
  });
  const bootExit = env.XIO_PERF_BOOT_EXIT === "1";
  const captureInput = options.captureInput
    ?? (process.stdin.isTTY === true || bootExit);

  let text = "";
  let pendingSubmit = false;
  let unmounted = false;
  let status = "starting…";

  const paintChrome = () => {
    // Single compact frame; rewritten only on status change (no full clear).
    write(
      `◆ XioCode v${version}\n`
      + `  ${formatShortCwd(options.cwd)} · ${status}\n`
      + `› ${text}${pendingSubmit ? " ↵" : ""}\n`
      + (pendingSubmit
        ? `  Buffered · will send when session is ready\n`
        : `  Starting… input is buffered until ready\n`),
    );
  };

  paintChrome();

  const tracer = getGlobalTracer(env);
  const paint = tracer?.start("tui.paint", { attrs: { phase: "early_boot" } });
  let resolveFrame: (() => void) | undefined;
  let frameDone = false;
  const framePromise = new Promise<void>((resolve) => {
    resolveFrame = resolve;
  });

  // Mark first operable frame on next tick (stdout flush + listener attached).
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
        // Ctrl+C — leave handling to later session; still record nothing.
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
        // Simulate Enter so buffer.pendingSubmit is set.
        buffer.applyKey("", { return: true });
      }
      text = "";
      pendingSubmit = false;
    },
    setStatus(next) {
      status = next;
      // Avoid flooding during prepare; only update if still mounted.
      if (!unmounted) {
        // Status line only (no full chrome rewrite flood) — one compact line.
        write(`  … ${status}\n`);
      }
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
