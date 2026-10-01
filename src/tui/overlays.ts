import React from "react";
import { Box, Text } from "ink";

import { fuzzyFilter } from "./fuzzy.ts";
import { sliceViewerWindow } from "./composer.ts";
import { displayWidth } from "./text-selection.ts";
import { stripAnswerHint } from "./boot-shell.ts";
import { hasMessage, t } from "../i18n/messages.ts";
import type { SelectChoice } from "../runtime/interactive-io.ts";
import { formatDiffDetail, type FormattedDiffLine } from "./diff-render.ts";
import {
  type HistoryBlock,
  type InFlightSubagent,
  formatSubagentActivity,
  liveTextTail,
} from "./transcript-log.ts";
import {
  formatShortCwd,
  padSlashName,
  theme,
  THEME_NAMES,
  truncateToolDetail,
} from "./theme.ts";

const h = React.createElement;

export type SlashCommandGroup = "common" | "session" | "diagnostics";

export type SlashCommand = Readonly<{
  name: string;
  description: string;
  group?: SlashCommandGroup;
  weight?: number;
  aliases?: readonly string[];
  aliasFor?: string;
}>;

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "", group: "common", weight: 60 },
  { name: "exit", description: "", group: "session", weight: 100, aliases: ["quit"] },
  { name: "quit", description: "", aliasFor: "exit" },
  { name: "bypass", description: "", aliasFor: "permission" },
];

export const SLASH_MENU_VISIBLE = 8;

import {
  VIEWER_CHROME_ROWS,
  computeViewerViewport,
} from "./chrome-metrics.ts";

export { VIEWER_CHROME_ROWS };

/**
 * Viewer viewport height and last valid scroll offset — one formula shared by
 * the Ctrl+O overlay render and the scroll clamp in useSessionInteraction.
 */
export function viewerScrollBounds(block: HistoryBlock, rows: number): Readonly<{
  viewport: number;
  maxOffset: number;
}> {
  const body = block.output ?? block.lines.join("\n");
  const viewport = computeViewerViewport(rows);
  return { viewport, maxOffset: Math.max(0, body.split("\n").length - viewport) };
}

/** Ctrl+O overlay: retained thinking/tool/subagent output without mutating history. */
export function TranscriptViewerOverlay(props: Readonly<{
  block: HistoryBlock;
  rows: number;
  scrollOffset: number;
  historyIndex?: number;
  historyTotal: number;
  onClose: () => void;
}>): React.JSX.Element {
  const body = props.block.output ?? props.block.lines.join("\n");
  const lines = body.split("\n");
  const { viewport } = viewerScrollBounds(props.block, props.rows);
  const window = sliceViewerWindow(lines, viewport, props.scrollOffset);
  const title = props.block.kind === "thinking"
    ? `${t("viewer.thinking")}${props.block.thoughtSeconds ? ` · ${props.block.thoughtSeconds}s` : ""}`
    : props.block.kind === "notice"
      ? (props.block.title ?? t("viewer.recovery"))
      : props.block.title
        ? `${props.block.title}${props.block.detail ? ` ${truncateToolDetail(props.block.detail, 64)}` : ""}`
        : t("viewer.transcript");
  const position = props.historyIndex && props.historyTotal > 1
    ? ` ${props.historyIndex}/${props.historyTotal}`
    : "";
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    paddingX: 1,
    marginY: 1,
  },
    h(Text, { bold: true }, t("viewer.title", { position, title })),
    h(Text, { color: theme.muted }, t("viewer.keys")),
    window.indicator
      ? h(Text, { color: theme.muted }, window.indicator)
      : null,
    ...window.visible.map((line, index) =>
      h(Text, {
        key: `tv-${window.offset + index}`,
        color: props.block.error ? theme.error : undefined,
        wrap: "truncate-end",
      }, line || " ")));
}

/**
 * Live drill-in for one running explore worker (opened by double-click).
 * Shows the retained nested transcript tail + current stream, auto-following.
 */
