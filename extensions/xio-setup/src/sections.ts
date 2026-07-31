/**
 * Optional config.toml sections managed by `xio-setup`.
 *
 * The core template (src/cli/default-config.ts) stays minimal: general +
 * providers only. Everything here is opt-in and appended on demand with the
 * same safe defaults the parser already uses when the section is absent —
 * adding a section never changes behavior until the user edits values.
 */

export type ConfigSectionId =
  | "worktree"
  | "explore"
  | "permissions"
  | "tools"
  | "trust"
  | "mcp"
  | "improve"
  | "regress"
  | "agent"
  | "context"
  | "retrospective";

export type ConfigSection = Readonly<{
  id: ConfigSectionId;
  /** One-line menu label. */
  title: string;
  /** TOML block appended to config.toml (safe defaults + doc comments). */
  toml: string;
}>;

export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  {
    id: "worktree",
    title: "Outer worktree sandbox (opt-in isolation before merge)",
    toml: `# Outer worktree sandbox is opt-in. Default: run in the launch directory (git optional).
[worktree]
enabled = false
retain_on_reject = false
# allow_dirty = true   # only matters when enabled = true`,
  },
  {
    id: "explore",
    title: "Multi-explore scouts (parallel read-only subagents)",
    toml: `# Multi-explore scouts: primary keeps the session; workers survey tiny read-only slices.
# thinking=ultra FORCE-ENABLES explore even when enabled=false (uses explore.model, else session primary).
# Non-ultra sessions: set enabled=true + model to opt in (enabled=false alone never installs explore).
# max_concurrency counts WORKERS only (1–16) — not the primary process.
# Adaptive lanes: fast(0) / standard(2–4) / deep(4–8, ultra) / explicit_high(≤16, user-only).
[explore]
enabled = false
# model = "provider/<verified-low-cost-model>"  # REQUIRED when enabled = true
# max_turns = 12
# max_concurrency = 16
# max_output_chars = 64000          # worker report char cap toward EvidenceStore/brief path
# max_tokens = 250000               # soft wave token budget; 0 = unlimited
# max_cost_usd = 1                  # soft USD estimate across workers; 0 = unlimited
# max_starts_per_minute = 24        # worker starts / rolling minute; 0 = unlimited
# partition_hint = "按 API 边界拆成小片；用户另有说明时以用户为准"
# timeout_ms = 180000
# allow_bash = false                # keep false: workers stay read/grep/glob only`,
  },
  {
    id: "permissions",
    title: "Permissions (high-risk bash/MCP without session ask)",
    toml: `[permissions]
allow_high_risk = false  # set true for non-interactive bash/MCP without session ask`,
  },
  {
    id: "tools",
    title: "Tool guards (read-before-edit)",
    toml: `[tools]
require_read_before_edit = true  # set false to allow edit/overwrite without a prior read`,
  },
  {
    id: "trust",
    title: "Project trust gate (untrusted cwd restrictions)",
    toml: `# Project trust gate: untrusted cwd skips project hooks/skills/MCP and restricts write/exec.
# Decisions persist in ~/.xiocode/trust.json (normalized paths; revocable).
[trust]
mode = "ask"    # ask (default) | trust (always allow) | off (disable gate / dogfood)`,
  },
  {
    id: "mcp",
    title: "MCP import & timeouts",
    toml: `[mcp]
unknown_source_fail_closed = false  # set true to skip Claude/Cursor user MCP auto-import
# read_cursor = true               # auto-loads ~/.cursor/mcp.json (broken command paths will warn)
# timeout_ms = 30000               # per-server connect/listTools; close force-kills stdio after ~1.5s`,
  },
  {
    id: "improve",
    title: "Self-improve gate (xio improve)",
    toml: `[improve]
capability_gate = false  # set true so bare xio improve requires trusted PASS before merge ask
# private_case = "last"  # optional; "last" or a 64-char case id (requires capability_gate)`,
  },
  {
    id: "regress",
    title: "Failure-signal capture offers (private regressions)",
    toml: `# Failure-signal capture offer (rollback / hard steer / turn failed). Verdict stays human.
[regress]
offer_on_failure = true  # set false to silence offers; /regress manual path unchanged`,
  },
  {
    id: "agent",
    title: "Agent-loop tool scheduling (streaming tools)",
    toml: `# When true, tools start as soon as complete tool_calls arrive on the provider stream.
[agent]
streaming_tools = false`,
  },
  {
    id: "context",
    title: "Context / tool_result pressure budgets",
    toml: `# Oversized tool bodies spill under the run dir (or ~/.xiocode/spills) and become stubs.
# keep_tool_rounds microcompacts older tool rounds.
[context]
tool_result_max_chars = 16000
keep_tool_rounds = 4          # microcompact: keep newest N tool rounds; 0 = off`,
  },
  {
    id: "retrospective",
    title: "Post-task retrospective (drafts, session-end report)",
    toml: `# Post-task retrospective: agent_end = preflight only; session_end = authoritative report.
# norms_auto_write=true still requires strong confirm — never silent write.
[retrospective]
enabled = true
skip_trivial = true
min_tool_calls = 1
auto_inject = true
enqueue_improve = true
use_llm = false                 # reserved; deterministic wash always runs
session_end_subagent = true     # authoritative LLM/deterministic report on session_end
# model = "deepseek-chat"       # optional cheap model for session-end subagent
session_end_timeout_ms = 45000
norms_auto_write = false        # drafts only unless true + strong confirm (never silent)`,
  },
] as const;

