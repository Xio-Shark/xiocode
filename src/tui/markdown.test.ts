import { describe, expect, it } from "vitest";

import { highlightCodeLine, md, renderInline, renderMarkdownLines } from "./markdown.ts";

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
