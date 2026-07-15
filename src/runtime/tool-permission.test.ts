import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import {
  highRiskPolicyForMode,
  registerToolPermissionGate,
  resolveHighRiskPolicy,
} from "./tool-permission.ts";
import { registerPermissionCommands } from "./agent-commands.ts";

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

describe("highRiskPolicyForMode", () => {
  it("derives policy from permission mode", () => {
    expect(highRiskPolicyForMode("full", true)).toBe("allow");
    expect(highRiskPolicyForMode("strict", true)).toBe("deny");
    expect(highRiskPolicyForMode("auto", true)).toBe("ask");
    expect(highRiskPolicyForMode("auto", false)).toBe("deny");
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
      getMode: () => "auto",
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
      getMode: () => "auto",
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

  it("blocks denied ask and strict-mode tools", async () => {
    const host = new ExtensionHost();
    registerToolPermissionGate({
      host,
      interactive: fakeIo([false]),
      sink: {},
      getMode: () => "auto",
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
      getMode: () => "strict",
      highRiskPolicy: "allow",
    });
    const strictBlock = await host2.emit("tool_call", {
      toolName: "bash",
      call: { id: "1", name: "bash", args: {} },
    });
    expect(blocked(strictBlock)).toBe(true);
  });

  it("auto-allows with audit notify and enriches status", async () => {
    const host = new ExtensionHost();
    const notices: string[] = [];
    registerPermissionCommands({
      host,
      interactive: fakeIo(),
      sink: { notify: (message) => notices.push(message) },
      allowHighRisk: true,
    });
    await host.emit("tool_call", {
      toolName: "bash",
      call: { id: "1", name: "bash", args: {} },
    });
    expect(notices.some((n) => n.includes("auto-allowed"))).toBe(true);
    const status = await host.runCommand("status");
    expect(status).toMatchObject({
      permission: "full",
      high_risk_policy: "allow",
      host_isolation: "unsupported",
    });
  });
});
