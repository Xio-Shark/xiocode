import React, { useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";

import type { SessionMetadata } from "../runtime/session-store.ts";

const h = React.createElement;

export async function runSessionPicker(sessions: readonly SessionMetadata[]): Promise<string | undefined> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("session picker requires an interactive TTY; use `xio resume <session-id>` instead");
  }
  const instance = render(h(SessionPicker, { sessions }), {
    alternateScreen: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
  });
  const result = await instance.waitUntilExit();
  return typeof result === "string" ? result : undefined;
}

export function SessionPicker(props: Readonly<{ sessions: readonly SessionMetadata[] }>): React.JSX.Element {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) {
      exit(undefined);
      return;
    }
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelected((value) => Math.min(props.sessions.length - 1, value + 1));
    if (key.return) exit(props.sessions[selected]?.id);
  });
  const visibleCount = Math.max(1, rows - 2);
  const start = Math.min(Math.max(0, selected - visibleCount + 1), Math.max(0, props.sessions.length - visibleCount));
  const visible = props.sessions.slice(start, start + visibleCount);
  return h(Box, { flexDirection: "column", height: rows },
    h(Text, { bold: true }, "Resume session"),
    ...visible.map((session, index) => h(SessionRow, {
      key: session.id,
      session,
      active: start + index === selected,
    })));
}

function SessionRow(props: Readonly<{ session: SessionMetadata; active: boolean }>): React.JSX.Element {
  const updated = props.session.updated_at.replace("T", " ").slice(0, 19);
  const text = `${updated} | ${props.session.model.id} | ${props.session.cwd} | ${props.session.id}`;
  return h(Text, { inverse: props.active, wrap: "truncate-end" }, `${props.active ? ">" : " "} ${text}`);
}
