import type { BlockerEntry, BlockerLog } from "./types.ts";
import type { RunSummary } from "../types.ts";

export type TrajectorySnapshot = Readonly<{
  tool_rounds?: readonly unknown[];
  messages?: readonly unknown[];
}>;

export type EventRow = Readonly<{
  event?: string;
  tool_name?: string;
  message?: string;
  payload?: Record<string, unknown>;
  call_id?: string;
}>;

/**
 * Deterministic blocker extraction from trajectory + events + summary.
 * Acts as the first-pass "subagent" evidence gatherer (no network).
 */
export function extractBlockerLog(input: Readonly<{
  runId: string;
  summary: RunSummary;
  trajectory?: TrajectorySnapshot;
  events?: readonly EventRow[];
  now?: () => string;
}>): BlockerLog {
  const now = input.now?.() ?? new Date().toISOString();
  const byKey = new Map<string, BlockerEntry>();
  let toolCallCount = 0;
  let toolErrorCount = 0;

  for (const reason of input.summary.failure_reasons ?? []) {
    const entry = fromFailureReason(reason);
    mergeBlocker(byKey, entry);
  }

  for (const event of input.events ?? []) {
    if (event.event === "tool.call") {
      toolCallCount += 1;
      continue;
    }
    if (event.event !== "tool.error" && event.event !== "tool.result") {
      continue;
    }
    const payload = event.payload ?? {};
    const result = asRecord(payload.result);
    const content = textFromUnknown(result.content ?? payload.content ?? event.message);
    const isError = event.event === "tool.error"
      || result.isError === true
      || looksError(content);
    if (!isError) {
      continue;
    }
    toolErrorCount += 1;
    const tool = event.tool_name
      ?? stringField(result, "name")
      ?? stringField(payload, "name")
      ?? "unknown";
    const args = asRecord(result.args ?? payload.args);
    const location = inferLocation(tool, { ...payload, ...result, args }, content);
    mergeBlocker(byKey, {
      id: `tool:${tool}:${hashShort(content)}`,
      kind: classifyKind(tool, content),
      summary: truncate(firstLine(content) || `${tool} failed`, 160),
      tool,
      location,
      cause: inferCause(content),
      evidence: truncate(content, 400),
      count: 1,
    });
  }

  // Trajectory tool_rounds may mirror tool results when events are sparse.
  for (const round of input.trajectory?.tool_rounds ?? []) {
    toolCallCount += 1;
    const record = asRecord(round);
    if (record.isError === true || looksError(textFromUnknown(record.content))) {
      toolErrorCount += 1;
      const content = textFromUnknown(record.content);
      const tool = stringField(record, "name") ?? stringField(record, "tool_name") ?? "unknown";
      mergeBlocker(byKey, {
        id: `round:${tool}:${hashShort(content)}`,
        kind: classifyKind(tool, content),
        summary: truncate(firstLine(content) || `${tool} error`, 160),
        tool,
        location: inferLocation(tool, record, content),
        cause: inferCause(content),
        evidence: truncate(content, 400),
        count: 1,
      });
    }
  }

  const blockers = [...byKey.values()].sort((a, b) => (b.count ?? 1) - (a.count ?? 1));
  return {
    schema_version: "xio-blocker-log.v1",
    run_id: input.runId,
    created_at: now,
    task_success: input.summary.success === true,
    failure_reasons: [...(input.summary.failure_reasons ?? [])],
    blockers,
    tool_error_count: toolErrorCount,
    tool_call_count: Math.max(toolCallCount, input.events?.filter((e) => e.tool_name).length ?? 0),
  };
}

function fromFailureReason(reason: string): BlockerEntry {
  if (reason.startsWith("stuck:")) {
    const tool = reason.slice("stuck:".length);
    return {
      id: `stuck:${tool}`,
      kind: "stuck_loop",
      summary: `Stuck tool loop on ${tool}`,
      tool,
      cause: "Same tool repeated beyond stuck threshold",
      count: 1,
    };
  }
  if (reason.startsWith("loop:")) {
    return {
      id: reason,
      kind: "stuck_loop",
      summary: `Repeated tool signature loop: ${reason.slice("loop:".length)}`,
      cause: "Same tool+args signature exceeded loop threshold",
      count: 1,
    };
  }
  if (reason.startsWith("tool_error:")) {
    const type = reason.slice("tool_error:".length);
    return {
      id: `semantic:${type}`,
      kind: "tool_error",
      summary: type.includes(":") ? `Tool error: ${type}` : `Semantic tool error pattern: ${type}`,
      tool: type.includes(":") ? undefined : type,
      cause: type,
      count: 1,
    };
  }
  if (reason.startsWith("exit_code:")) {
    return {
      id: reason,
      kind: "exit_code",
      summary: `Non-zero exit: ${reason}`,
      cause: "Command or verifier exited non-zero",
      count: 1,
    };
  }
  if (reason.includes("timeout")) {
    return {
      id: reason,
      kind: "timeout",
      summary: reason,
      cause: "Operation exceeded time budget",
      count: 1,
    };
  }
  return {
    id: `reason:${hashShort(reason)}`,
    kind: "unknown",
    summary: reason,
    count: 1,
  };
}

function classifyKind(tool: string, content: string): BlockerEntry["kind"] {
  if (/repeated tool blocked/i.test(content)) return "repeated_tool";
  if (/permission|blocked|denied/i.test(content)) return "permission";
  if (/timeout|timed out/i.test(content)) return "timeout";
  if (/exit_code=\s*[1-9]/i.test(content) || /exit code/i.test(content)) return "exit_code";
  if (tool === "bash") return "exit_code";
  return "tool_error";
}

function inferLocation(
  tool: string,
  payload: Record<string, unknown>,
  content: string,
): string | undefined {
  const args = asRecord(payload.args ?? payload.input ?? payload);
  if (typeof args.path === "string" && args.path.length > 0) return args.path;
  if (typeof args.command === "string" && args.command.length > 0) {
    return truncate(args.command, 120);
  }
  const pathMatch = /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|json|toml|md))\b/.exec(content);
  if (pathMatch?.[1]) return pathMatch[1];
  return tool !== "unknown" ? `tool:${tool}` : undefined;
}

function inferCause(content: string): string {
  if (/repeated tool blocked/i.test(content)) {
    return "Identical tool+args exceeded consecutive limit";
  }
  if (/not found|ENOENT|No such file/i.test(content)) return "Missing path or command";
  if (/permission|EACCES|denied/i.test(content)) return "Permission or policy denial";
  if (/must be unique|matched \d+ times/i.test(content)) return "Edit target ambiguous";
  if (/syntax|parse error|Unexpected/i.test(content)) return "Syntax or parse failure";
  if (/timeout/i.test(content)) return "Timeout";
  if (/exit_code=/i.test(content)) return "Shell command failed";
  return "Tool returned isError";
}

function mergeBlocker(map: Map<string, BlockerEntry>, entry: BlockerEntry): void {
  const existing = map.get(entry.id);
  if (!existing) {
    map.set(entry.id, entry);
    return;
  }
  map.set(entry.id, {
    ...existing,
    count: (existing.count ?? 1) + (entry.count ?? 1),
    evidence: existing.evidence ?? entry.evidence,
  });
}

function looksError(text: string): boolean {
  return /error|failed|blocked|ENOENT|exit_code=[1-9]/i.test(text);
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        const rec = asRecord(item);
        return typeof rec.text === "string" ? rec.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value == null ? "" : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function hashShort(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}