export function SubagentDetailOverlay(props: Readonly<{
  worker: InFlightSubagent;
  rows: number;
  now: number;
}>): React.JSX.Element {
  const { worker } = props;
  const name = worker.name ?? worker.role ?? "explore";
  const role = worker.role ? ` [${worker.role}]` : "";
  const activity = formatSubagentActivity(worker, 48, props.now);
  const bodyLines: string[] = [...worker.lines];
  if (worker.live) {
    const label = worker.live.kind === "thinking" ? theme.sym.think : theme.sym.answer;
    const tail = liveTextTail(worker.live.buffer, 2_000);
    for (const row of tail.split("\n")) {
      bodyLines.push(`  ${label} ${row}`);
    }
  }
  // One extra chrome row vs the Ctrl+O viewer (goal line under the title).
  const viewport = Math.max(4, props.rows - VIEWER_CHROME_ROWS - 1);
  const visible = bodyLines.slice(-viewport);
  const hiddenAbove = bodyLines.length - visible.length;
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: theme.explore,
    paddingX: 1,
    marginY: 1,
  },
    h(Text, { bold: true, color: theme.explore },
      `${theme.sym.explore} ${t("subagent.title", { id: worker.workerId })} · ${name}${role} · ${worker.model} ${theme.sym.meta} ${activity}`),
    h(Text, { color: theme.muted, wrap: "truncate-end" },
      t("subagent.goal", { goal: worker.goal })),
    h(Text, { color: theme.muted }, t("subagent.live")),
    hiddenAbove > 0
      ? h(Text, { color: theme.muted }, t("subagent.hidden", { count: hiddenAbove }))
      : null,
    ...visible.map((line, index) =>
      h(Text, {
        key: `sd-${hiddenAbove + index}`,
        color: theme.muted,
        wrap: "truncate-end",
      }, line || " ")));
}

export function TasklistPanel(props: Readonly<{ lines: readonly string[] }>): React.JSX.Element {
  return h(Box, {
    flexDirection: "column",
    marginTop: 1,
    borderStyle: "single",
    borderColor: theme.muted,
    paddingX: 1,
  },
    ...props.lines.map((line, index) =>
      h(Text, { key: `tl-${index}`, color: index > 0 ? theme.muted : undefined, wrap: "truncate-end" }, line)));
}

export type FooterParts = Readonly<{
  permissionMode: string;
  cwd: string;
  /** Context occupancy, e.g. "ctx:42%". */
  context?: string;
  /** Active explore subagents, e.g. "← 3 agents". */
  explore?: string;
  turn?: string;
  mcp?: string;
  workspace?: string;
}>;

export type FooterLayout = Readonly<{
  /** Permission mode label; absent in the default (auto) mode. */
  mode?: string;
  hint?: string;
  left: readonly string[];
  right: readonly string[];
}>;

const FOOTER_SEP = " · ";
/** Shortest the path is squeezed to before whole segments start to go. */
const FOOTER_PATH_MIN = 12;

function footerWidth(layout: FooterLayout): number {
  const left = [layout.mode, layout.hint, ...layout.left].filter((part): part is string => Boolean(part));
  const leftWidth = left.reduce((sum, part) => sum + displayWidth(part), 0) + FOOTER_SEP.length * Math.max(0, left.length - 1);
  const rightWidth = layout.right.reduce((sum, part) => sum + displayWidth(part), 0)
    + FOOTER_SEP.length * Math.max(0, layout.right.length - 1);
  return leftWidth + (layout.right.length > 0 ? 1 + rightWidth : 0);
}

/**
 * Fit the footer into `columns` by dropping the least useful item first:
 * key hint → turn count → the middle of the path → mcp → workspace.
 * The permission mode and the context gauge are never dropped.
 */
