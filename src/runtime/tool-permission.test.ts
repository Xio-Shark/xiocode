import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import {
  registerToolPermissionGate,
  resolveHighRiskPolicy,
} from "./tool-permission.ts";
import { registerAgentCommands } from "./agent-commands.ts";

import type { InteractiveIO } from "./interactive-io.ts";

function fakeIo(answers: boolean[] = []): InteractiveIO & { asks: string[] } {
  const queue = [...answers];
  const asks: string[] = [];
  return {
    asks,
    ask: async (question) => {
      asks.push(question);
      return queue.shift() ?? false;
    },
    select: async () => undefined,
    prompt: async () => undefined,
  };
}

function blocked(results: readonly unknown[]): boolean {
  return results.some((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { block?: boolean }).block === true;
  });
}

describe("resolveHighRiskPolicy", () => {
  it("maps allow / promptOnce / interactive defaults", () => {
    expect(resolveHighRiskPolicy({ allowHighRisk: true })).toBe("allow");
    expect(resolveHighRiskPolicy({ allowHighRisk: false, promptOnce: "hi" })).toBe("deny");
    expect(resolveHighRiskPolicy({ allowHighRisk: false })).toBe("ask");
  });
});

describe("registerToolPermissionGate", () => {
  it("denies high-risk tools under deny policy", async () => {
    const host = new ExtensionHost();
    const notices: string[] = [];
    registerToolPermissionGate({
      host,
      interactive: fakeIo(),
      sink: { notify: (message) => notices.push(message) },
      getMode: () => "build",
      highRiskPolicy: "deny",
    });

    const result = await host.emit("tool_call", {
      toolName: "bash",
      input: { command: "echo hi" },
      call: { id: "1", name: "bash", args: { command: "echo hi" } },
    });
    expect(blocked(result)).toBe(true);
    expect(notices).toEqual([]);
  });

  it("asks once then remembers approval", async () => {
    const host = new ExtensionHost();
    const io = fakeIo([true]);
    const gate = registerToolPermissionGate({
      host,
      interactive: io,
      sink: {},
      getMode: () => "build",
      highRiskPolicy: "ask",
    });

    const first = await host.emit("tool_call", {
      toolName: "bash",
      call: { id: "1", name: "bash", args: {} },
    });
    expect(blocked(first)).toBe(false);
    expect(io.asks).toHaveLength(1);
    expect(gate.getApprovedTools()).toEqual(["bash"]);

    await host.emit("tool_call", {
      toolName: "bash",
      call: { id: "2", name: "bash", args: {} },
    });
    expect(io.asks).toHaveLength(1);
  });

  it("blocks denied ask and plan-mode tools", async () => {
    const host = new ExtensionHost();
    registerToolPermissionGate({
      host,
      interactive: fakeIo([false]),
      sink: {},
      getMode: () => "build",
      highRiskPolicy: "ask",
    });
    const denied = await host.emit("tool_call", {
      toolName: "mcp__x__y",
      call: { id: "1", name: "mcp__x__y", args: {} },
    });
    expect(blocked(denied)).toBe(true);

    const host2 = new ExtensionHost();
    registerToolPermissionGate({
      host: host2,
      interactive: fakeIo(),
      sink: {},
      getMode: () => "plan",
      highRiskPolicy: "allow",
    });
    const planBlock = await host2.emit("tool_call", {
      toolName: "bash",
      call: { id: "1", name: "bash", args: {} },
    });
    expect(blocked(planBlock)).toBe(true);
  });

  it("auto-allows with audit notify and enriches status", async () => {
    const host = new ExtensionHost();
    const notices: string[] = [];
    registerAgentCommands({
      host,
      interactive: fakeIo(),
      sink: { notify: (message) => notices.push(message) },
      highRiskPolicy: "allow",
    });
    await host.emit("tool_call", {
      toolName: "bash",
      call: { id: "1", name: "bash", args: {} },
    });
    expect(notices.some((n) => n.includes("auto-allowed"))).toBe(true);
    const status = await host.runCommand("status");
    expect(status).toMatchObject({
      high_risk_policy: "allow",
      host_isolation: "unsupported",
    });
  });
});
