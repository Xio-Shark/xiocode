import React from "react";
import { render } from "ink";
import { writeSync } from "node:fs";

import { prepareSession } from "../runtime/session.ts";
import { App } from "./app.ts";
import { TuiSessionBridge } from "./session-bridge.ts";
import { getGlobalTracer, isPerfEnabled } from "../runtime/perf/index.ts";

import type { SessionOptions } from "../runtime/session.ts";

/**
 * Interactive session using **append-to-scrollback** (route B):
 * - Finalized transcript via Ink `<Static>` → main buffer / native wheel + search
 * - Sticky chrome (header / input / modals) re-renders only
 * - No alternate screen (no self-managed viewport scroll)
 */
export async function runInkSession(options: SessionOptions): Promise<number> {
  const bridge = new TuiSessionBridge();
  const session = await prepareSession({
    ...options,
    ask: bridge.ask,
    interactive: bridge,
    uiSink: bridge.sink,
  });
  const tracer = getGlobalTracer(options.env ?? process.env);
  tracer?.mark("prompt_ready", "success", { attrs: { ui: "ink" } });
  // first_frame may already be marked at boot shell; record Ink paint as tui.paint.
  if ((options.env ?? process.env).XIO_PERF_BOOT_EXIT === "1") {
    let exitCode = 0;
    let closed = false;
    const paint = tracer?.start("tui.paint", { attrs: { boot: true } });
    const instance = render(React.createElement(App, {
      session,
      bridge,
      cwd: options.cwd ?? process.cwd(),
      appendScrollback: true,
      onExit: async (code) => {
        await session.close();
        closed = true;
        exitCode = code;
      },
    }), {
      alternateScreen: false,
      exitOnCtrlC: false,
      incrementalRendering: true,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      tracer?.end(paint, "success");
      if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
        tracer?.mark("first_frame", "success", { attrs: { ui: "ink", boot_exit: true } });
      }
      emitPerfSpans(tracer);
      instance.unmount();
      return 0;
    } finally {
      if (!closed) await session.close();
      void exitCode;
    }
  }

  let exitCode = 0;
  let closed = false;
  const firstPaint = tracer?.start("tui.paint", { attrs: { first: true } });
  const instance = render(React.createElement(App, {
    session,
    bridge,
    cwd: options.cwd ?? process.cwd(),
    appendScrollback: true,
    onExit: async (code) => {
      await session.close();
      closed = true;
      exitCode = code;
    },
  }), {
    // Main buffer: terminal owns scrollback (Pi / Claude Code style).
    alternateScreen: false,
    exitOnCtrlC: false,
    incrementalRendering: true,
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    tracer?.end(firstPaint, "success");
    if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
      tracer?.mark("first_frame", "success", { attrs: { ui: "ink" } });
    }
    const value = await instance.waitUntilExit();
    return typeof value === "number" ? value : exitCode;
  } finally {
    if (!closed) await session.close();
  }
}

function emitPerfSpans(tracer: ReturnType<typeof getGlobalTracer>): void {
  if (!tracer || !isPerfEnabled()) {
    return;
  }
  for (const span of tracer.getSpans()) {
    writeSync(process.stdout.fd, `${JSON.stringify(span)}\n`);
  }
}