export function layoutFooter(parts: FooterParts, columns: number): FooterLayout {
  const elevated = !isDefaultPermissionMode(parts.permissionMode);
  const modeKey = `mode.${parts.permissionMode}`;
  const modeName = hasMessage(modeKey) ? t(modeKey) : parts.permissionMode;
  const mode = elevated ? (parts.permissionMode === "full" ? `⚠ ${modeName}` : modeName) : undefined;
  const build = (opts: Readonly<{ hint: boolean; turn: boolean; pathMax: number; mcp: boolean; workspace: boolean }>): FooterLayout => ({
    mode,
    hint: opts.hint ? (elevated ? t("footer.cycle") : t("footer.shortcuts")) : undefined,
    left: [formatShortCwd(parts.cwd, opts.pathMax), parts.context, opts.turn ? parts.turn : undefined, parts.explore]
      .filter((part): part is string => Boolean(part)),
    right: [opts.workspace ? parts.workspace : undefined, opts.mcp ? parts.mcp : undefined]
      .filter((part): part is string => Boolean(part)),
  });
  let opts = { hint: true, turn: true, pathMax: theme.pathMax, mcp: true, workspace: true };
  let layout = build(opts);
  if (footerWidth(layout) <= columns) return layout;
  opts = { ...opts, hint: false };
  layout = build(opts);
  if (footerWidth(layout) <= columns) return layout;
  opts = { ...opts, turn: false };
  layout = build(opts);
  while (footerWidth(layout) > columns && opts.pathMax > FOOTER_PATH_MIN) {
    opts = { ...opts, pathMax: opts.pathMax - 1 };
    layout = build(opts);
  }
  if (footerWidth(layout) <= columns) return layout;
  opts = { ...opts, mcp: false };
  layout = build(opts);
  if (footerWidth(layout) <= columns) return layout;
  return build({ ...opts, workspace: false });
}

/** Colour of the permission mode label: danger for full, neutral otherwise (the word carries it too). */
export function footerModeColor(mode: string): string {
  return mode === "full" ? theme.error : theme.muted;
}

/**
 * Footer: permission mode only when non-default (full in the danger colour with a ⚠),
 * then path, context, turn and explore on the left; workspace and mcp on the right.
 * Narrow terminals drop items in the order `layoutFooter` documents.
 */
export function FooterHints(props: Readonly<{
  permissionMode: string;
  cwd: string;
  /** Terminal width the footer has to fit in. */
  columns: number;
  context?: string;
  /** Context occupancy of the latest request, e.g. "ctx:42%". */
  usage?: string;
  /** Active explore subagents, e.g. "subs:3". */
  explore?: string;
  workspace?: string;
  mcp?: string;
  /** Completed user turns (grok status-bar parity). */
  turn?: number;
}>): React.JSX.Element {
  const layout = layoutFooter({
    permissionMode: props.permissionMode,
    cwd: props.cwd,
    context: props.context ?? props.usage,
    explore: props.explore ? formatExploreFooter(props.explore) : undefined,
    turn: props.turn !== undefined && props.turn > 0 ? t("footer.turn", { count: props.turn }) : undefined,
    mcp: formatMcpFooter(props.mcp),
    workspace: formatWorkspaceFooter(props.workspace),
  }, props.columns);
  const lead = [
    layout.mode ? h(Text, { key: "mode", color: footerModeColor(props.permissionMode), bold: props.permissionMode === "full" }, layout.mode) : null,
    layout.hint ? h(Text, { key: "hint", color: theme.muted }, layout.hint) : null,
  ].filter((node) => node !== null);
  const items = [...lead, ...layout.left.map((part, index) => h(Text, { key: `l${index}`, color: theme.muted }, part))];

  return h(Box, {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 1,
    marginTop: 1,
  },
    h(Text, { wrap: "truncate-end" },
      ...items.flatMap((node, index) => index === 0 ? [node] : [h(Text, { key: `s${index}`, color: theme.muted }, FOOTER_SEP), node])),
    layout.right.length > 0
      ? h(Text, { color: theme.muted, wrap: "truncate-end" }, layout.right.join(FOOTER_SEP))
      : null);
}

/** Default permission mode stays quiet in the footer (Claude parity). */
export function isDefaultPermissionMode(mode: string): boolean {
  return mode === "auto";
}

/** Map statuses.explore ("subs:3") → "← 3 agents" for footer parity with Claude. */
export function formatExploreFooter(explore: string): string {
  const match = /^subs:(\d+)$/.exec(explore.trim());
  if (!match) return explore;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return explore;
  return count === 1 ? t("footer.agent") : t("footer.agents", { count });
}

/** Short workspace badge for footer (never scream-red in the header). */
export function formatWorkspaceFooter(workspace?: string): string | undefined {
  if (!workspace) return undefined;
  const lower = workspace.toLowerCase();
  if (lower.includes("worktree")) return t("footer.worktree");
  if (lower.includes("direct")) return t("footer.direct");
  return workspace;
}

