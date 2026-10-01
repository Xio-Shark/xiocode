import { describe, expect, it } from "vitest";
import { formatDiffDetail } from "./diff-render.ts";
import { contrastRatio, resolveTheme } from "./theme.ts";

describe("diff-render", () => {
  it("parses standard git diff with stats, headers, and line numbers", () => {
    const gitDiff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "index 1234567..89abcdef 100644",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -10,4 +10,5 @@",
      " import { foo } from './foo';",
      "-const oldVal = 1;",
      "+const newVal = 2;",
      "+const addedVal = 3;",
      " export default foo;",
    ].join("\n");

    const lines = formatDiffDetail(gitDiff);
    expect(lines.length).toBeGreaterThan(0);

    // File header with stats
    const fileHeader = lines.find((l) => l.type === "file-header");
    expect(fileHeader).toBeDefined();
    expect(fileHeader?.text).toContain("(+2, -1)");

    // Hunk header
    const hunkHeader = lines.find((l) => l.type === "hunk-header");
    expect(hunkHeader).toBeDefined();
    expect(hunkHeader?.text).toContain("@@ -10,4 +10,5 @@");

    // Add and Del lines with calculated line numbers
    const delLine = lines.find((l) => l.type === "del");
    expect(delLine).toBeDefined();
    expect(delLine?.oldLine).toBe(11);
    expect(delLine?.text).toContain("-const oldVal = 1;");

    const addLines = lines.filter((l) => l.type === "add");
    expect(addLines).toHaveLength(2);
    expect(addLines[0]?.newLine).toBe(11);
    expect(addLines[1]?.newLine).toBe(12);
  });

  it("handles bare diffs without standard git headers gracefully", () => {
    const bareDiff = [
      "@@ -1,2 +1,2 @@",
      "-hello",
      "+world",
    ].join("\n");

    const lines = formatDiffDetail(bareDiff);
    expect(lines.some((l) => l.type === "hunk-header")).toBe(true);
    const del = lines.find((l) => l.type === "del");
    expect(del?.oldLine).toBe(1);
    const add = lines.find((l) => l.type === "add");
    expect(add?.newLine).toBe(1);
  });

  it("truncates giant diffs exceeding 4000 lines", () => {
    const giantDiff = Array.from({ length: 4500 }, (_, i) => `+line-${i}`).join("\n");
    const lines = formatDiffDetail(giantDiff);
    expect(lines.length).toBeLessThanOrEqual(4000);
    expect(lines[lines.length - 1]?.text).toContain("diff truncated at 4000 lines");
  });

  it("ensures theme diff colors have WCAG AA contrast in light theme", () => {
    const light = resolveTheme("light");
    const white = "#ffffff";
    const addContrast = contrastRatio(light.diffAdd, white);
    const delContrast = contrastRatio(light.diffDel, white);
    expect(addContrast).toBeGreaterThanOrEqual(4.5);
    expect(delContrast).toBeGreaterThanOrEqual(4.5);
  });
});
