import React from "react";
import { render } from "ink";

import { prepareSession } from "../runtime/session.ts";
import { App } from "./app.ts";
import { TuiSessionBridge } from "./session-bridge.ts";

import type { SessionOptions } from "../runtime/session.ts";

export async function runInkSession(options: SessionOptions): Promise<number> {
  const bridge = new TuiSessionBridge();
  const session = await prepareSession({ ...options, ask: bridge.ask, uiSink: bridge.sink });
  let exitCode = 0;
  let closed = false;
  const instance = render(React.createElement(App, {
    session,
    bridge,
    cwd: options.cwd ?? process.cwd(),
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
    const value = await instance.waitUntilExit();
    return typeof value === "number" ? value : exitCode;
  } finally {
    if (!closed) await session.close();
  }
}
