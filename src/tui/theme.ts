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
  }>;
}>;

/** grok-build `groknight` palette: neutral gray base + TokyoNight accents. */
const GROKNIGHT: Theme = {
  brand: "#bb9af7",
  accent: "#7dcfff",
  userBar: "#242424",
  tool: "#e0af68",
  think: "#7aa2f7",
  explore: "#9ece6a",
  error: "#f7768e",
  shark: "#bb9af7",
  sharkEyeBg: "#111111",
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
    prompt: ">",
    busy: "·",
    select: "›",
    nest: "└",
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
  shark: "magenta",
  sharkEyeBg: "#1a1a1a",
};

export const THEME_NAMES = ["groknight", "claude"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

const THEMES: Readonly<Record<ThemeName, Theme>> = { groknight: GROKNIGHT, claude: CLAUDE };

/** Resolve a named theme; unknown names fall back to the default. */
export function resolveTheme(name: string | undefined): Theme {
  if (name === "claude") return CLAUDE;
  return GROKNIGHT;
}

/**
 * The active theme — resolved once at module load from `XIO_THEME`.
 * Everything renders through this object, so a future theme loader only
 * needs to swap it before the first paint.
 */
export const theme: Theme = resolveTheme(process.env.XIO_THEME);

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
