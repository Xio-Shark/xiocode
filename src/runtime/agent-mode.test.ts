import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { registerAgentCommands } from "./agent-commands.ts";
import {
  DEFAULT_AGENT_MODE,
  agentStatusLabel,
  allowedRiskClasses,
  filterToolsForMode,
  isToolAllowedInMode,
  parseAgentMode,
} from "./agent-mode.ts";
import { isHighRisk, toolNeedsHighRiskGate, toolRisk } from "./tool-risk.ts";
import { defineTool } from "./define-tool.ts";
import { Type } from "./schema.ts";

import type { InteractiveIO } from "./interactive-io.ts";

function fakeIo(answers: boolean[] = []): InteractiveIO {
  const queue = [...answers];
  return {
    ask: async () => queue.shift() ?? false,
    select: async () => undefined,
    prompt: async () => undefined,
  };
}

describe("agent-mode", () => {
  it("defaults to build and parses aliases", () => {
    expect(DEFAULT_AGENT_MODE).toBe("build");
    expect(parseAgentMode("plan")).toBe("plan");
    expect(parseAgentMode("p")).toBe("plan");
    expect(parseAgentMode("build")).toBe("build");
    expect(parseAgentMode("b")).toBe("build");
    expect(parseAgentMode("nope")).toBeUndefined();
  });

  it("filters plan mode tools and denies mcp", () => {
    const names = ["read", "write", "edit", "bash", "grep", "glob", "skill", "mcp__demo__x"];
    expect(filterToolsForMode(names, "build")).toEqual(names);
    expect(filterToolsForMode(names, "plan")).toEqual([
      "read",
      "grep",
      "glob",
      "skill",
    ]);
    expect(isToolAllowedInMode("bash", "plan")).toBe(false);
    expect(isToolAllowedInMode("mcp__a__b", "plan")).toBe(false);
  });

  it("exposes risk vocabulary and plan risks", () => {
    expect(toolRisk("write")).toBe("write");
    expect(toolRisk("bash")).toBe("exec");
    expect(toolRisk("grep")).toBe("search");
    expect(toolRisk("mcp__s__t")).toBe("exec");
    expect(isHighRisk("exec")).toBe(true);
    expect(isHighRisk("write")).toBe(false);
    expect(toolNeedsHighRiskGate("bash")).toBe(true);
    expect(toolNeedsHighRiskGate("read")).toBe(false);
    expect(allowedRiskClasses("plan")).toEqual(["read", "search", "merge"]);
    expect(allowedRiskClasses("build")).toContain("network");
    expect(agentStatusLabel("plan")).toBe("agent:plan");
  });
});

describe("registerAgentCommands", () => {
  it("switches active tools between build and plan", async () => {
    const host = new ExtensionHost();
    for (const name of ["read", "write", "edit", "bash", "grep", "glob", "skill"]) {
      host.registerTool(defineTool({
        name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }));
    }
    const statuses: Record<string, string> = {};
    const controller = registerAgentCommands({
      host,
      sink: {
        setStatus(key, text) {
          if (text) statuses[key] = text;
          else delete statuses[key];
        },
      },
      interactive: fakeIo(),
      highRiskPolicy: "allow",
    });

    expect(controller.getMode()).toBe("build");
    expect(host.getActiveTools()).toContain("write");
    expect(statuses.agent).toBe("agent:build");

    await host.runCommand("agent", "plan");
    expect(controller.getMode()).toBe("plan");
    expect(host.getActiveTools()).toEqual(["read", "grep", "glob", "skill"]);
    expect(host.getActiveTools()).not.toContain("bash");
    expect(statuses.agent).toBe("agent:plan");

    host.registerTool(defineTool({
      name: "mcp__x__y",
      description: "mcp",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }));
    expect(host.getActiveTools()).not.toContain("mcp__x__y");
    expect(host.getActiveTools()).not.toContain("write");

    await host.runCommand("agent", "build");
    expect(host.getActiveTools()).toContain("write");
    expect(host.getActiveTools()).toContain("bash");
    expect(host.getActiveTools()).toContain("mcp__x__y");
  });
});
