import { performance } from "node:perf_hooks";

import React from "react";
import { Box } from "ink";

import { PerfTracer } from "../runtime/perf/tracer.ts";
import { sampleFromSpans } from "../runtime/perf/store.ts";
import { HistoryBlockRow, LiveStreamRegion } from "./app.ts";
import { emptyScrollbackState, reduceScrollback, type ScrollbackState } from "./transcript-log.ts";

import type { PerfSample } from "../runtime/perf/types.ts";
import type { RunFixtureOptions } from "../runtime/perf/fixtures.ts";
import type { HistoryBlock } from "./transcript-log.ts";
import type { TuiEvent } from "./session-bridge.ts";

const h = React.createElement;

/** Stream deltas replayed; frames are emitted every FRAME_DELTAS of them. */
const DELTAS = 2_000;
const FRAME_DELTAS = 20;

/**
 * Real Ink render replay — the smoothness guardrail.
 *
 * `tui.replay_10k` benches the headless projection (reducer + coalescer) and
 * says nothing about paint cost. This fixture mounts actual Ink with the same
 * components the Route B session uses — `<Static>` history rows plus the sticky
 * live region — and re-renders per simulated frame, so a regression in
 * reconciliation or live-region size shows up as a number instead of as "the
 * TUI feels laggy now".
 *
 * `ink-testing-library` is a devDependency and is imported lazily: `xio bench`
 * is a development surface, and a static import would break installs where the
 * package is not present.
 */
export async function runInkRenderFixture(options: RunFixtureOptions): Promise<PerfSample> {
  const tracer = new PerfTracer({ enabled: true });
  const started = performance.now();

  const { render } = await importInkTesting();

  let state: ScrollbackState = emptyScrollbackState();
  let frames = 0;
  let maxBlocks = 0;

  const instance = render(h(ReplayFrame, { state }));
  try {
    for (let i = 0; i < DELTAS; i += 1) {
      state = reduceScrollback(state, deltaEvent(i));
      if (i > 0 && i % 500 === 0) {
        const callId = `bench-${i}`;
        state = reduceScrollback(state, {
          kind: "tool-start",
          name: "read",
          detail: `file-${i}.ts`,
          callId,
        });
        state = reduceScrollback(state, {
          kind: "tool-end",
          name: "read",
          error: false,
          output: `// bench line ${i}\n`,
          callId,
        });
      }
      if (i % FRAME_DELTAS !== FRAME_DELTAS - 1) continue;

      const paint = tracer.start("tui.paint", {
        attrs: { blocks: state.blocks.length, path: "ink" },
      });
      instance.rerender(h(ReplayFrame, { state }));
      frames += 1;
      maxBlocks = Math.max(maxBlocks, state.blocks.length);
      tracer.end(paint, "success", {
        attrs: {
          blocks: state.blocks.length,
          live_chars: state.live?.buffer.length ?? 0,
          in_flight: state.inFlightTools.length,
          path: "ink",
        },
      });
    }
  } finally {
    instance.unmount();
  }

  const wall_ms = performance.now() - started;
  tracer.mark("process_start", "success", {
    wall_ms,
    attrs: {
      fixture: "tui.ink_render",
      deltas: DELTAS,
      frames,
      final_blocks: state.blocks.length,
      max_blocks: maxBlocks,
      path: "ink",
      trusted: true,
    },
  });

  // A render that produced no frames or no history is a broken fixture, not a
  // fast one — fail closed rather than publish a flattering number.
  const outcome = frames > 0 && state.blocks.length > 0 ? "success" : "failure";
  return sampleFromSpans({
    fixture: "tui.ink_render",
    iteration: options.iteration,
    spans: tracer.getSpans(),
    wall_ms,
    outcome,
    error_class: outcome === "failure" ? "empty_render" : undefined,
  });
}

/** The Route B paint shape: Static history + sticky live tail. */
function ReplayFrame(props: Readonly<{ state: ScrollbackState }>): React.JSX.Element {
  return h(Box, { flexDirection: "column" },
    ...props.state.blocks.map((block: HistoryBlock) =>
      h(HistoryBlockRow, { key: block.id, block })),
    h(LiveStreamRegion, {
      live: props.state.live,
      inFlightTools: props.state.inFlightTools,
      inFlightSubagents: props.state.inFlightSubagents,
    }));
}

function deltaEvent(index: number): TuiEvent {
  return {
    kind: "assistant-delta",
    text: index % 17 === 0 ? `token-${index} ` : "x",
  };
}

type InkTestingModule = Readonly<{
  render: (node: React.ReactElement) => {
    rerender: (node: React.ReactElement) => void;
    unmount: () => void;
  };
}>;

async function importInkTesting(): Promise<InkTestingModule> {
  try {
    return await import("ink-testing-library") as unknown as InkTestingModule;
  } catch (error) {
    throw new Error(
      "tui.ink_render needs the ink-testing-library devDependency "
        + "(run `npm install` in a checkout; it is not in the published package): "
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}
