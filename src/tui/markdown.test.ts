import { describe, expect, it } from "vitest";

import {
  alignTableBlock,
  highlightCodeLine,
  isRenderedTableRow,
  md,
  renderInline,
  renderMarkdownLines,
} from "./markdown.ts";

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (line: string): string => line.replace(ANSI, "");

describe("renderMarkdownLines", () => {
  it("passes plain text through byte-identical", () => {
    const text = "no markdown here\njust two plain lines with W123 and x tokens";
    expect(renderMarkdownLines(text)).toEqual(text.split("\n"));
  });

  it("returns [] for empty input and strips CRLF", () => {
    expect(renderMarkdownLines("")).toEqual([]);
    expect(renderMarkdownLines("plain\r\nnext\r")).toEqual(["plain", "next"]);
  });

  it("styles headings bold+accent with marker removed", () => {
    const [line] = renderMarkdownLines("## Section title");
    expect(line).toContain("\u001B[1m");
    expect(strip(line!)).toBe("Section title");
  });

  it("renders bullets, ordered items, quotes, and rules", () => {
    const lines = renderMarkdownLines("- item one\n2. second\n> quoted\n---");
    expect(strip(lines[0]!)).toBe("• item one");
    expect(strip(lines[1]!)).toBe("2. second");
    expect(strip(lines[2]!)).toBe("│ quoted");
    expect(strip(lines[3]!)).toBe("─".repeat(24));
  });

  it("applies inline styles: bold, italic, code span, link", () => {
    const line = renderInline("**b** *i* `code` [label](https://x.dev)");
    expect(line).toContain(md.bold("b"));
    expect(line).toContain(md.italic("i"));
    expect(line).toContain(md.accent("code"));
    expect(strip(line)).toBe("b i code label (https://x.dev)");
  });

  it("never styles markers inside code spans", () => {
    const line = renderInline("`**not bold**`");
    expect(line).toBe(md.accent("**not bold**"));
  });

  it("keeps fence lines visible and highlights the body", () => {
    const lines = renderMarkdownLines("```ts\nconst n = 42; // answer\n```");
    expect(strip(lines[0]!)).toBe("```ts");
    expect(lines[1]).toContain(md.keyword("const"));
    expect(lines[1]).toContain(md.number("42"));
    expect(lines[1]).toContain(md.muted("// answer"));
    expect(strip(lines[2]!)).toBe("```");
    expect(strip(lines[1]!)).toBe("const n = 42; // answer");
  });

  it("does not apply block styles inside fences", () => {
    const lines = renderMarkdownLines("```\n# not a heading\n- not a bullet\n```");
    expect(strip(lines[1]!)).toBe("# not a heading");
    expect(strip(lines[2]!)).toBe("- not a bullet");
  });

  it("keeps heading depth visible instead of flattening h1..h6", () => {
    const [h1] = renderMarkdownLines("# Top");
    const [h4] = renderMarkdownLines("#### Deep");
    expect(h1).toContain(md.accent("Top"));
    expect(h4).not.toContain("[36m");
    expect(h4).toContain("[1m");
    expect(strip(h4!)).toBe("Deep");
  });
});

describe("pipe tables", () => {
  it("pads ragged columns while staying valid markdown", () => {
    const lines = renderMarkdownLines([
      "| Command | What it does |",
      "|---|---|",
      "| /connect | Set up an API key |",
      "| /model | Switch model |",
    ].join("\n")).map(strip);

    expect(lines).toEqual([
      "| Command  | What it does      |",
      "| -------- | ----------------- |",
      "| /connect | Set up an API key |",
      "| /model   | Switch model      |",
    ]);
    // Every rendered row is the same width — that is the whole point.
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it("honours :--- / :---: / ---: alignment per column", () => {
    const lines = renderMarkdownLines([
      "| left | mid | right |",
      "| :--- | :---: | ---: |",
      "| a | b | c |",
    ].join("\n")).map(strip);

    // Widths come from the content: left=4, mid=3, right=5.
    expect(lines[1]).toBe("| ---- | :-: | ----: |");
    expect(lines[2]).toBe("| a    |  b  |     c |");
  });

  it("measures the visible width, not the markup width", () => {
    // `**bold**` occupies four columns once rendered, and 命令 occupies four.
    const lines = renderMarkdownLines([
      "| key | value |",
      "| --- | --- |",
      "| **bold** | x |",
      "| 命令 | y |",
    ].join("\n")).map(strip);

    expect(lines[2]).toBe("| bold | x     |");
    expect(lines[3]).toBe("| 命令 | y     |");
  });

  it("leaves pipe-looking prose alone without a delimiter row", () => {
    const source = "| just | pipes |\n| more | pipes |";
    expect(renderMarkdownLines(source)).toEqual(source.split("\n"));
  });

  it("skips tables inside fences and tables too wide to pad", () => {
    const fenced = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(renderMarkdownLines(fenced).map(strip).slice(1, 4))
      .toEqual(["| a | b |", "|---|---|", "| 1 | 2 |"]);

    const wide = ["| a | b |", "|---|---|", `| ${"x".repeat(200)} | y |`];
    expect(alignTableBlock(wide)).toBeUndefined();
  });

  it("flags padded rows so callers do not prefix one of them", () => {
    const lines = renderMarkdownLines("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(lines.every((line) => isRenderedTableRow(line))).toBe(true);
    expect(isRenderedTableRow("plain answer text")).toBe(false);
    // Unpadded prose that merely starts with a pipe must not be mistaken for one.
    expect(isRenderedTableRow("|not a table")).toBe(false);
  });

  it("refuses malformed tables rather than guessing", () => {
    expect(alignTableBlock(["| a | b |"])).toBeUndefined();
    // Delimiter cell count must match the header.
    expect(alignTableBlock(["| a | b |", "|---|"])).toBeUndefined();
    expect(alignTableBlock(["| a |", "|---|"])).toBeUndefined();
  });
});

describe("highlightCodeLine", () => {
  it("uses # comments only for hash-comment languages", () => {
    expect(highlightCodeLine("x = 1 # note", "python")).toContain(md.muted("# note"));
    expect(highlightCodeLine("obj.#priv // note", "ts")).toContain(md.muted("// note"));
    expect(highlightCodeLine("obj.#priv", "ts")).toBe("obj.#priv");
  });

  it("highlights strings without styling their contents twice", () => {
    const line = highlightCodeLine('return "const 42"', "ts");
    expect(line).toContain(md.keyword("return"));
    expect(line).toContain(md.string('"const 42"'));
  });
});
