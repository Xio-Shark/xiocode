import { describe, expect, it } from "vitest";

import { collapseNoticesForDisplay, formatShortCwd, padSlashName, theme } from "./theme.ts";

describe("theme helpers", () => {
  it("exposes semantic slots used by App", () => {
    expect(theme.sym.answer).toBe("●");
    expect(theme.sym.meta).toBe("·");
    expect(theme.userBar).toMatch(/^#/);
    expect(theme.pathMax).toBeGreaterThan(10);
  });

  it("shortens home paths and middle-ellipsis long paths", () => {
    const home = process.env.HOME ?? "/Users/test";
    expect(formatShortCwd(`${home}/proj`)).toBe("~/proj");
    const long = `${home}/.xiocode/worktrees/very-long-repo-id/session-abcdef-1234567890`;
    const short = formatShortCwd(long, 42);
    expect(short.startsWith("~/")).toBe(true);
    expect(short.includes("…")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(42);
  });

  it("pads slash names to a fixed column", () => {
    expect(padSlashName("help", 8)).toBe("help    ");
    expect(padSlashName("verylongcommandname", 8).length).toBe(8);
    expect(padSlashName("verylongcommandname", 8)).toContain("…");
  });

  it("collapses consecutive mcp notices at render time", () => {
    const entries = [
      { id: 1, kind: "notice" as const, text: "mcp: ready a (1 tool)" },
      { id: 2, kind: "notice" as const, text: "mcp: ready b (2 tools)" },
      { id: 3, kind: "notice" as const, text: "mcp: ready c (3 tools)" },
      { id: 4, kind: "assistant" as const, text: "hi" },
    ];
    const collapsed = collapseNoticesForDisplay(entries);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({ kind: "notice", text: "mcp: 3 ready" });
    expect(collapsed[1]).toMatchObject({ kind: "assistant", text: "hi" });
  });

  it("does not collapse fewer than three mcp notices", () => {
    const entries = [
      { id: 1, kind: "notice" as const, text: "mcp: ready a (1 tool)" },
      { id: 2, kind: "notice" as const, text: "mcp: ready b (2 tools)" },
    ];
    expect(collapseNoticesForDisplay(entries)).toHaveLength(2);
  });
});
