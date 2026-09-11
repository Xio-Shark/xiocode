import type { TodoItem } from "./types.ts";

const ADDENDUM = [
  "## XioCode TODO Protocol",
  "- For multi-step coding tasks, keep markdown checkboxes, mark exactly one item in progress, and update items as they finish.",
  "- Do not claim completion until verification has run or the blocker is explicit.",
  "",
  "## Host Environment",
  "- Classify the host once before shell work: POSIX (macOS/Linux, bash/zsh/sh) or Windows (PowerShell/cmd). Probe once with `uname -s` if unsure, then keep later `bash` commands consistent with it.",
  "",
  "## XioCode Tool Strategy",
  "- Run parallel independent searches and reads in a single round rather than one at a time.",
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
