/**
 * Semantic theme slots. `groknight` (dark, default) and `light` are the xio
 * brand palettes: their shared slots come from src/design/tokens.ts, the same
 * source as the web console. `claude`, `minimal` and `nord` are alternates.
 * Chosen by `XIO_THEME`, then config.toml `[ui] theme` (/theme), then the
 * terminal background detected at start; unknown names fall back to groknight.
 */

import { homedir } from "node:os";

import { COLOR_TOKENS, type ColorToken } from "../design/tokens.ts";
import { t } from "../i18n/messages.ts";

function brand(scheme: "light" | "dark", token: ColorToken): ThemeColor {
  return COLOR_TOKENS[token][scheme];
}

export type ThemeColor = string;

export type Theme = Readonly<{
  brand: ThemeColor;
  accent: ThemeColor;
  userBar: ThemeColor;
  tool: ThemeColor;
  /** Thinking / CoT label + body (dim gray-blue). */
  think: ThemeColor;
  /** Explore / subagent tool rows. */
  explore: ThemeColor;
  error: ThemeColor;
  /** Success state / notices (green). */
  success: ThemeColor;
  /** Warning state / elevated notice (yellow/amber). */
  warn: ThemeColor;
  /** Diff line additions. */
  diffAdd: ThemeColor;
  /** Diff line deletions. */
  diffDel: ThemeColor;
  /** Muted secondary text / line numbers. */
  muted: ThemeColor;
  /** Whether faint (SGR 2) still reads on this palette's background; false on light themes. */
  faint: boolean;
  /** Pixel shark body (header mascot). */
  shark: ThemeColor;
  /** Shark eye socket fill (dark so pupils read). */
  sharkEyeBg: ThemeColor;
  /** Max visible path length before middle-ellipsis. */
  pathMax: number;
  /** Max chars for tool detail on the title line. */
  toolDetailMax: number;
  /** Slash menu name column width (clamped). */
  slashNameWidth: number;
  /** Collapse consecutive same-prefix notices when count ≥ this. */
  noticeCollapseMin: number;
  sym: Readonly<{
    answer: string;
    meta: string;
    tool: string;
    think: string;
    explore: string;
    brand: string;
    prompt: string;
    busy: string;
    select: string;
    nest: string;
    success: string;
    failure: string;
    running: string;
    arrow: string;
  }>;
}>;

/** Brand dark palette: neutral slate base, shark-fin blue accent (tokens.ts `dark`). */
const GROKNIGHT: Theme = {
  brand: brand("dark", "text"),
  accent: brand("dark", "accent"),
  userBar: "#1a1b26",
  tool: brand("dark", "warn"),
  think: brand("dark", "muted"),
  explore: "#73daca",
  error: brand("dark", "danger"),
  success: brand("dark", "success"),
  warn: brand("dark", "warn"),
  diffAdd: brand("dark", "diffAdd"),
  diffDel: brand("dark", "diffDel"),
  muted: brand("dark", "muted"),
  faint: true,
  shark: "#c0caf5",
  sharkEyeBg: "#16161e",
  pathMax: 42,
  toolDetailMax: 72,
  slashNameWidth: 16,
  noticeCollapseMin: 3,
  sym: {
    answer: "●",
    meta: "·",
    tool: "⚙",
    think: "▸",
    explore: "⊹",
    brand: "◆",
    prompt: "❯",
    busy: "·",
    select: "›",
    nest: "└",
    success: "✔",
    failure: "✖",
    running: "✢",
    arrow: "→",
  },
};

/** Original Claude-quiet theme — keep for XIO_THEME=claude. */
const CLAUDE: Theme = {
  ...GROKNIGHT,
  brand: "magenta",
  accent: "cyan",
  userBar: "#303030",
  tool: "yellow",
  think: "blue",
  explore: "magenta",
  error: "red",
  success: "green",
  warn: "yellow",
  diffAdd: "green",
  diffDel: "red",
  muted: "gray",
  shark: "magenta",
  sharkEyeBg: "#1a1a1a",
};

/** Minimal palette: near-monochrome, one accent. */
const MINIMAL: Theme = {
  ...GROKNIGHT,
  brand: "#ededed",
  accent: "#7aa2f7",
  userBar: "#1a1a1a",
  tool: "#f5a623",
  think: "#555555",
  explore: "#00c853",
  error: "#ee0000",
  success: "#00c853",
  warn: "#f5a623",
  diffAdd: "#00c853",
  diffDel: "#ee0000",
  muted: "#555555",
  shark: "#ededed",
  sharkEyeBg: "#0a0a0a",
};

