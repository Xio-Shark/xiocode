import { describe, expect, it } from "vitest";
import { ExtensionHost } from "../runtime/extension-host.ts";
import {
  footerModeColor,
  layoutFooter,
  collectSlashCommands,
  filterSlashCommands,
  slashGroupPriority,
  formatSlashDescription,
  BUILTIN_SLASH_COMMANDS,
} from "./overlays.ts";
import { setTheme, theme } from "./theme.ts";

describe("T10: Slash menu ordering and alias folding", () => {
  it("defaults empty query to group + weight priority (connect, model, rollback, compact, help at top)", () => {
    const host = new ExtensionHost();
    host.registerCommand("connect", { description: "Connect provider.", group: "common", weight: 100, handler: async () => {} });
    host.registerCommand("model", { description: "Switch model.", group: "common", weight: 90, handler: async () => {} });
    host.registerCommand("rollback", { description: "Rollback changes.", group: "common", weight: 80, handler: async () => {} });
    host.registerCommand("compact", { description: "Compact context.", group: "common", weight: 70, handler: async () => {} });
    host.registerCommand("permission", {
      description: "Switch permission mode.",
      group: "common",
      weight: 50,
      aliases: ["agent", "bypass"],
      handler: async () => {},
    });
    host.registerCommand("thinking", {
      description: "Set thinking effort.",
      group: "common",
      weight: 40,
      aliases: ["effort"],
      handler: async () => {},
    });
    host.registerCommand("rewind", { description: "Rewind session.", group: "common", weight: 30, handler: async () => {} });
    host.registerCommand("plan", { description: "View plan.", group: "session", weight: 90, handler: async () => {} });
    host.registerCommand("status", { description: "View status.", group: "diagnostics", weight: 100, handler: async () => {} });

    // Register alias entries as well
    host.registerCommand("effort", { description: "Alias for /thinking.", aliasFor: "thinking", handler: async () => {} });
    host.registerCommand("agent", { description: "Alias for /permission.", aliasFor: "permission", handler: async () => {} });
    host.registerCommand("bypass", { description: "Alias for /permission full.", aliasFor: "permission", handler: async () => {} });

    const all = collectSlashCommands(host);
    const names = all.map((c) => c.name);

    // First 8 items (the first visible screen) must be core commands in order
    expect(names.slice(0, 8)).toEqual([
      "connect",
      "model",
      "rollback",
      "compact",
      "help",
      "permission",
      "thinking",
      "rewind",
    ]);

    // Aliases must NOT occupy their own row
    expect(names).not.toContain("effort");
    expect(names).not.toContain("agent");
    expect(names).not.toContain("quit");
  });

  it("folds aliases into primary command description with (alias /x)", () => {
    const host = new ExtensionHost();
    host.registerCommand("thinking", {
      description: "Set thinking / reasoning effort for this session.",
      group: "common",
      weight: 40,
      aliases: ["effort"],
      handler: async () => {},
    });
    host.registerCommand("effort", {
      description: "Alias for /thinking.",
      aliasFor: "thinking",
      handler: async () => {},
    });
    host.registerCommand("permission", {
      description: "Switch permission mode: auto | full | strict.",
      group: "common",
      weight: 50,
      aliases: ["agent", "bypass"],
      handler: async () => {},
    });

    const all = collectSlashCommands(host);
    const thinking = all.find((c) => c.name === "thinking");
    expect(thinking).toBeDefined();
    expect(thinking?.description).toContain("(alias /effort)");

    const permission = all.find((c) => c.name === "permission");
    expect(permission).toBeDefined();
    expect(permission?.description).toContain("(alias /agent, /bypass)");

    const exit = all.find((c) => c.name === "exit");
    expect(exit).toBeDefined();
    expect(exit?.description).toContain("(alias /quit)");
  });

  it("matches primary command when querying by alias prefix (/eff -> /thinking)", () => {
    const host = new ExtensionHost();
    host.registerCommand("thinking", {
      description: "Set thinking effort.",
      group: "common",
      weight: 40,
      aliases: ["effort"],
      handler: async () => {},
    });
    host.registerCommand("effort", {
      description: "Alias for /thinking.",
      aliasFor: "thinking",
      handler: async () => {},
    });
    host.registerCommand("permission", {
      description: "Switch permission mode.",
      group: "common",
      weight: 50,
      aliases: ["agent", "bypass"],
      handler: async () => {},
    });

    const all = collectSlashCommands(host);

    // Querying /eff or eff should match /thinking
    const matchedEff = filterSlashCommands(all, "eff");
    expect(matchedEff).toBeDefined();
    expect(matchedEff?.[0]?.name).toBe("thinking");

    // Querying /byp should match /permission
    const matchedByp = filterSlashCommands(all, "byp");
    expect(matchedByp).toBeDefined();
    expect(matchedByp?.[0]?.name).toBe("permission");

    // Querying /agent should match /permission
    const matchedAgent = filterSlashCommands(all, "agent");
    expect(matchedAgent).toBeDefined();
    expect(matchedAgent?.[0]?.name).toBe("permission");
  });

  it("handles extension command overriding built-in command with same name", () => {
    const host = new ExtensionHost();
    host.registerCommand("help", {
      description: "Custom plugin help overview.",
      group: "common",
      weight: 95,
      handler: async () => {},
    });

    const all = collectSlashCommands(host);
    const help = all.find((c) => c.name === "help");
    expect(help).toBeDefined();
    expect(help?.description).toBe("Custom plugin help overview.");
    expect(help?.weight).toBe(95);
  });

  it("handles unweighted extension commands with stable default fallback", () => {
    const host = new ExtensionHost();
    host.registerCommand("z-custom", {
      description: "Custom command Z.",
      handler: async () => {},
    });
    host.registerCommand("a-custom", {
      description: "Custom command A.",
      handler: async () => {},
    });

    const all = collectSlashCommands(host);
    const names = all.map((c) => c.name);

    // a-custom should come before z-custom (alphabetical tie-break with weight 0 in session group)
    const idxA = names.indexOf("a-custom");
    const idxZ = names.indexOf("z-custom");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxZ).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxZ);
  });

  it("preserves standalone command if target of aliasFor does not exist", () => {
    const host = new ExtensionHost();
    host.registerCommand("standalone-alias", {
      description: "Dangling alias.",
      aliasFor: "non-existent-cmd",
      handler: async () => {},
    });

    const all = collectSlashCommands(host);
    const cmd = all.find((c) => c.name === "standalone-alias");
    expect(cmd).toBeDefined();
  });
});