/** Compact MCP status for footer right side. */
export function formatMcpFooter(mcp?: string): string | undefined {
  if (!mcp) return undefined;
  const ready = /^mcp:ready\((\d+)\)$/.exec(mcp.trim());
  if (ready) return t("footer.mcpReady", { n: ready[1]! });
  const mixed = /^mcp:(\d+)ok\/(\d+)fail$/.exec(mcp.trim());
  if (mixed) return t("footer.mcpMixed", { ok: mixed[1]!, fail: mixed[2]! });
  if (mcp.startsWith("mcp:connecting")) return t("footer.mcpConnecting");
  return mcp.startsWith("mcp:") ? mcp.slice(4) : mcp;
}

export function SlashMenu(props: Readonly<{
  items: readonly SlashCommand[];
  selected: number;
}>): React.JSX.Element {
  if (props.items.length === 0) {
    return h(Box, {
      flexDirection: "column",
      marginBottom: 1,
    }, h(Text, { color: theme.muted }, t("menu.noCommands")));
  }
  const start = Math.min(
    Math.max(0, props.selected - SLASH_MENU_VISIBLE + 1),
    Math.max(0, props.items.length - SLASH_MENU_VISIBLE),
  );
  const visible = props.items.slice(start, start + SLASH_MENU_VISIBLE);
  return h(Box, {
    flexDirection: "column",
    marginBottom: 1,
  },
    ...visible.map((item, index) => {
      const absolute = start + index;
      const active = absolute === props.selected;
      const nameCol = padSlashName(item.name);
      const label = item.description ? `${nameCol}  ${item.description}` : nameCol;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: item.name,
        color: active ? theme.accent : theme.muted,
        bold: active,
        wrap: "truncate-end",
      }, `${marker}${label}`);
    }),
    h(Text, { color: theme.muted },
      t("menu.slashKeys", { index: props.selected + 1, total: props.items.length })));
}

/** `@` file picker rendered above the composer (same window size as SlashMenu). */
export function FileMenu(props: Readonly<{
  items: readonly string[];
  selected: number;
}>): React.JSX.Element {
  if (props.items.length === 0) {
    return h(Box, {
      flexDirection: "column",
      marginBottom: 1,
    }, h(Text, { color: theme.muted }, t("menu.noFiles")));
  }
  const start = Math.min(
    Math.max(0, props.selected - SLASH_MENU_VISIBLE + 1),
    Math.max(0, props.items.length - SLASH_MENU_VISIBLE),
  );
  const visible = props.items.slice(start, start + SLASH_MENU_VISIBLE);
  return h(Box, {
    flexDirection: "column",
    marginBottom: 1,
  },
    ...visible.map((item, index) => {
      const absolute = start + index;
      const active = absolute === props.selected;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: item,
        color: active ? theme.accent : theme.muted,
        bold: active,
        wrap: "truncate-end",
      }, `${marker}${item}`);
    }),
    h(Text, { color: theme.muted },
      t("menu.fileKeys", { index: props.selected + 1, total: props.items.length })));
}

export function slashGroupPriority(group?: string): number {
  if (group === "common") return 0;
  if (group === "session") return 1;
  if (group === "diagnostics") return 2;
  return 1; // default to session
}

export function formatSlashDescription(description: string, aliases?: readonly string[]): string {
  if (!aliases || aliases.length === 0) return description;
  const aliasPart = t("slash.aliases", { aliases: aliases.map((a) => `/${a}`).join(", ") });
  if (!description) return aliasPart;
  return `${description} ${aliasPart}`;
}

/**
 * Built-in commands are described in the interface language (`slash.<name>`). A description
 * that is not the stock English one came from an extension overriding the command, and is kept.
 */
export function slashDescription(name: string, registered: string): string {
  const key = `slash.${name}`;
  if (!hasMessage(key)) return registered;
  const vars = name === "theme" ? { names: THEME_NAMES.join("|") } : undefined;
  if (registered.trim() !== "" && registered !== t(key, vars, "en")) return registered;
  return t(key, vars);
}

export function slashFuzzySelector(command: SlashCommand): string {
  const aliasStr = command.aliases && command.aliases.length > 0
    ? ` ${command.aliases.map((a) => `/${a}`).join(" ")}`
    : "";
  return `/${command.name}${aliasStr}`;
}

