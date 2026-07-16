import { performance } from "node:perf_hooks";

import { PerfTracer } from "../runtime/perf/tracer.ts";
import { sampleFromSpans } from "../runtime/perf/store.ts";
import type { PerfSample } from "../runtime/perf/types.ts";
import type { RunFixtureOptions } from "../runtime/perf/fixtures.ts";
import { createDeltaCoalescer, mergeSoftDeltas } from "./delta-coalesce.ts";
import {
  emptyScrollbackState,
  formatLiveLines,
  reduceScrollback,
  type ScrollbackState,
} from "./transcript-log.ts";
import type { TuiEvent } from "./session-bridge.ts";

/**
 * Drive real scrollback reducer + delta coalescer under ~10k stream deltas.
 * Paint work = merge soft deltas → reduceScrollback → formatLiveLines (tail preview, no full rejoin).
 * No empty-loop stand-in; no Ink process (headless projection path only).
 *
 * Lives in src/tui (subject under test) and is injected into runFixture via
 * RunFixtureOptions.tuiReplay — src/runtime must not import src/tui (architecture guard).
 */
export async function runTuiReplayFixture(options: RunFixtureOptions): Promise<PerfSample> {
  const tracer = new PerfTracer({ enabled: true });
  const started = performance.now();
  const deltas = 10_000;
  let state: ScrollbackState = emptyScrollbackState();
  let paintCount = 0;
  let reducedEvents = 0;
  let lastLiveChars = 0;

  // Immediate schedule: still exercises coalescer batching via soft/hard boundaries,
  // without waiting real 16ms frame timers (keeps fixture deterministic & fast).
  const timers: Array<() => void> = [];
  const coalescer = createDeltaCoalescer(
    (events) => {
      const paint = tracer.start("tui.paint", {
        attrs: {
          batch: events.length,
          path: "reducer+coalescer",
        },
      });
      const merged = mergeSoftDeltas(events);
      for (const event of merged) {
        state = reduceScrollback(state, event);
        reducedEvents += 1;
      }
      // Projection cost that Ink paint would read: live preview + in-flight tools.
      const lines = formatLiveLines(state.live, state.inFlightTools);
      lastLiveChars = state.live?.buffer.length ?? 0;
      paintCount += 1;
      tracer.end(paint, "success", {
        attrs: {
          batch: events.length,
          merged: merged.length,
          lines: lines.length,
          live_chars: lastLiveChars,
          blocks: state.blocks.length,
          path: "reducer+coalescer",
        },
      });
    },
    {
      frameMs: 16,
      schedule: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: () => {
        timers.length = 0;
      },
    },
  );

  const flushSoft = () => {
    while (timers.length > 0) {
      const fn = timers.shift();
      fn?.();
    }
  };

  // Mix of soft deltas and hard tool boundaries (mirrors real stream shape).
  for (let i = 0; i < deltas; i += 1) {
    const event: TuiEvent = {
      kind: "assistant-delta",
      text: i % 17 === 0 ? `token-${i} ` : "x",
    };
    coalescer.push(event);
    // Frame cadence: drain soft batch every ~20 deltas (simulates ~16ms frames under load).
    if (i % 20 === 19) {
      flushSoft();
    }
    // Hard tool boundary every 500 deltas forces immediate soft flush + hard event.
    if (i > 0 && i % 500 === 0) {
      const callId = `bench-${i}`;
      coalescer.push({
        kind: "tool-start",
        name: "read",
        detail: `file-${i}.ts`,
        callId,
      });
      coalescer.push({
        kind: "tool-end",
        name: "read",
        error: false,
        output: `// bench line ${i}\n`,
        callId,
      });
    }
  }
  coalescer.dispose();
  flushSoft();

  const wall_ms = performance.now() - started;
  tracer.mark("process_start", "success", {
    wall_ms,
    attrs: {
      fixture: "tui.replay_10k",
      deltas,
      paints: paintCount,
      reduced_events: reducedEvents,
      final_blocks: state.blocks.length,
      final_live_chars: lastLiveChars,
      path: "reducer+coalescer",
      trusted: true,
    },
  });

  const outcome = paintCount > 0 && reducedEvents > 0 ? "success" : "failure";
  return sampleFromSpans({
    fixture: "tui.replay_10k",
    iteration: options.iteration,
    spans: tracer.getSpans(),
    wall_ms,
    outcome,
    error_class: outcome === "failure" ? "empty_paint" : undefined,
  });
}
