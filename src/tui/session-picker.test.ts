import React from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { SessionPicker } from "./session-picker.ts";
import { theme } from "./theme.ts";

afterEach(() => cleanup());

describe("SessionPicker", () => {
  it("shows brand count header, session identity, and accent selection", () => {
    const instance = render(React.createElement(SessionPicker, {
      sessions: [{
        schema_version: "xio-session.v1",
        id: "session1",
        model: { provider: "test", id: "model-a" },
        cwd: "/tmp/worktree",
        main_root: "/tmp/main",
        created_at: "2026-07-11T00:00:00.000Z",
        updated_at: "2026-07-11T01:00:00.000Z",
      }],
    }));

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain(`${theme.sym.brand} Resume session (1)`);
    expect(frame).toContain("model-a");
    expect(frame).toContain("session1");
    expect(frame).toContain(`${theme.sym.select} 2026-07-11`);
  });

  it("shows an empty-list message when there are no sessions", () => {
    const instance = render(React.createElement(SessionPicker, { sessions: [] }));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain(`${theme.sym.brand} Resume session (0)`);
    expect(frame).toContain("No sessions to resume.");
  });
});
