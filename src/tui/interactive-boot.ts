/**
 * Early interactive boot controller: mount operable Ink chrome before
 * prepareLaunch / prepareSession so first_frame reflects real UI readiness.
 */

import React from "react";
import { render, type Instance } from "ink";

import { XIO_VERSION } from "../cli/version.ts";
import { getGlobalTracer } from "../runtime/perf/index.ts";
import { BootInputBuffer, BootShell, type BootReadiness } from "./boot-shell.ts";

export type InteractiveBootHandle = Readonly<{
  buffer: BootInputBuffer;
  setStatus: (readiness: BootReadiness, status: string) => void;
  unmount: () => void;
  /** True after the first operable paint and first_frame mark. */
  firstFrameReady: () => Promise<void>;
}>;

export type StartInteractiveBootOptions = Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  captureInput?: boolean;
}>;

/**
 * Mount boot shell immediately. Callers should await `firstFrameReady()` before
 * heavy work if they need first_frame ordered before prepareLaunch.
 */
export function startInteractiveBoot(options: StartInteractiveBootOptions): InteractiveBootHandle {
  const env = options.env ?? process.env;
  const version = options.version ?? XIO_VERSION;
  const buffer = new BootInputBuffer();
  const tracer = getGlobalTracer(env);
  const bootExit = env.XIO_PERF_BOOT_EXIT === "1";
  const captureInput = options.captureInput
    ?? (process.stdin.isTTY === true || bootExit);

  let readiness: BootReadiness = "boot";
  let status = "starting…";
  let unmounted = false;

  const paint = tracer?.start("tui.paint", { attrs: { phase: "boot_shell" } });
  let instance: Instance = render(React.createElement(BootShell, {
    version,
    cwd: options.cwd,
    status,
    readiness,
    buffer,
    captureInput,
  }), {
    alternateScreen: false,
    exitOnCtrlC: false,
    incrementalRendering: true,
  });

  let frameResolved = false;
  let resolveFrame: (() => void) | undefined;
  const framePromise = new Promise<void>((resolve) => {
    resolveFrame = resolve;
  });

  void (async () => {
    await new Promise<void>((r) => setImmediate(r));
    if (unmounted) {
      resolveFrame?.();
      return;
    }
    tracer?.end(paint, "success");
    if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
      tracer?.mark("first_frame", "success", {
        attrs: {
          ui: "ink_boot",
          operable: true,
          readiness: "boot",
          ...(bootExit ? { boot_exit: true } : {}),
        },
      });
    }
    frameResolved = true;
    resolveFrame?.();
  })();

  const rerender = () => {
    if (unmounted) return;
    instance.rerender(React.createElement(BootShell, {
      version,
      cwd: options.cwd,
      status,
      readiness,
      buffer,
      captureInput,
    }));
  };

  return {
    buffer,
    setStatus(nextReadiness, nextStatus) {
      readiness = nextReadiness;
      status = nextStatus;
      rerender();
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      instance.unmount();
      if (!frameResolved) {
        resolveFrame?.();
      }
    },
    firstFrameReady: () => framePromise,
  };
}
