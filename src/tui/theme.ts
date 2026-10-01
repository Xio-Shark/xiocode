/**
 * Semantic theme slots. Two palettes ship: `groknight` (default — neutral
 * gray base + TokyoNight-style accents, following grok-build's groknight)
 * and `claude` (the original magenta/cyan quiet theme). Select with
 * `XIO_THEME=groknight|claude`; unknown values fall back to groknight.
 */

import { homedir } from "node:os";

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

/** Modern minimalist palette: neutral platinum/slate base with subtle slate-blue accents. */
const GROKNIGHT: Theme = {
  brand: "#e2e8f0",
  accent: "#7aa2f7",
  userBar: "#1a1b26",
  tool: "#e0af68",
  think: "#565f89",
  explore: "#73daca",
  error: "#f7768e",
  success: "#9ece6a",
  warn: "#e0af68",
  diffAdd: "#9ece6a",
  diffDel: "#f7768e",
  muted: "#565f89",
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

/** Minimal palette: clean, focused, zero noise (inspired by Vercel/Linear). */
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

/** Nord palette: arctic, serene clean aesthetic (inspired by Nord Theme). */
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

/** Light palette: high contrast on light backgrounds (all text contrast ≥ 4.5:1 against #ffffff). */
const LIGHT: Theme = {
  brand: "#1e293b",
  accent: "#2563eb",
  userBar: "#f1f5f9",
  tool: "#b45309",
  think: "#64748b",
  explore: "#0f766e",
  error: "#dc2626",
  success: "#15803d",
  warn: "#b45309",
  diffAdd: "#15803d",
  diffDel: "#dc2626",
  muted: "#64748b",
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
    return `Theme mismatch: terminal background is light, but theme is "${themeName}". Tip: /theme light`;
  }
  if (!isLightBg && themeName === "light") {
    return `Theme mismatch: terminal background is dark, but theme is "light". Tip: /theme groknight`;
  }
  return undefined;
}

export type TerminalBackgroundQueryOptions = Readonly<{
  timeoutMs?: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}>;

export async function queryTerminalBackground(
  options: TerminalBackgroundQueryOptions = {},
): Promise<"light" | "dark" | undefined> {
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return undefined;
  if (env.TERM === "dumb") return undefined;

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return undefined;

  const timeoutMs = options.timeoutMs ?? 20;

  return new Promise<"light" | "dark" | undefined>((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | undefined;
    let buffer = "";

    let wasRaw: boolean | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        stdin.removeListener("data", onData);
        if (wasRaw !== undefined && stdin.setRawMode) {
          stdin.setRawMode(wasRaw);
        }
      } catch {}
    };

    const finish = (result: "light" | "dark" | undefined) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const color = parseOsc11Color(buffer);
      if (color) {
        finish(isLuminanceLight(color.luminance) ? "light" : "dark");
        return;
      }
      // DA1 response ends with 'c' — if received without OSC 11, terminal lacks OSC 11 support
      if (/\x1b\[\?[0-9;]*c/.test(buffer)) {
        finish(undefined);
      }
    };

    try {
      if (stdin.setRawMode) {
        wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
      }
      stdin.on("data", onData);
      stdin.resume();

      timer = setTimeout(() => {
        finish(undefined);
      }, timeoutMs);

      const isTmux = Boolean(env.TMUX);
      const osc = isTmux
        ? "\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\\x1b[c"
        : "\x1b]11;?\x07\x1b[c";

      stdout.write(osc);
    } catch {
      finish(undefined);
    }
  });
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
