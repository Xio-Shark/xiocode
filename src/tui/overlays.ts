import React from "react";
import { Box, Text } from "ink";

import { fuzzyFilter } from "./fuzzy.ts";
import { sliceViewerWindow } from "./composer.ts";
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
  truncateToolDetail,
} from "./theme.ts";

const h = React.createElement;

export type SlashCommand = Readonly<{ name: string; description: string }>;

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show available commands." },
  {
    name: "bypass",
    description: "Alias for /permission full; unsafe shell and merge/rollback still confirm.",
  },
  { name: "exit", description: "End the session." },
  { name: "quit", description: "Alias for /exit." },
];

export const SLASH_MENU_VISIBLE = 8;

/**
 * Rows consumed by chrome around the Ctrl+O overlay: brand header (4) +
 * overlay margins/border/title/hint/indicator (7) + composer (5) + footer (2).
 * The viewer viewport must leave this room or the frame exceeds the terminal
 * and Ink leaves residue on close.
 */
export const VIEWER_CHROME_ROWS = 18;

/**
 * Viewer viewport height and last valid scroll offset — one formula shared by
 * the Ctrl+O overlay render and the scroll clamp in useSessionInteraction.
 */
export function viewerScrollBounds(block: HistoryBlock, rows: number): Readonly<{
  viewport: number;
  maxOffset: number;
}> {
  const body = block.output ?? block.lines.join("\n");
  const viewport = Math.max(4, rows - VIEWER_CHROME_ROWS);
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
    ? `Thinking${props.block.thoughtSeconds ? ` · ${props.block.thoughtSeconds}s` : ""}`
    : props.block.title
      ? `${props.block.title}${props.block.detail ? ` ${truncateToolDetail(props.block.detail, 64)}` : ""}`
      : "transcript";
  const position = props.historyIndex && props.historyTotal > 1
    ? ` ${props.historyIndex}/${props.historyTotal}`
    : "";
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    paddingX: 1,
    marginY: 1,
  },
    h(Text, { bold: true }, `Transcript${position} · ${title}`),
    h(Text, { dimColor: true }, "←/→ history · ↑↓/PgUp/PgDn scroll · Ctrl+O/Esc close"),
    window.indicator
      ? h(Text, { dimColor: true }, window.indicator)
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
      `${theme.sym.explore} subagent #${worker.workerId} · ${name}${role} · ${worker.model} ${theme.sym.meta} ${activity}`),
    h(Text, { dimColor: true, wrap: "truncate-end" },
      `goal: ${worker.goal}`),
    h(Text, { dimColor: true }, "live · follows latest · Ctrl+O/Esc close"),
    hiddenAbove > 0
      ? h(Text, { dimColor: true }, `… ${hiddenAbove} earlier lines (full transcript via Ctrl+O when done)`)
      : null,
    ...visible.map((line, index) =>
      h(Text, {
        key: `sd-${hiddenAbove + index}`,
        dimColor: true,
        wrap: "truncate-end",
      }, line || " ")));
}

export function TasklistPanel(props: Readonly<{ lines: readonly string[] }>): React.JSX.Element {
  return h(Box, {
    flexDirection: "column",
    marginTop: 1,
    borderStyle: "single",
    borderColor: "gray",
    paddingX: 1,
  },
    ...props.lines.map((line, index) =>
      h(Text, { key: `tl-${index}`, dimColor: index > 0, wrap: "truncate-end" }, line)));
}

/**
 * Claude-style footer: elevate permission only when non-default;
 * always show path + context/usage; workspace/mcp stay dim on the right.
 */
