import React from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { SessionPicker } from "./session-picker.ts";

afterEach(() => cleanup());

describe("SessionPicker", () => {
  it("shows recent session identity, model, cwd, and active selection", () => {
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

    expect(instance.lastFrame()).toContain("Resume session");
    expect(instance.lastFrame()).toContain("model-a");
    expect(instance.lastFrame()).toContain("session1");
    expect(instance.lastFrame()).toContain("> 2026-07-11");
  });
});