export function getConfigSection(id: string): ConfigSection | undefined {
  return CONFIG_SECTIONS.find((section) => section.id === id);
}

/**
 * True when the section header exists as a real (non-comment) TOML table,
 * including dotted subtables like `[explore.x]`. Commented examples
 * (`# [explore]`) never count.
 */
export function hasConfigSection(content: string, id: ConfigSectionId): boolean {
  const re = new RegExp(`^[ \\t]*\\[${escapeRegExp(id)}(\\]|\\.)`, "m");
  return re.test(content);
}

/** Append one section (idempotent: existing real header wins, never duplicated). */
export function applyConfigSection(content: string, id: ConfigSectionId): string {
  const section = getConfigSection(id);
  if (!section) throw new Error(`unknown config section: ${id}`);
  if (hasConfigSection(content, id)) return content;
  const trimmed = content.replace(/\s*$/, "");
  return `${trimmed}\n\n${section.toml}\n`;
}

export function applyConfigSections(content: string, ids: readonly ConfigSectionId[]): string {
  let next = content;
  for (const id of ids) {
    next = applyConfigSection(next, id);
  }
  return next;
}

/**
 * Remove a section's real table block(s) — `[id]` plus dotted `[id.*]` —
 * including comment lines attached directly above each header. Comments
 * attached to the *next* section's header are preserved. Idempotent: absent
 * section returns content unchanged. Caller must re-validate before writing.
 */
export function removeConfigSection(content: string, id: ConfigSectionId): string {
  if (!hasConfigSection(content, id)) return content;
  const lines = content.split("\n");
  const headerRe = new RegExp(`^[ \\t]*\\[${escapeRegExp(id)}(\\]|\\.)`);
  const anyHeaderRe = /^[ \t]*\[/;
  const commentRe = /^[ \t]*#/;
  const keep: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!headerRe.test(lines[i]!)) {
      keep.push(lines[i]!);
      i += 1;
      continue;
    }
    // Drop comment lines sitting directly above the removed header.
    while (keep.length > 0 && commentRe.test(keep[keep.length - 1]!)) keep.pop();
    // Skip the body up to the next header, but leave comments attached to it.
    let end = i + 1;
    while (end < lines.length && !anyHeaderRe.test(lines[end]!)) end += 1;
    if (end < lines.length) {
      while (end > i + 1 && commentRe.test(lines[end - 1]!)) end -= 1;
    }
    i = end;
  }
  return keep
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s*$/, "\n");
}

export function removeConfigSections(content: string, ids: readonly ConfigSectionId[]): string {
  let next = content;
  for (const id of ids) {
    next = removeConfigSection(next, id);
  }
  return next;
}

export type SectionStatus = Readonly<{ section: ConfigSection; present: boolean }>;

export function listSectionStatus(content: string): readonly SectionStatus[] {
  return CONFIG_SECTIONS.map((section) => ({
    section,
    present: hasConfigSection(content, section.id),
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