export function FooterHints(props: Readonly<{
  permissionMode: string;
  cwd: string;
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
  const elevated = !isDefaultPermissionMode(props.permissionMode);
  const modeLabel = `permissions ${props.permissionMode} on`;
  const path = formatShortCwd(props.cwd);
  const contextLabel = props.context ?? props.usage;
  const exploreLabel = props.explore ? formatExploreFooter(props.explore) : undefined;
  const workspaceLabel = formatWorkspaceFooter(props.workspace);
  const mcpLabel = formatMcpFooter(props.mcp);
  const turnLabel = props.turn !== undefined && props.turn > 0 ? `turn ${props.turn}` : undefined;

  const rightParts = [workspaceLabel, mcpLabel].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  return h(Box, {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 1,
    marginTop: 1,
  },
    h(Text, { wrap: "truncate-end" },
      elevated
        ? h(React.Fragment, null,
          h(Text, { color: theme.accent, bold: true }, `[${props.permissionMode}] `),
          h(Text, null, modeLabel),
          h(Text, { dimColor: true }, " (shift+tab to cycle)"))
        : h(Text, { dimColor: true }, "? for shortcuts"),
      h(Text, { dimColor: true }, ` ${theme.sym.meta} ${path}`),
      contextLabel
        ? h(Text, { dimColor: true }, ` ${theme.sym.meta} ${contextLabel}`)
        : null,
      turnLabel
        ? h(Text, { dimColor: true }, ` ${theme.sym.meta} ${turnLabel}`)
        : null,
      exploreLabel
        ? h(Text, { dimColor: true }, ` ${theme.sym.meta} ${exploreLabel}`)
        : null),
    rightParts.length > 0
      ? h(Text, { dimColor: true, wrap: "truncate-end" },
        rightParts.join(` ${theme.sym.meta} `))
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
  return `← ${count} agent${count === 1 ? "" : "s"}`;
}

/** Short workspace badge for footer (never scream-red in the header). */
export function formatWorkspaceFooter(workspace?: string): string | undefined {
  if (!workspace) return undefined;
  const lower = workspace.toLowerCase();
  if (lower.includes("worktree")) return "worktree";
  if (lower.includes("direct")) return "direct";
  return workspace;
}

/** Compact MCP status for footer right side. */
export function formatMcpFooter(mcp?: string): string | undefined {
  if (!mcp) return undefined;
  const ready = /^mcp:ready\((\d+)\)$/.exec(mcp.trim());
  if (ready) return `${ready[1]} mcp`;
  const mixed = /^mcp:(\d+)ok\/(\d+)fail$/.exec(mcp.trim());
  if (mixed) return `mcp ${mixed[1]}ok/${mixed[2]}fail`;
  if (mcp.startsWith("mcp:connecting")) return "mcp…";
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
    }, h(Text, { dimColor: true }, "No matching commands"));
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
        color: active ? theme.accent : undefined,
        bold: active,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${label}`);
    }),
    h(Text, { dimColor: true },
      `(${props.selected + 1}/${props.items.length}) ↑↓ · Tab · Enter`));
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
    }, h(Text, { dimColor: true }, "No matching files"));
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
        color: active ? theme.accent : undefined,
        bold: active,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${item}`);
    }),
    h(Text, { dimColor: true },
      `(${props.selected + 1}/${props.items.length}) ↑↓ · Tab/Enter insert · Esc`));
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
  const filtered = fuzzyFilter(props.entries, props.query, (entry) => `/${entry.name}`);
  if (filtered.length === 0) {
    return h(Box, {
      flexDirection: "column",
      marginBottom: 1,
    },
      h(Text, { color: theme.accent, bold: true }, `/${props.query}`),
      h(Text, { dimColor: true }, "No matching commands · esc close"));
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
        color: active ? theme.accent : undefined,
        bold: active,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${label}`);
    }),
    h(Text, { dimColor: true },
      `(${safeIndex + 1}/${filtered.length}) ↑↓ · Enter · esc close`));
}

/** Exported for unit tests. */
export function slashQuery(input: string): string | undefined {
  const match = /^\/(\S*)$/.exec(input);
  return match ? match[1] : undefined;
}

/** Exported for unit tests. */
export function collectSlashCommands(host: { listCommandEntries(): readonly SlashCommand[] }): readonly SlashCommand[] {
  const map = new Map<string, SlashCommand>();
  for (const command of BUILTIN_SLASH_COMMANDS) map.set(command.name, command);
  for (const command of host.listCommandEntries()) {
    map.set(command.name, {
      name: command.name,
      description: command.description.trim() || map.get(command.name)?.description || "",
    });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Exported for unit tests. Returns undefined when slash menu should be hidden. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string | undefined,
): readonly SlashCommand[] | undefined {
  if (query === undefined) return undefined;
  const needle = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle));
}

export function DiffLine({ line }: Readonly<{ line: string }>): React.JSX.Element {
  const color = line.startsWith("+") && !line.startsWith("+++")
    ? "green"
    : line.startsWith("-") && !line.startsWith("---") ? theme.error : undefined;
  return h(Text, { color, wrap: "truncate-end" }, line || " ");
}

export function ConfirmView(props: Readonly<{
  confirm: Readonly<{ question: string; detail: string; scroll: number }>;
  rows: number;
}>): React.JSX.Element {
  const sourceLines = props.confirm.detail.split("\n");
  const allLines = sourceLines.length > 4_000
    ? [...sourceLines.slice(0, 3_999), "(diff truncated at 4000 lines)"]
    : sourceLines;
  // App chrome (~7) + question + border + Yes/No; +1 more when a scroll caption is needed.
  const baseReserve = 11;
  const provisional = Math.max(4, props.rows - baseReserve);
  const needsScroll = allLines.length > provisional;
  const visibleCount = Math.max(4, props.rows - baseReserve - (needsScroll ? 1 : 0));
  const maxScroll = Math.max(0, allLines.length - visibleCount);
  const scroll = Math.min(props.confirm.scroll, maxScroll);
  const visible = allLines.slice(scroll, scroll + visibleCount);
  const endLine = Math.min(scroll + visibleCount, allLines.length);
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true }, props.confirm.question),
    h(Box, { flexDirection: "column", borderStyle: "single" },
      ...visible.map((line, index) => h(DiffLine, { key: `${scroll + index}-${line}`, line }))),
    maxScroll > 0
      ? h(Text, { dimColor: true }, `lines ${scroll + 1}–${endLine}/${allLines.length}`)
      : null,
    h(Text, { bold: true }, "Yes / No"));
}