/**
 * Command palette (Ctrl+P): searchable slash commands + built-in actions.
 * Filtering is substring on the label; Enter runs the picked command through
 * the same path as typing it.
 */
export function CommandPalette(props: Readonly<{
  query: string;
  selected: number;
  entries: readonly SlashCommand[];
}>): React.JSX.Element {
  const filtered = fuzzyFilter(props.entries, props.query, slashFuzzySelector);
  if (filtered.length === 0) {
    return h(Box, {
      flexDirection: "column",
      marginBottom: 1,
    },
      h(Text, { color: theme.accent, bold: true }, `/${props.query}`),
      h(Text, { color: theme.muted }, t("menu.paletteEmpty")));
  }
  const safeIndex = Math.min(props.selected, filtered.length - 1);
  const start = Math.min(
    Math.max(0, safeIndex - SLASH_MENU_VISIBLE + 1),
    Math.max(0, filtered.length - SLASH_MENU_VISIBLE),
  );
  const visible = filtered.slice(start, start + SLASH_MENU_VISIBLE);
  return h(Box, {
    flexDirection: "column",
    marginBottom: 1,
  },
    h(Text, { color: theme.accent, bold: true }, `/${props.query}`),
    ...visible.map((item, index) => {
      const absolute = start + index;
      const active = absolute === safeIndex;
      const nameCol = padSlashName(item.name);
      const label = item.description ? `${nameCol}  ${item.description}` : nameCol;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: item.name,
        color: active ? theme.accent : theme.muted,
        bold: active,
        wrap: "truncate-end",
      }, `${marker}${label}`);
    }),
    h(Text, { color: theme.muted },
      t("menu.paletteKeys", { index: safeIndex + 1, total: filtered.length })));
}

/** Exported for unit tests. */
export function slashQuery(input: string): string | undefined {
  const match = /^\/(\S*)$/.exec(input);
  return match ? match[1] : undefined;
}

/** Exported for unit tests. */
export function collectSlashCommands(host: { listCommandEntries(): readonly SlashCommand[] }): readonly SlashCommand[] {
  const map = new Map<string, SlashCommand>();
  for (const command of BUILTIN_SLASH_COMMANDS) map.set(command.name, { ...command });
  for (const command of host.listCommandEntries()) {
    const existing = map.get(command.name);
    map.set(command.name, {
      name: command.name,
      description: command.description.trim() || existing?.description || "",
      group: command.group ?? existing?.group,
      weight: command.weight ?? existing?.weight,
      aliases: command.aliases ?? existing?.aliases,
      aliasFor: command.aliasFor ?? existing?.aliasFor,
    });
  }

  // Gather alias-to-primary mappings
  const aliasToPrimary = new Map<string, string>();
  for (const [name, command] of map.entries()) {
    if (command.aliasFor && map.has(command.aliasFor)) {
      aliasToPrimary.set(name, command.aliasFor);
    }
    if (command.aliases) {
      for (const alias of command.aliases) {
        if (map.has(alias)) {
          aliasToPrimary.set(alias, name);
        }
      }
    }
  }

  // Merge alias names into primary command's aliases array
  for (const [aliasName, primaryName] of aliasToPrimary.entries()) {
    const primary = map.get(primaryName);
    if (primary) {
      const currentAliases = new Set(primary.aliases ?? []);
      currentAliases.add(aliasName);
      map.set(primaryName, {
        ...primary,
        aliases: [...currentAliases],
      });
    }
  }

  // Build the list of primary commands (excluding absorbed aliases)
  const primaryCommands: SlashCommand[] = [];
  for (const [name, command] of map.entries()) {
    if (aliasToPrimary.has(name) && aliasToPrimary.get(name) !== name) {
      continue;
    }
    primaryCommands.push({
      ...command,
      description: formatSlashDescription(slashDescription(command.name, command.description), command.aliases),
    });
  }

  // Sort by group priority, then weight descending, then alphabetical name
  return primaryCommands.sort((a, b) => {
    const groupDiff = slashGroupPriority(a.group) - slashGroupPriority(b.group);
    if (groupDiff !== 0) return groupDiff;
    const weightA = a.weight ?? 0;
    const weightB = b.weight ?? 0;
    if (weightA !== weightB) return weightB - weightA;
    return a.name.localeCompare(b.name);
  });
}

