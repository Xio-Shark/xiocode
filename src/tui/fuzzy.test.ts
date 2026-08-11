import { describe, expect, it } from "vitest";

import { fuzzyFilter } from "./fuzzy.ts";

const COMMANDS = [
  { label: "/help", description: "Show help" },
  { label: "/model", description: "Switch model" },
  { label: "/memory-debug", description: "Debug memory" },
  { label: "/exit", description: "End session" },
  { label: "/bypass", description: "Auto-approve" },
] as const;

describe("fuzzyFilter", () => {
  it("returns everything for an empty or whitespace query", () => {
    expect(fuzzyFilter(COMMANDS, "", (c) => c.label)).toHaveLength(COMMANDS.length);
    expect(fuzzyFilter(COMMANDS, "   ", (c) => c.label)).toHaveLength(COMMANDS.length);
  });

  it("ranks fuzzy matches, not just substrings", () => {
    const result = fuzzyFilter(COMMANDS, "mdl", (c) => c.label);
    expect(result.map((c) => c.label)).toEqual(["/model"]);
  });

  it("matches letters across word boundaries", () => {
    const result = fuzzyFilter(COMMANDS, "memdbg", (c) => c.label);
    expect(result.map((c) => c.label)).toContain("/memory-debug");
  });

  it("keeps substring matches working", () => {
    const result = fuzzyFilter(COMMANDS, "exit", (c) => c.label);
    expect(result.map((c) => c.label)).toEqual(["/exit"]);
  });

  it("returns no matches for a missing needle", () => {
    expect(fuzzyFilter(COMMANDS, "zzz", (c) => c.label)).toEqual([]);
  });

  it("works on plain string lists", () => {
    expect(fuzzyFilter(["apple", "banana", "cherry"], "ban", (s) => s))
      .toEqual(["banana"]);
  });
});
