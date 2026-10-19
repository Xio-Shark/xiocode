/**
 * Brand colour tokens — the one place xio's semantic colours are defined.
 * Deep-water ink at night, warm paper by day, one ember accent.
 *
 * The TUI themes `groknight` (dark) and `light` read their shared slots from
 * here (src/tui/theme.ts), and the web console's stylesheet gets the same
 * values as CSS custom properties at page assembly (src/web/assemble-page.ts).
 * Change a value here and both front ends change.
 *
 * Every foreground value keeps text contrast ≥ 4.5:1 on its scheme's `bg`
 * (checked in tokens.test.ts). The accent is the shark-fin blue of the XIO mark.
 */

export type SchemeColor = Readonly<{ light: string; dark: string }>;

export const COLOR_TOKENS = {
  /** Page / terminal background the contrast checks are measured against. */
  bg: { light: "#f5efe3", dark: "#0a1113" },
  /** Primary text; also the TUI brand lettering. */
  text: { light: "#1b1a17", dark: "#efeae0" },
  /** Secondary text: line numbers, hints, thinking body. */
  muted: { light: "#5d5c55", dark: "#b6b3a9" },
  /** Brand accent: prompt, links, the shark fin. */
  accent: { light: "#a94e26", dark: "#e08a52" },
  success: { light: "#2f6b3a", dark: "#8fbb83" },
  warn: { light: "#8a5a00", dark: "#d7a24a" },
  danger: { light: "#a33a33", dark: "#e07b78" },
  diffAdd: { light: "#2f6b3a", dark: "#8fbb83" },
  diffDel: { light: "#a33a33", dark: "#e07b78" },
} as const satisfies Readonly<Record<string, SchemeColor>>;

export type ColorToken = keyof typeof COLOR_TOKENS;

/** CSS custom property each token is published as in the web console. */
export const CSS_VARIABLES: Readonly<Record<ColorToken, string>> = {
  bg: "--bg",
  text: "--text",
  muted: "--text-3",
  accent: "--accent",
  success: "--success",
  warn: "--warn",
  danger: "--danger",
  diffAdd: "--diff-add-fg",
  diffDel: "--diff-del-fg",
};

/** `--name: light-dark(light, dark);` lines for the web stylesheet's :root. */
export function cssTokenDeclarations(): string {
  return (Object.keys(COLOR_TOKENS) as ColorToken[])
    .map((token) => {
      const { light, dark } = COLOR_TOKENS[token];
      return `  ${CSS_VARIABLES[token]}: light-dark(${light}, ${dark});`;
    })
    .join("\n");
}