/** Exported for unit tests. Returns undefined when slash menu should be hidden. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string | undefined,
): readonly SlashCommand[] | undefined {
  if (query === undefined) return undefined;
  return fuzzyFilter(commands, query, slashFuzzySelector);
}

export function DiffLine({ line }: Readonly<{ line: FormattedDiffLine | string }>): React.JSX.Element {
  if (typeof line === "string") {
    const isAdd = line.startsWith("+") && !line.startsWith("+++");
    const isDel = line.startsWith("-") && !line.startsWith("---");
    const color = isAdd ? theme.diffAdd : isDel ? theme.diffDel : undefined;
    return h(Text, { color, wrap: "truncate-end" }, line || " ");
  }

  let color: string | undefined;
  let bold = false;

  switch (line.type) {
    case "file-header":
      color = theme.brand;
      bold = true;
      break;
    case "hunk-header":
      color = theme.accent;
      break;
    case "add":
      color = theme.diffAdd;
      break;
    case "del":
      color = theme.diffDel;
      break;
    case "context":
      color = theme.muted;
      break;
    case "plain":
    default:
      break;
  }

  return h(Text, { color, bold, wrap: "truncate-end" }, line.text || " ");
}

/**
 * Every approval: question, the detail it is about (a numbered, coloured diff when the
 * detail is a patch), then the choices with what each one covers. Keys are listed in
 * the frame; Esc always declines.
 */
export function ConfirmView(props: Readonly<{
  confirm: Readonly<{
    question: string;
    detail?: string;
    scroll: number;
    selected: number;
    choices: readonly SelectChoice[];
    scope?: string;
  }>;
  rows: number;
}>): React.JSX.Element {
  const { confirm } = props;
  const formattedLines = formatDiffDetail(confirm.detail ?? "");
  const choices = confirm.choices;
  const selected = Math.min(Math.max(0, confirm.selected), choices.length - 1);

  // Reserve: question, frame border (2), choices, key line, scroll caption.
  const baseReserve = 7 + choices.length;
  const provisional = Math.max(3, props.rows - baseReserve);
  const needsScroll = formattedLines.length > provisional;
  const visibleCount = Math.max(3, props.rows - baseReserve - (needsScroll ? 1 : 0));
  const maxScroll = Math.max(0, formattedLines.length - visibleCount);
  const scroll = Math.min(confirm.scroll, maxScroll);
  const visible = formattedLines.slice(scroll, scroll + visibleCount);
  const endLine = Math.min(scroll + visibleCount, formattedLines.length);
  const offers = (value: string) => choices.some((choice) => choice.value === value);
  const keys = [
    t("confirm.choose"),
    t("confirm.enter"),
    ...(offers("once") ? [t("confirm.yes")] : []),
    offers("deny") ? t("confirm.no") : t("confirm.cancel"),
    ...(maxScroll > 0 ? [t("confirm.scroll")] : []),
  ];

  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true },
      stripAnswerHint(confirm.question),
      confirm.scope ? h(Text, { color: theme.muted }, `  [${confirm.scope}]`) : null,
    ),
    visible.length > 0
      ? h(Box, { flexDirection: "column", borderStyle: "single", borderColor: theme.muted },
        ...visible.map((line, index) => h(DiffLine, { key: `${scroll + index}-${line.rawText}`, line })))
      : null,
    maxScroll > 0
      ? h(Text, { color: theme.muted }, t("confirm.lines", { from: scroll + 1, to: endLine, total: formattedLines.length }))
      : null,
    h(Box, { flexDirection: "column" },
      ...choices.map((choice, index) => {
        const active = index === selected;
        const marker = active ? `${theme.sym.select} ` : "  ";
        return h(Text, { key: `${choice.value}-${index}`, wrap: "truncate-end" },
          h(Text, { color: active ? theme.accent : undefined, bold: active }, `${marker}${choice.label}`),
          choice.scope ? h(Text, { color: theme.muted }, `  ${choice.scope}`) : null);
      }),
    ),
    h(Text, { color: theme.muted, wrap: "truncate-end" }, keys.join(" · ")),
  );
}