/** Nord palette (nordtheme.com colours). */
const NORD: Theme = {
  ...GROKNIGHT,
  brand: "#eceff4",
  accent: "#88c0d0",
  userBar: "#3b4252",
  tool: "#ebcb8b",
  think: "#4c566a",
  explore: "#a3be8c",
  error: "#bf616a",
  success: "#a3be8c",
  warn: "#ebcb8b",
  diffAdd: "#a3be8c",
  diffDel: "#bf616a",
  muted: "#4c566a",
  shark: "#81a1c1",
  sharkEyeBg: "#2e3440",
};

/** Brand light palette (tokens.ts `light`): every text slot ≥ 4.5:1 against white. */
const LIGHT: Theme = {
  brand: brand("light", "text"),
  accent: brand("light", "accent"),
  userBar: "#f1f5f9",
  tool: brand("light", "warn"),
  think: brand("light", "muted"),
  explore: "#0f766e",
  error: brand("light", "danger"),
  success: brand("light", "success"),
  warn: brand("light", "warn"),
  diffAdd: brand("light", "diffAdd"),
  diffDel: brand("light", "diffDel"),
  muted: brand("light", "muted"),
  faint: false,
  shark: "#475569",
  sharkEyeBg: "#f8fafc",
  pathMax: 42,
  toolDetailMax: 72,
  slashNameWidth: 16,
  noticeCollapseMin: 3,
  sym: {
    ...GROKNIGHT.sym,
  },
};

export const THEME_NAMES = ["groknight", "claude", "minimal", "nord", "light"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

const THEMES: Readonly<Record<ThemeName, Theme>> = {
  groknight: GROKNIGHT,
  claude: CLAUDE,
  minimal: MINIMAL,
  nord: NORD,
  light: LIGHT,
};

/** Resolve a named theme; unknown names fall back to the default. */
export function resolveTheme(name: string | undefined): Theme {
  if (name && name in THEMES) return THEMES[name as ThemeName];
  return GROKNIGHT;
}

/**
 * The active theme — resolved once at module load, mutable via `setTheme`.
 * Everything renders through this object.
 */
export const theme: Theme = { ...resolveTheme(process.env.XIO_THEME) };

export function setTheme(nameOrTheme: ThemeName | Theme): Theme {
  const next = typeof nameOrTheme === "string" ? resolveTheme(nameOrTheme) : nameOrTheme;
  Object.assign(theme, next);
  return theme;
}

export function getActiveThemeName(): ThemeName {
  for (const [name, candidate] of Object.entries(THEMES)) {
    if (candidate.accent === theme.accent && candidate.brand === theme.brand && candidate.error === theme.error) {
      return name as ThemeName;
    }
  }
  return "groknight";
}

/** Parse an OSC 11 response `\x1b]11;rgb:rrrr/gggg/bbbb\x07` into RGB and relative luminance. */
export function parseOsc11Color(response: string): { r: number; g: number; b: number; luminance: number } | undefined {
  const match = /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(response);
  if (!match) return undefined;
  const parseHex = (hex: string) => {
    if (hex.length >= 4) return parseInt(hex.slice(0, 2), 16);
    if (hex.length === 2) return parseInt(hex, 16);
    if (hex.length === 1) return parseInt(hex + hex, 16);
    return parseInt(hex.slice(0, 2), 16);
  };
  const r = parseHex(match[1]!) / 255;
  const g = parseHex(match[2]!) / 255;
  const b = parseHex(match[3]!) / 255;
  // Perceived relative luminance (WCAG definition)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
    luminance,
  };
}

export function isLuminanceLight(luminance: number): boolean {
  return luminance > 0.5;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  if (!hex.startsWith("#") || (hex.length !== 7 && hex.length !== 4)) return undefined;
  if (hex.length === 7) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }
  return {
    r: parseInt(hex[1]! + hex[1]!, 16),
    g: parseInt(hex[2]! + hex[2]!, 16),
    b: parseInt(hex[3]! + hex[3]!, 16),
  };
}