describe("footer layout", () => {
  const home = process.env.HOME ?? "/Users/test";
  const parts = {
    permissionMode: "strict",
    cwd: `${home}/code/projects/some-long-repository-name/packages/app`,
    context: "ctx:42%",
    turn: "turn 6",
    mcp: "3 mcp",
    workspace: "worktree",
  };

  it("shows everything when there is room", () => {
    const layout = layoutFooter(parts, 160);
    expect(layout.mode).toBe("strict");
    expect(layout.hint).toBe("shift+tab to cycle");
    expect(layout.left).toContain("turn 6");
    expect(layout.right).toEqual(["worktree", "3 mcp"]);
  });

  it("keeps workspace and mcp at 60 columns by dropping the hint, turn and path middle first", () => {
    const layout = layoutFooter(parts, 60);
    expect(layout.hint).toBeUndefined();
    expect(layout.left).not.toContain("turn 6");
    expect(layout.right).toEqual(["worktree", "3 mcp"]);
    expect(layout.left[0]).toContain("…");
    expect(layout.mode).toBe("strict");
  });

  it("drops mcp before workspace when even the shortest path does not fit", () => {
    expect(layoutFooter(parts, 44).right).toEqual(["worktree"]);
    expect(layoutFooter(parts, 30).right).toEqual([]);
    expect(layoutFooter(parts, 30).mode).toBe("strict");
  });

  it("marks full mode in words and in the danger colour; auto shows no mode", () => {
    expect(layoutFooter({ ...parts, permissionMode: "full" }, 160).mode).toBe("⚠ full");
    for (const name of ["groknight", "light", "claude", "minimal", "nord"] as const) {
      setTheme(name);
      expect(footerModeColor("full")).toBe(theme.error);
      expect(footerModeColor("strict")).toBe(theme.muted);
    }
    setTheme("groknight");
    const auto = layoutFooter({ ...parts, permissionMode: "auto" }, 160);
    expect(auto.mode).toBeUndefined();
    expect(auto.hint).toBe("? for shortcuts");
  });
});
