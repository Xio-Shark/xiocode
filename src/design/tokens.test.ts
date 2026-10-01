import { describe, expect, it } from "vitest";

import { inlinePage } from "../web/assemble-page.ts";
import { contrastRatio, hexToRgb, resolveTheme } from "../tui/theme.ts";
import { COLOR_TOKENS, CSS_VARIABLES, cssTokenDeclarations, type ColorToken } from "./tokens.ts";

const FOREGROUND = (Object.keys(COLOR_TOKENS) as ColorToken[]).filter((token) => token !== "bg");
const SCHEMES = ["light", "dark"] as const;

/** ansi-styles' rgbToAnsi256 — what chalk sends to a 256-colour terminal. */
function toAnsi256(hex: string): number {
  const { r, g, b } = hexToRgb(hex)!;
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

describe("design tokens", () => {
  it.each(SCHEMES)("every %s foreground token keeps text contrast ≥ 4.5:1", (scheme) => {
    const bg = COLOR_TOKENS.bg[scheme];
    for (const token of FOREGROUND) {
      expect(contrastRatio(COLOR_TOKENS[token][scheme], bg), `${scheme} ${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SCHEMES)("%s status colours stay distinct after 256-colour downsampling", (scheme) => {
    const status = (["accent", "success", "warn", "danger"] as const).map((t) => toAnsi256(COLOR_TOKENS[t][scheme]));
    expect(new Set(status).size).toBe(status.length);
  });

  it("feeds the TUI brand themes", () => {
    for (const [name, scheme] of [["groknight", "dark"], ["light", "light"]] as const) {
      const theme = resolveTheme(name);
      expect(theme.accent).toBe(COLOR_TOKENS.accent[scheme]);
      expect(theme.error).toBe(COLOR_TOKENS.danger[scheme]);
      expect(theme.success).toBe(COLOR_TOKENS.success[scheme]);
      expect(theme.warn).toBe(COLOR_TOKENS.warn[scheme]);
      expect(theme.diffAdd).toBe(COLOR_TOKENS.diffAdd[scheme]);
      expect(theme.diffDel).toBe(COLOR_TOKENS.diffDel[scheme]);
      expect(theme.muted).toBe(COLOR_TOKENS.muted[scheme]);
    }
  });

  it("feeds the web stylesheet through the @design-tokens marker", () => {
    const page = inlinePage({
      "index.html": '<link rel="stylesheet" href="s.css">',
      "s.css": ":root {\n  /* @design-tokens */\n}",
    });
    expect(page).not.toContain("@design-tokens");
    expect(page).toContain(`${CSS_VARIABLES.accent}: light-dark(${COLOR_TOKENS.accent.light}, ${COLOR_TOKENS.accent.dark});`);
    expect(cssTokenDeclarations().split("\n")).toHaveLength(Object.keys(COLOR_TOKENS).length);
  });
});
