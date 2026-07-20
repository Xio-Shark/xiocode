/**
 * Append agent-actionable Fix lines to tool/verify failures.
 * Cause is already in the message; Fix says what to try next (mechanical enforcement style).
 */

export function withFixHint(tool: string, message: string): string {
  const body = message.trimEnd();
  if (/\nFix:/i.test(body)) {
    return body;
  }
  const hint = fixHintFor(tool, body);
  if (!hint) {
    return body;
  }
  return `${body}\n\nFix: ${hint}`;
}

export function fixHintFor(tool: string, message: string): string | undefined {
  const m = message.toLowerCase();
  const name = tool.toLowerCase();

  if (name === "edit" || m.includes("edit failed")) {
    if (m.includes("not read") || m.includes("before edit")) {
      return "Call read on this path first (or create it with write), then re-run edit with an exact unique old_string.";
    }
    if (m.includes("matched") && m.includes("must be unique")) {
      return (
        "Include more surrounding lines so old_string matches once, "
        + "or set replace_all=true only when every occurrence should change. Re-read the file first."
      );
    }
    if (m.includes("not found")) {
      return (
        "read the file, copy an exact unique snippet into old_string "
        + "(watch CRLF/indent), or use a smaller anchor. Do not invent content."
      );
    }
    if (m.includes("patch")) {
      return "Re-read the file, regenerate a unified diff against current content, or fall back to old_string/new_string.";
    }
    if (m.includes("old_string and new_string")) {
      return "Provide old_string + new_string, or pass patch with a unified diff.";
    }
    return "read the target file, use a unique exact old_string, then re-run edit.";
  }

  if (name === "write" || m.includes("write-back")) {
    if (m.includes("not read") || m.includes("before overwrite")) {
      return "Call read on the existing path first, then re-run write — or write to a new path that does not exist yet.";
    }
    if (m.includes("mismatch")) {
      return "Re-read the path; do not claim the write succeeded. Retry write/edit only after verifying disk content.";
    }
    if (m.includes("failed to read")) {
      return "Confirm the path exists and is readable under the workspace; re-run write after mkdir parent dirs.";
    }
  }

  if (m.includes("escapes workspace") || m.includes("path escapes")) {
    return "Use a path under the session workspace root only. Never write outside the worktree.";
  }

  if (name === "bash" || m.startsWith("exit_code=")) {
    return (
      "Read stderr/stdout above, fix the root cause (deps, paths, tests), then re-run the same command. "
      + "Do not ignore a non-zero exit."
    );
  }

  if (name === "grep" || name === "glob") {
    return "Simplify the pattern/path, check the search root exists, or fall back to a broader glob then read.";
  }

  if (name === "read" && (m.includes("enoent") || m.includes("no such file"))) {
    return "glob/grep for the real path, then read again. Do not invent file contents.";
  }

  if (name === "done" || m.includes("done contract")) {
    return (
      "Fix every failing command until exit 0, then continue. "
      + "Do not claim the task is complete while the contract is FAIL."
    );
  }

  return "Inspect the error, change the minimal cause, re-run the same check. Do not hide the failure.";
}
