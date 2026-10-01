import { describe, expect, it } from "vitest";

import {
  checkThemeBackgroundMismatch,
  collapseNoticesForDisplay,
  contrastRatio,
  formatShortCwd,
  getActiveThemeName,
  isLuminanceLight,
  padSlashName,
  parseOsc11Color,
  resolveTheme,
  setTheme,
  theme,
} from "./theme.ts";


describe("theme helpers", () => {
  it("exposes semantic slots used by App", () => {
    expect(theme.sym.answer).toBe("●");
    expect(theme.sym.meta).toBe("·");
    expect(theme.userBar).toMatch(/^#/);
    expect(theme.pathMax).toBeGreaterThan(10);
  });

  it("defaults to the groknight palette (XIO_THEME unset or unknown)", () => {
    expect(resolveTheme(undefined).accent).toBe("#7aa2f7");
    expect(resolveTheme("groknight").brand).toBe("#e2e8f0");
    expect(resolveTheme("bogus").tool).toBe("#e0af68");
  });

  it("keeps the claude quiet theme opt-in", () => {
    const claude = resolveTheme("claude");
    expect(claude.accent).toBe("cyan");
    expect(claude.userBar).toBe("#303030");
  });

  it("supports minimal and nord themes inspired by awesome-tui-design", () => {
    const minimal = resolveTheme("minimal");
    expect(minimal.brand).toBe("#ededed");
    expect(minimal.userBar).toBe("#1a1a1a");

    const nord = resolveTheme("nord");
    expect(nord.brand).toBe("#eceff4");
    expect(nord.accent).toBe("#88c0d0");
    expect(nord.userBar).toBe("#3b4252");
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

  describe("WCAG contrast and Light theme", () => {
    it("ensures light theme text colors have contrast ratio >= 4.5:1 against pure white", () => {
      const light = resolveTheme("light");
      const white = "#ffffff";
      const slotsToCheck: (keyof typeof light)[] = [
        "brand",
        "accent",
        "tool",
        "think",
        "explore",
        "error",
        "success",
        "warn",
        "diffAdd",
        "diffDel",
        "muted",
      ];

      for (const slot of slotsToCheck) {
        const color = light[slot] as string;
        const ratio = contrastRatio(color, white);
        expect(
          ratio,
          `Slot ${slot} (${color}) failed WCAG AA normal text contrast (ratio: ${ratio.toFixed(2)}:1)`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("supports switching themes via setTheme and reflects active theme name", () => {
      setTheme("light");
      expect(getActiveThemeName()).toBe("light");
      expect(theme.accent).toBe("#2563eb");

      setTheme("groknight");
      expect(getActiveThemeName()).toBe("groknight");
      expect(theme.accent).toBe("#7aa2f7");
    });

    it("parses OSC 11 response for 4-digit and 2-digit hex RGB values", () => {
      const whiteOsc = "\x1b]11;rgb:ffff/ffff/ffff\x07";
      const parsedWhite = parseOsc11Color(whiteOsc);
      expect(parsedWhite).toBeDefined();
      expect(parsedWhite?.r).toBe(255);
      expect(parsedWhite?.g).toBe(255);
      expect(parsedWhite?.b).toBe(255);
      expect(parsedWhite?.luminance).toBeGreaterThan(0.9);
      expect(isLuminanceLight(parsedWhite!.luminance)).toBe(true);

      const blackOsc = "\x1b]11;rgb:0000/0000/0000\x07";
      const parsedBlack = parseOsc11Color(blackOsc);
      expect(parsedBlack).toBeDefined();
      expect(parsedBlack?.r).toBe(0);
      expect(parsedBlack?.b).toBe(0);
      expect(isLuminanceLight(parsedBlack!.luminance)).toBe(false);

      expect(parseOsc11Color("invalid")).toBeUndefined();
    });

    it("warns about theme background mismatches", () => {
      expect(checkThemeBackgroundMismatch("groknight", true)).toContain("Tip: /theme light");
      expect(checkThemeBackgroundMismatch("light", false)).toContain("Tip: /theme groknight");
      expect(checkThemeBackgroundMismatch("light", true)).toBeUndefined();
      expect(checkThemeBackgroundMismatch("groknight", false)).toBeUndefined();
    });
  });
});

