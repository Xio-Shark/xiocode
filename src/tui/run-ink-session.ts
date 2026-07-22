import React from "react";
import { render } from "ink";
import { writeSync } from "node:fs";

import { prepareSession } from "../runtime/session.ts";
import { App } from "./app.ts";
import { startInteractiveBoot } from "./interactive-boot.ts";
import type { EarlyBootHandle } from "./early-boot.ts";
import { TuiSessionBridge } from "./session-bridge.ts";
import { getGlobalTracer, isPerfEnabled } from "../runtime/perf/index.ts";

import type { SessionOptions } from "../runtime/session.ts";

export type RunInkSessionOptions = SessionOptions & Readonly<{
  /** Early no-Ink boot from entry (first_frame already marked). */
  earlyBoot?: EarlyBootHandle;
  /** Background npm update check; delivered as a TUI notice when ready. */
  updateNotice?: Promise<string | null>;
}>;

/**
 * Interactive session using **fullscreen alternate screen** (Claude-like):
 * 1. Silent early boot buffers stdin (no shell scrollback paint)
 * 2. Ink BootShell on alternate screen — logo + status under the mark
 * 3. Full App on alternate screen with self-managed transcript scroll
 */
export async function runInkSession(options: RunInkSessionOptions): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const tracer = getGlobalTracer(env);
  const bridge = new TuiSessionBridge();
  const bootExit = env.XIO_PERF_BOOT_EXIT === "1";

  const early = options.earlyBoot;
  early?.setStatus("loading session…");
  const earlyDraft = early?.drain() ?? { text: "", pendingSubmit: false };
  early?.unmount();

  const inkBoot = startInteractiveBoot({ cwd, env });
  if (earlyDraft.text.length > 0) {
    inkBoot.buffer.setText(earlyDraft.text);
  }
  if (earlyDraft.pendingSubmit && earlyDraft.text.trim().length > 0) {
    inkBoot.buffer.applyKey("", { return: true });
  }

  // Deliver update notice into the pre-subscription buffer so it appears in scrollback.
  if (options.updateNotice) {
    void options.updateNotice.then((message) => {
      if (message) bridge.sink.notify?.(message);
    }).catch(() => undefined);
  }

  try {
    await inkBoot.firstFrameReady();
    inkBoot.setStatus("prompt_context", "loading context…");

    const session = await prepareSession({
      ...options,
      ask: bridge.ask,
      interactive: bridge,
      uiSink: bridge.sink,
      subagentUi: bridge.createSubagentUiBridge(),
    });

    inkBoot.setStatus("ready", "ready");
    tracer?.mark("prompt_ready", "success", { attrs: { ui: "ink" } });

    if (bootExit) {
      // Ensure first_frame exists even if early boot was skipped.
      if (!tracer?.getSpans().some((span) => span.name === "first_frame")) {
        tracer?.mark("first_frame", "success", {
          attrs: { ui: "ink_boot", operable: true, boot_exit: true },
        });
      }
      emitPerfSpans(tracer);
      inkBoot.unmount();
      await session.close();
      return 0;
    }

    const drained = inkBoot.buffer.drain();
    inkBoot.unmount();

    let exitCode = 0;
    let closed = false;
    const firstAppPaint = tracer?.start("tui.paint", { attrs: { phase: "app", first: true } });
    const instance = render(React.createElement(App, {
      session,
      bridge,
      cwd,
      // Fullscreen alt-screen: self-managed scroll (Route A). Static scrollback
      // cannot be scrolled inside alternate screen the way Claude needs.
      appendScrollback: false,
      initialDraft: drained.text,
      autoSubmitInitial: drained.pendingSubmit,
      onExit: async (code) => {
        await session.close();
        closed = true;
        exitCode = code;
      },
    }), {
      alternateScreen: true,
      exitOnCtrlC: false,
      incrementalRendering: true,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      tracer?.end(firstAppPaint, "success");
      const value = await instance.waitUntilExit();
      return typeof value === "number" ? value : exitCode;
    } finally {
      if (!closed) await session.close();
    }
  } catch (error) {
    inkBoot.unmount();
    throw error;
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
