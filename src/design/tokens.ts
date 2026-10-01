/**
 * Brand colour tokens — the one place xio's semantic colours are defined.
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
  bg: { light: "#ffffff", dark: "#0f1115" },
  /** Primary text; also the TUI brand lettering. */
  text: { light: "#16181d", dark: "#e6e8ec" },
  /** Secondary text: line numbers, hints, thinking body. */
  muted: { light: "#5b6372", dark: "#8d94a3" },
  /** Brand accent: prompt, links, the shark fin. */
  accent: { light: "#3b5bdb", dark: "#7aa2f7" },
  success: { light: "#18794e", dark: "#9ece6a" },
  warn: { light: "#9a5b00", dark: "#e0af68" },
  danger: { light: "#c4262e", dark: "#f7768e" },
  diffAdd: { light: "#116329", dark: "#9ece6a" },
  diffDel: { light: "#a40e26", dark: "#f7768e" },
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