export function relativeLuminance(r: number, g: number, b: number): number {
  const srgb = [r / 255, g / 255, b / 255].map((v) => {
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!;
}

export function contrastRatio(hex1: string, hex2: string): number {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return 5.0;
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function checkThemeBackgroundMismatch(themeName: ThemeName, isLightBg: boolean): string | undefined {
  if (isLightBg && themeName !== "light") {
    return t("theme.mismatchLight", { name: themeName });
  }
  if (!isLightBg && themeName === "light") {
    return t("theme.mismatchDark");
  }
  return undefined;
}

export type TerminalBackgroundQueryOptions = Readonly<{
  timeoutMs?: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}>;

export type TerminalBackground = Readonly<{
  background: "light" | "dark" | undefined;
  /** Why `background` is undefined: the dark default applies and `xio doctor` says why. */
  reason?: "not-a-tty" | "no-color" | "unsupported" | "timeout" | `error: ${string}`;
  /** Keys the user typed while the query held stdin; the caller hands them to the composer. */
  typed: string;
}>;

const OSC11_REPLY = /\x1b\]11;rgb:[0-9a-fA-F]+\/[0-9a-fA-F]+\/[0-9a-fA-F]+(?:\x07|\x1b\\)?/;
const DA1_REPLY = /\x1b\[\?[0-9;]*c/;

/**
 * Ask the terminal for its background colour (OSC 11), followed by a DA1
 * query: every terminal answers DA1, so one that ignores OSC 11 ends the wait
 * early instead of holding the first paint for the whole timeout.
 */
export async function queryTerminalBackground(
  options: TerminalBackgroundQueryOptions = {},
): Promise<TerminalBackground> {
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return { background: undefined, reason: "no-color", typed: "" };
  if (env.TERM === "dumb") return { background: undefined, reason: "no-color", typed: "" };

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return { background: undefined, reason: "not-a-tty", typed: "" };

  const timeoutMs = options.timeoutMs ?? 20;
  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  let buffer = "";

  return new Promise<TerminalBackground>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<TerminalBackground, "typed">) => {
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw);
      if (wasPaused) stdin.pause();
      const typed = buffer.replace(OSC11_REPLY, "").replace(DA1_REPLY, "");
      resolve({ ...result, typed });
    };
    const detected = (): "light" | "dark" | undefined => {
      const color = parseOsc11Color(buffer);
      if (!color) return undefined;
      return isLuminanceLight(color.luminance) ? "light" : "dark";
    };
    // Replies arrive in query order, so the DA1 reply means the OSC 11 one (if any) is in;
    // stopping before it would leave the DA1 reply to land in the composer.
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (!DA1_REPLY.test(buffer)) return;
      const background = detected();
      finish(background ? { background } : { background: undefined, reason: "unsupported" });
    };

    try {
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
      timer = setTimeout(() => {
        const background = detected();
        finish(background ? { background } : { background: undefined, reason: "timeout" });
      }, timeoutMs);
      // tmux swallows OSC 11 unless it is wrapped in a DCS passthrough.
      const query = env.TMUX ? "\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\\x1b[c" : "\x1b]11;?\x07\x1b[c";
      stdout.write(query);
    } catch (error) {
      finish({ background: undefined, reason: `error: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
}

/**
 * Ink props for de-emphasised text. Uncoloured text takes the muted slot (contrast-checked);
 * coloured text is faded only where faint keeps it readable, so light terminals stay ≥ 4.5:1.
 */
export function quietText(color: ThemeColor | undefined, quiet: boolean): { color?: ThemeColor; dimColor: boolean } {
  if (!quiet) return { color, dimColor: false };
  if (color === undefined) return { color: theme.muted, dimColor: false };
  return { color, dimColor: theme.faint };
}

/** Single-line ellipsis for tool args on the transcript title row. */
export function truncateToolDetail(detail: string, maxLen = theme.toolDetailMax): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  if (maxLen <= 1) return "…";
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

/** Home → `~`; long paths get a middle ellipsis. */
export function formatShortCwd(cwd: string, maxLen = theme.pathMax): string {
  const home = homedir();
  let path = cwd;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    path = `~${cwd.slice(home.length)}`;
  }
  if (path.length <= maxLen) return path;
  const keep = maxLen - 1; // room for …
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

/** Fixed-width slash name column (clips with … when needed). */
export function padSlashName(name: string, width = theme.slashNameWidth): string {
  if (name.length <= width) return name.padEnd(width);
  if (width <= 1) return "…".slice(0, width);
  return `${name.slice(0, width - 1)}…`;
}

type NoticeLike = Readonly<{
  id: number;
  kind: string;
  text: string;
  error?: boolean;
}>;

/** Render-time collapse of consecutive `mcp:` notices (≥ noticeCollapseMin). */
export function collapseNoticesForDisplay<T extends NoticeLike>(entries: readonly T[]): T[] {
  const min = theme.noticeCollapseMin;
  const result: T[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.kind !== "notice" || entry.error || !entry.text.startsWith("mcp:")) {
      result.push(entry);
      index += 1;
      continue;
    }
    let end = index;
    while (
      end < entries.length
      && entries[end]!.kind === "notice"
      && !entries[end]!.error
      && entries[end]!.text.startsWith("mcp:")
    ) {
      end += 1;
    }
    const count = end - index;
    if (count >= min) {
      result.push({ ...entries[index]!, text: `mcp: ${count} ready` });
    } else {
      for (let cursor = index; cursor < end; cursor += 1) result.push(entries[cursor]!);
    }
    index = end;
  }
  return result;
}
