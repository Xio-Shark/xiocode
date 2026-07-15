import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { registerPermissionCommands } from "./agent-commands.ts";
import {
  DEFAULT_PERMISSION_MODE,
  allowedRiskClasses,
  cyclePermissionMode,
  filterToolsForMode,
  isToolAllowedInMode,
  parsePermissionMode,
  permissionStatusLabel,
} from "./permission-mode.ts";
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

describe("permission-mode", () => {
  it("defaults to auto and parses aliases", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("auto");
    expect(parsePermissionMode("strict")).toBe("strict");
    expect(parsePermissionMode("s")).toBe("strict");
    expect(parsePermissionMode("严格")).toBe("strict");
    expect(parsePermissionMode("auto")).toBe("auto");
    expect(parsePermissionMode("a")).toBe("auto");
    expect(parsePermissionMode("full")).toBe("full");
    expect(parsePermissionMode("f")).toBe("full");
    expect(parsePermissionMode("完全")).toBe("full");
    expect(parsePermissionMode("plan")).toBeUndefined();
    expect(parsePermissionMode("build")).toBeUndefined();
  });

  it("cycles auto → full → strict → auto", () => {
    expect(cyclePermissionMode("auto")).toBe("full");
    expect(cyclePermissionMode("full")).toBe("strict");
    expect(cyclePermissionMode("strict")).toBe("auto");
  });

  it("filters strict mode tools and denies mcp/write", () => {
    const names = ["read", "write", "edit", "bash", "grep", "glob", "skill", "explore", "mcp__demo__x"];
    expect(filterToolsForMode(names, "auto")).toEqual(names);
    expect(filterToolsForMode(names, "full")).toEqual(names);
    expect(filterToolsForMode(names, "strict")).toEqual([
      "read",
      "grep",
      "glob",
      "skill",
      "explore",
    ]);
    expect(isToolAllowedInMode("bash", "strict")).toBe(false);
    expect(isToolAllowedInMode("mcp__a__b", "strict")).toBe(false);
    expect(isToolAllowedInMode("explore", "strict")).toBe(true);
  });

  it("exposes risk vocabulary", () => {
    expect(toolRisk("write")).toBe("write");
    expect(toolRisk("bash")).toBe("exec");
    expect(toolRisk("grep")).toBe("search");
    expect(toolRisk("mcp__s__t")).toBe("exec");
    expect(isHighRisk("exec")).toBe(true);
    expect(isHighRisk("write")).toBe(false);
    expect(toolNeedsHighRiskGate("bash")).toBe(true);
    expect(toolNeedsHighRiskGate("read")).toBe(false);
    expect(allowedRiskClasses("strict")).toEqual(["read", "search", "merge"]);
    expect(allowedRiskClasses("auto")).toContain("network");
    expect(permissionStatusLabel("strict")).toBe("perm:strict");
  });
});

describe("registerPermissionCommands", () => {
  it("switches active tools across auto/full/strict", async () => {
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
    const controller = registerPermissionCommands({
      host,
      sink: {
        setStatus(key, text) {
          if (text) statuses[key] = text;
          else delete statuses[key];
        },
      },
      interactive: fakeIo(),
    });

    expect(controller.getMode()).toBe("auto");
    expect(host.getActiveTools()).toContain("write");
    expect(statuses.permission).toBe("perm:auto");

    await host.runCommand("permission", "strict");
    expect(controller.getMode()).toBe("strict");
    expect(host.getActiveTools()).toEqual(["read", "grep", "glob", "skill"]);
    expect(host.getActiveTools()).not.toContain("bash");
    expect(statuses.permission).toBe("perm:strict");

    host.registerTool(defineTool({
      name: "mcp__x__y",
      description: "mcp",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }));
    expect(host.getActiveTools()).not.toContain("mcp__x__y");
    expect(host.getActiveTools()).not.toContain("write");

    expect(controller.cycleMode()).toBe("auto");
    expect(controller.cycleMode()).toBe("full");
    expect(host.getActiveTools()).toContain("write");
    expect(host.getActiveTools()).toContain("bash");
    expect(host.getActiveTools()).toContain("mcp__x__y");
    expect(statuses.permission).toBe("perm:full");
  });
});
