import { describe, expect, it } from "vitest";

import { ResultDenoiser } from "../src/result-denoiser.ts";

describe("ResultDenoiser", () => {
  it("truncates long read results by line count", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: 2 });
    const result = await denoiser.process("read", { content: "a\nb\nc" });

    expect(expectTextContent(result)).toBe("a\nb\n... (1 more lines, total 3)");
    expect(result.metadata?.denoised).toBe(true);
  });

  it("normalizes CRLF while truncating read results", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: 2 });
    const result = await denoiser.process("read", { content: "a\r\nb\r\nc" });

    expect(expectTextContent(result)).toBe("a\nb\n... (1 more lines, total 3)");
  });

  it("counts trailing newlines like split-based truncation", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: 1 });
    const result = await denoiser.process("read", { content: "a\n" });

    expect(expectTextContent(result)).toBe("a\n... (1 more lines, total 2)");
  });

  it("returns the original read content when no truncation is needed", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: 3 });
    const content = "a\r\nb\n";
    const result = await denoiser.process("read", { content });

    expect(expectTextContent(result)).toBe(content);
  });

  it("preserves negative read line truncation semantics", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: -1 });
    const result = await denoiser.process("read", { content: "a\nb\nc" });

    expect(expectTextContent(result)).toBe("a\nb\n... (4 more lines, total 3)");
  });

  it("keeps pi text block content renderable after read denoising", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: 2 });
    const result = await denoiser.process("read", { content: [{ type: "text", text: "a\nb\nc" }] });

    expect(result.content).toEqual([{ type: "text", text: "a\nb\n... (1 more lines, total 3)" }]);
  });

  it("preserves non-text content blocks while denoising text", async () => {
    const denoiser = new ResultDenoiser({ maxReadLines: 2 });
    const imageBlock = { type: "image", data: "abc", mimeType: "image/png" };
    const result = await denoiser.process("read", { content: [{ type: "text", text: "a\nb\nc" }, imageBlock] });

    expect(result.content).toEqual([{ type: "text", text: "a\nb\n... (1 more lines, total 3)" }, imageBlock]);
  });

  it("truncates grep results with a match summary", async () => {
    const denoiser = new ResultDenoiser({ maxGrepResults: 2 });
    const result = await denoiser.process("grep", { content: ["a", "b", "c"] });

    expect(expectTextContent(result)).toBe("a\nb\n... (1 more matches)");
  });

  it("keeps stringified non-empty grep array items", async () => {
    const denoiser = new ResultDenoiser({ maxGrepResults: 3 });
    const result = await denoiser.process("grep", { content: ["a", "", 0, false, null] });

    expect(expectTextContent(result)).toBe("a\n0\nfalse\n... (1 more matches)");
  });

  it("filters empty grep text lines while preserving split semantics", async () => {
    const denoiser = new ResultDenoiser({ maxGrepResults: 3 });
    const result = await denoiser.process("grep", { content: "a\r\n\r\nb\nc\r" });

    expect(expectTextContent(result)).toBe("a\nb\nc\r");
  });

  it("separates glob paths into directory and basename columns", async () => {
    const denoiser = new ResultDenoiser({ maxGlobResults: 1 });
    const result = await denoiser.process("glob", { content: ["src/index.ts", "src/cli.ts"] });

    expect(expectTextContent(result)).toBe("src\tindex.ts\n... (1 more paths)");
  });

  it("groups path results from text while filtering blank lines", async () => {
    const denoiser = new ResultDenoiser({ maxGlobResults: 2 });
    const result = await denoiser.process("glob", { content: "src/a.ts\r\n\r\nindex.ts\nsrc/b.ts\n" });

    expect(expectTextContent(result)).toBe("src\ta.ts\n.\tindex.ts\n... (1 more paths)");
  });

  it("keeps path dirname and basename edge cases", async () => {
    const denoiser = new ResultDenoiser({ maxGlobResults: 3 });
    const result = await denoiser.process("glob", { content: ["index.ts", "src/", "/"] });

    expect(expectTextContent(result)).toBe(".\tindex.ts\n.\tsrc\n/\t");
  });

  it("denoises enabled discovery tools that return path lists", async () => {
    const denoiser = new ResultDenoiser({ maxGlobResults: 1 });

    const findResult = await denoiser.process("find", { content: ["src/a.ts", "src/b.ts"] });
    expect(expectTextContent(findResult)).toBe("src\ta.ts\n... (1 more paths)");

    const lsResult = await denoiser.process("ls", { content: "src/a.ts\nsrc/b.ts" });
    expect(expectTextContent(lsResult)).toBe("src\ta.ts\n... (1 more paths)");
  });

  it("truncates sandbox bash output like regular bash output", async () => {
    const denoiser = new ResultDenoiser({ maxBashChars: 4 });
    const result = await denoiser.process("bash", { content: [{ type: "text", text: "abcdef" }] });

    expect(result.content).toEqual([{ type: "text", text: "abcd\n... (2 more chars)" }]);
    expect(result.metadata?.denoised).toBe(true);
  });

  it("keeps regular bash text blocks renderable after truncation", async () => {
    const denoiser = new ResultDenoiser({ maxBashChars: 4 });
    const result = await denoiser.process("bash", { content: [{ type: "text", text: "abcdef" }] });

    expect(result.content).toEqual([{ type: "text", text: "abcd\n... (2 more chars)" }]);
  });

  it("truncates search context text content", async () => {
    const denoiser = new ResultDenoiser({ maxSearchContextChars: 5 });
    const result = await denoiser.process("search_context", { content: "abcdef" });

    expect(expectTextContent(result)).toBe("abcde\n... (1 more chars)");
    expect(result.metadata?.denoised).toBe(true);
  });

  it("truncates single search context text blocks", async () => {
    const denoiser = new ResultDenoiser({ maxSearchContextChars: 5 });
    const result = await denoiser.process("search_context", { content: [{ type: "text", text: "abcdef" }] });

    expect(result.content).toEqual([{ type: "text", text: "abcde\n... (1 more chars)" }]);
  });

  it("wraps unknown search context structures as text blocks", async () => {
    const denoiser = new ResultDenoiser({ maxSearchContextChars: 100 });
    const content = { matches: ["abcdef"] };
    const result = await denoiser.process("search_context", { content });

    expect(expectTextContent(result)).toBe(JSON.stringify(content, null, 2));
  });

  it("preserves error flags and metadata while marking denoised output", async () => {
    const denoiser = new ResultDenoiser({ maxBashChars: 4 });
    const result = await denoiser.process("bash", {
      content: "abcdef",
      isError: true,
      metadata: { exitCode: 2, source: "bash" },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "abcd\n... (2 more chars)" }],
      isError: true,
      metadata: { exitCode: 2, source: "bash", denoised: true },
    });
  });

  it("normalizes unhandled tool string content without marking it denoised", async () => {
    const denoiser = new ResultDenoiser();
    const result = await denoiser.process("custom_tool", { content: "ok" });

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.metadata?.denoised).toBeUndefined();
  });

  describe("stack trace truncation", () => {
    it("truncates long Node.js stack traces", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 2 });
      const stackTrace = [
        "Error: ENOENT: no such file or directory",
        "  at Object.openSync (node:fs:601:3)",
        "  at Object.readFileSync (node:fs:469:35)",
        "  at loadConfig (/app/config.ts:10:5)",
        "  at main (/app/index.ts:5:3)",
        "  at processTicksAndRejections (node:internal:100:1)",
      ].join("\n");

      const result = await denoiser.process("bash", { content: stackTrace });

      expect(expectTextContent(result)).toBe([
        "Error: ENOENT: no such file or directory",
        "  at Object.openSync (node:fs:601:3)",
        "  at Object.readFileSync (node:fs:469:35)",
        "    ... (truncated 2 frames) ...",
        "  at processTicksAndRejections (node:internal:100:1)",
      ].join("\n"));
    });

    it("truncates long Python stack traces", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 2 });
      const stackTrace = [
        'Traceback (most recent call last):',
        '  File "app.py", line 10, in main',
        '  File "config.py", line 5, in load_config',
        '  File "reader.py", line 20, in read_file',
        '  File "fs.py", line 8, in open_file',
        "FileNotFoundError: [Errno 2] No such file",
      ].join("\n");

      const result = await denoiser.process("bash", { content: stackTrace });

      expect(expectTextContent(result)).toBe([
        'Traceback (most recent call last):',
        '  File "app.py", line 10, in main',
        '  File "config.py", line 5, in load_config',
        "    ... (truncated 1 frames) ...",
        '  File "fs.py", line 8, in open_file',
      ].join("\n"));
    });

    it("truncates long Rust stack traces", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 2 });
      const stackTrace = [
        "thread 'main' panicked at 'called `Result::unwrap()` on an `Err` value'",
        "  at app::config::load",
        "  at app::main::run",
        "  at app::main",
        "  at std::rt::lang_start",
      ].join("\n");

      const result = await denoiser.process("bash", { content: stackTrace });

      expect(expectTextContent(result)).toBe([
        "thread 'main' panicked at 'called `Result::unwrap()` on an `Err` value'",
        "  at app::config::load",
        "  at app::main::run",
        "    ... (truncated 1 frames) ...",
        "  at std::rt::lang_start",
      ].join("\n"));
    });

    it("truncates long Java stack traces", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 2 });
      const stackTrace = [
        "java.io.FileNotFoundException: config.json (No such file)",
        "  at java.io.FileInputStream.open0(Native Method)",
        "  at java.io.FileInputStream.open(FileInputStream.java:195)",
        "  at com.app.Config.load(Config.java:10)",
        "  at com.app.Main.main(Main.java:5)",
      ].join("\n");

      const result = await denoiser.process("bash", { content: stackTrace });

      expect(expectTextContent(result)).toBe([
        "java.io.FileNotFoundException: config.json (No such file)",
        "  at java.io.FileInputStream.open0(Native Method)",
        "  at java.io.FileInputStream.open(FileInputStream.java:195)",
        "    ... (truncated 1 frames) ...",
        "  at com.app.Main.main(Main.java:5)",
      ].join("\n"));
    });

    it("preserves short stack traces without truncation", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 5 });
      const stackTrace = [
        "Error: test error",
        "  at func1 (file.ts:1:1)",
        "  at func2 (file.ts:2:2)",
      ].join("\n");

      const result = await denoiser.process("bash", { content: stackTrace });

      expect(expectTextContent(result)).toBe(stackTrace);
    });

    it("handles non-stack-trace bash output unchanged", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 2 });
      const output = "Files changed: 5\nLines added: 120";

      const result = await denoiser.process("bash", { content: output });

      expect(expectTextContent(result)).toBe(output);
    });

    it("truncates stack traces in sandbox bash output", async () => {
      const denoiser = new ResultDenoiser({ maxStackFrames: 2 });
      const stackTrace = [
        "Error: ENOENT",
        "  at Object.openSync (node:fs:601:3)",
        "  at Object.readFileSync (node:fs:469:35)",
        "  at loadConfig (/app/config.ts:10:5)",
        "  at main (/app/index.ts:5:3)",
      ].join("\n");

      const result = await denoiser.process("bash", {
        content: [{ type: "text", text: stackTrace }],
      });

      expect(result.content).toEqual([{
        type: "text",
        text: [
          "Error: ENOENT",
          "  at Object.openSync (node:fs:601:3)",
          "  at Object.readFileSync (node:fs:469:35)",
          "    ... (truncated 1 frames) ...",
          "  at main (/app/index.ts:5:3)",
        ].join("\n"),
      }]);
    });
  });

  describe("outline generation for large files", () => {
    it("generates outline for TypeScript files over threshold", async () => {
      const denoiser = new ResultDenoiser({ outlineThreshold: 10, enableOutlineGeneration: true });
      const content = Array.from({ length: 15 }, (_, i) => `export function func${i}() { return ${i}; }`).join("\n");

      const result = await denoiser.process("read", {
        content,
        metadata: { file_path: "test.ts" },
      });

      const text = expectTextContent(result);
      expect(text).toContain("File outline (typescript,");
      expect(text).toContain("## functions");
      expect(text).toContain("func0");
      expect(result.metadata?.denoised).toBe(true);
    });

    it("falls back to line truncation for unsupported file types", async () => {
      const denoiser = new ResultDenoiser({ outlineThreshold: 10, maxReadLines: 5, enableOutlineGeneration: true });
      const content = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");

      const result = await denoiser.process("read", {
        content,
        metadata: { file_path: "test.txt" },
      });

      const text = expectTextContent(result);
      expect(text).toContain("... (10 more lines, total 15)");
      expect(text).not.toContain("File outline");
    });

    it("uses line truncation for files below threshold", async () => {
      const denoiser = new ResultDenoiser({ outlineThreshold: 20, maxReadLines: 5, enableOutlineGeneration: true });
      const content = Array.from({ length: 10 }, (_, i) => `export function func${i}() { return ${i}; }`).join("\n");

      const result = await denoiser.process("read", {
        content,
        metadata: { file_path: "test.ts" },
      });

      const text = expectTextContent(result);
      expect(text).toContain("... (5 more lines, total 10)");
      expect(text).not.toContain("File outline");
    });

    it("respects enableOutlineGeneration=false", async () => {
      const denoiser = new ResultDenoiser({ outlineThreshold: 10, maxReadLines: 5, enableOutlineGeneration: false });
      const content = Array.from({ length: 15 }, (_, i) => `export function func${i}() { return ${i}; }`).join("\n");

      const result = await denoiser.process("read", {
        content,
        metadata: { file_path: "test.ts" },
      });

      const text = expectTextContent(result);
      expect(text).toContain("... (10 more lines, total 15)");
      expect(text).not.toContain("File outline");
    });

    it("extracts file path from args when metadata is missing", async () => {
      const denoiser = new ResultDenoiser({ outlineThreshold: 10, enableOutlineGeneration: true });
      const content = Array.from({ length: 15 }, (_, i) => `export function func${i}() { return ${i}; }`).join("\n");

      const result = await denoiser.process(
        "read",
        { content, metadata: {} },
        { file_path: "test.ts" }
      );

      const text = expectTextContent(result);
      expect(text).toContain("File outline (typescript,");
      expect(text).toContain("## functions");
    });
  });
});

function expectTextContent(result: { readonly content: unknown }): string {
  expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.any(String) })]);
  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error("expected content block array");
  }
  const firstBlock = content[0];
  if (!firstBlock || typeof firstBlock !== "object" || Array.isArray(firstBlock)) {
    throw new Error("expected first text content block");
  }
  const text = (firstBlock as { readonly text?: unknown }).text;
  if (typeof text !== "string") {
    throw new Error("expected first content block text");
  }
  return text;
}
