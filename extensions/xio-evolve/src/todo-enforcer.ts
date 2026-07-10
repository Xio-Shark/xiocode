import type { TodoItem } from "./types.ts";

const ADDENDUM = [
  "## XioCode TODO Protocol",
  "- For multi-step coding tasks, keep markdown checkboxes, mark exactly one item in progress, and update items as they finish.",
  "- Do not claim completion until verification has run or the blocker is explicit.",
  "",
  "## XioCode Tool Strategy",
  "- For repo/code/config/debug/audit tasks, gather file-backed evidence before answering, editing, or claiming root cause.",
  "- Fan out with glob/grep/find, then read the specific files that prove the answer.",
  "- For code changes, read the target files and nearby tests first, then edit surgically and run the smallest reliable verification.",
  "- Ground final repo claims in files, command output, tests, or explicit blockers; run parallel independent searches and reads when useful.",
  "- For simple direct questions that need no workspace evidence, answer directly.",
].join("\n");

export class TodoEnforcer {
  getSystemAddendum(): string {
    return ADDENDUM;
  }

  parseTodos(markdown: string): readonly TodoItem[] {
    return parseTodos(markdown);
  }
}

export function parseTodos(markdown: string): readonly TodoItem[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => parseTodoLine(line))
    .filter((item): item is TodoItem => item !== null);
}

function parseTodoLine(line: string): TodoItem | null {
  const match = /^\s*[-*]\s+\[( |x|X|-)\]\s+(.+?)\s*$/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[1];
  const text = match[2];
  if (!marker || !text) {
    return null;
  }
  return {
    text,
    status: marker === "x" || marker === "X" ? "done" : marker === "-" ? "in_progress" : "pending",
  };
}
