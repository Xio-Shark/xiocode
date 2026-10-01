import { parsePatch } from "diff";
import { theme } from "./theme.ts";

export type DiffLineType =
  | "file-header"
  | "hunk-header"
  | "add"
  | "del"
  | "context"
  | "plain";

export type FormattedDiffLine = Readonly<{
  type: DiffLineType;
  /** Complete formatted text to display (including line numbers for hunk lines). */
  text: string;
  rawText: string;
  oldLine?: number;
  newLine?: number;
  stat?: Readonly<{ additions: number; deletions: number }>;
}>;

const MAX_DIFF_LINES = 4_000;

function formatLineNumbers(oldLine?: number, newLine?: number): string {
  const oldStr = oldLine !== undefined ? String(oldLine).padStart(4, " ") : "    ";
  const newStr = newLine !== undefined ? String(newLine).padStart(4, " ") : "    ";
  return `${oldStr} ${newStr} `;
}

/** `old → new` for a rename; the one real name for an add or delete. */
function patchFileLabel(oldName: string | undefined, newName: string | undefined): string {
  const clean = (name: string | undefined) =>
    name && name !== "/dev/null" ? name.replace(/^[ab]\//, "") : undefined;
  const from = clean(oldName);
  const to = clean(newName);
  if (from && to && from !== to) return `${from} → ${to}`;
  return to ?? from ?? "diff";
}

/**
 * Parses raw diff or plain-text detail into formatted lines with file headers,
 * hunk headers, +/- line stats, line numbers, and max length protection.
 */
export function formatDiffDetail(detail: string): readonly FormattedDiffLine[] {
  if (!detail || detail.trim().length === 0) return [];

  // Try standard patch parsing first
  try {
    const patches = parsePatch(detail);
    if (patches && patches.length > 0 && patches.some((p) => p.hunks && p.hunks.length > 0)) {
      const result: FormattedDiffLine[] = [];
      for (const patch of patches) {
        let additions = 0;
        let deletions = 0;
        for (const hunk of patch.hunks) {
          for (const line of hunk.lines) {
            if (line.startsWith("+")) additions += 1;
            else if (line.startsWith("-")) deletions += 1;
          }
        }

        const fileName = patchFileLabel(patch.oldFileName, patch.newFileName);
        const statStr = `(+${additions}, -${deletions})`;
        const fileHeaderText = `diff ${fileName} ${statStr}`;

        result.push({
          type: "file-header",
          text: fileHeaderText,
          rawText: fileHeaderText,
          stat: { additions, deletions },
        });

        for (const hunk of patch.hunks) {
          const hunkText = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
          result.push({
            type: "hunk-header",
            text: hunkText,
            rawText: hunkText,
          });

          let oldNum = hunk.oldStart;
          let newNum = hunk.newStart;

          for (const line of hunk.lines) {
            if (result.length >= MAX_DIFF_LINES - 1) {
              result.push({
                type: "plain",
                text: "(diff truncated at 4000 lines)",
                rawText: "(diff truncated at 4000 lines)",
              });
              return result;
            }

            if (line.startsWith("\\")) {
              // "\ No newline at end of file" annotates the previous line; it is not a line itself.
              result.push({ type: "plain", text: `${formatLineNumbers()}${line}`, rawText: line });
            } else if (line.startsWith("+")) {
              const numPrefix = formatLineNumbers(undefined, newNum);
              result.push({
                type: "add",
                text: `${numPrefix}${line}`,
                rawText: line,
                newLine: newNum,
              });
              newNum += 1;
            } else if (line.startsWith("-")) {
              const numPrefix = formatLineNumbers(oldNum, undefined);
              result.push({
                type: "del",
                text: `${numPrefix}${line}`,
                rawText: line,
                oldLine: oldNum,
              });
              oldNum += 1;
            } else {
              const content = line.startsWith(" ") ? line : ` ${line}`;
              const numPrefix = formatLineNumbers(oldNum, newNum);
              result.push({
                type: "context",
                text: `${numPrefix}${content}`,
                rawText: line,
                oldLine: oldNum,
                newLine: newNum,
              });
              oldNum += 1;
              newNum += 1;
            }
          }
        }
      }

      if (result.length > 0) return result;
    }
  } catch {
    // Fall back to line-by-line parsing
  }

  // Fallback line-by-line parser for non-standard / bare diffs or general detail
  const rawLines = detail.split("\n");
  const result: FormattedDiffLine[] = [];

  let currentOld = 1;
  let currentNew = 1;
  let inHunk = false;

  // Pre-calculate statistics if there are git style diff lines
  let fallbackAdditions = 0;
  let fallbackDeletions = 0;
  for (const line of rawLines) {
    if (line.startsWith("+") && !line.startsWith("+++")) fallbackAdditions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) fallbackDeletions += 1;
  }

  for (let i = 0; i < rawLines.length; i++) {
    if (result.length >= MAX_DIFF_LINES - 1) {
      result.push({
        type: "plain",
        text: "(diff truncated at 4000 lines)",
        rawText: "(diff truncated at 4000 lines)",
      });
      break;
    }

    const line = rawLines[i]!;

    if (line.startsWith("diff --git") || line.startsWith("Index: ")) {
      inHunk = false;
      const statSuffix = fallbackAdditions > 0 || fallbackDeletions > 0
        ? ` (+${fallbackAdditions}, -${fallbackDeletions})`
        : "";
      result.push({
        type: "file-header",
        text: `${line}${statSuffix}`,
        rawText: line,
        stat: { additions: fallbackAdditions, deletions: fallbackDeletions },
      });
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      result.push({
        type: "file-header",
        text: line,
        rawText: line,
      });
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkMatch) {
      inHunk = true;
      currentOld = parseInt(hunkMatch[1]!, 10);
      currentNew = parseInt(hunkMatch[2]!, 10);
      result.push({
        type: "hunk-header",
        text: line,
        rawText: line,
      });
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const numPrefix = formatLineNumbers(undefined, currentNew);
        result.push({
          type: "add",
          text: `${numPrefix}${line}`,
          rawText: line,
          newLine: currentNew,
        });
        currentNew += 1;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        const numPrefix = formatLineNumbers(currentOld, undefined);
        result.push({
          type: "del",
          text: `${numPrefix}${line}`,
          rawText: line,
          oldLine: currentOld,
        });
        currentOld += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        const numPrefix = formatLineNumbers(currentOld, currentNew);
        result.push({
          type: "context",
          text: `${numPrefix}${line}`,
          rawText: line,
          oldLine: currentOld,
          newLine: currentNew,
        });
        currentOld += 1;
        currentNew += 1;
        continue;
      }
    }

    // Bare +/- outside explicit hunk header
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({
        type: "add",
        text: line,
        rawText: line,
      });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      result.push({
        type: "del",
        text: line,
        rawText: line,
      });
    } else {
      result.push({
        type: "plain",
        text: line,
        rawText: line,
      });
    }
  }

  return result;
}
