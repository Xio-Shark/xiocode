import React from "react";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../runtime/extension-host.ts";
import { App } from "./app.ts";
import { TuiSessionBridge } from "./session-bridge.ts";

import type { PreparedSession } from "../runtime/session.ts";
import type { ChatMessage } from "../runtime/types.ts";

describe("App", () => {
  afterEach(() => cleanup());

  it("renders a stable model, idle state, cwd, and input surface", () => {
    const session: PreparedSession = {
      host: new ExtensionHost(),
      model: { provider: "test", id: "model-a" },
      runPrompt: async () => ({
        text: "",
        success: true,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 },
      }),
      abortTurn() {},
      getMessages: () => [],
      async close() {},
    };

    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 80 });

    expect(output).toContain("model-a | idle | /tmp/project");
    expect(output).toContain(">");
  });

  it("executes pasted slash input and renders the command result", async () => {
    const host = new ExtensionHost();
    host.registerCommand("status", { handler: () => "status-ok" });
    const session = createSession(host);
    const instance = render(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("/status\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(instance.lastFrame()).toContain("/status");
    expect(instance.lastFrame()).toContain("status-ok");
  });

  it("renders diff confirmation and returns the selected answer", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    bridge.sink.notify?.("diff --git a/a.ts b/a.ts\n-old\n+new");

    const answer = bridge.ask("Merge changes?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("Merge changes?");
    expect(instance.lastFrame()).toContain("+new");
    instance.stdin.write("n");

    await expect(answer).resolves.toBe(false);
  });

  it("toggles session bypass from the slash command", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("/bypass\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridge.bypass).toBe(true);
    expect(instance.lastFrame()).toContain("BYPASS");
  });

  it("renders restored user and assistant transcript messages", () => {
    const session = createSession(new ExtensionHost(), [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]);
    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 80 });

    expect(output).toContain("previous question");
    expect(output).toContain("previous answer");
  });
});

function createSession(host: ExtensionHost, messages: readonly ChatMessage[] = []): PreparedSession {
  return {
    host,
    model: { provider: "test", id: "model-a" },
    runPrompt: async () => ({
      text: "",
      success: true,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 },
    }),
    abortTurn() {},
    getMessages: () => messages,
    async close() {},
  };
}
