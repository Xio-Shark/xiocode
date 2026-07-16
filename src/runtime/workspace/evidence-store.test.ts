import { describe, expect, it } from "vitest";

import { EvidenceStore, EvidenceStaleError } from "./evidence-store.ts";

describe("EvidenceStore", () => {
  it("stores and retrieves excerpts by citation", () => {
    const store = new EvidenceStore();
    const record = store.putFromText({
      path: "src/a.ts",
      text: "line1\nline2\nline3",
      startLine: 2,
      endLine: 3,
    });
    expect(record.text).toBe("line2\nline3");
    const loaded = store.get(record);
    expect(loaded.text).toBe("line2\nline3");
  });

  it("fails visibly when citation is stale or missing", () => {
    const store = new EvidenceStore();
    const record = store.putFromText({ path: "a.ts", text: "hello", fileHash: "abc" });
    expect(() => store.get({ ...record, hash: "other" })).toThrow(EvidenceStaleError);
    store.invalidatePath("a.ts");
    expect(() => store.get(record)).toThrow(/missing/);
  });

  it("bounds raw evidence reads", () => {
    const store = new EvidenceStore();
    const record = store.putFromText({ path: "big.ts", text: "x".repeat(100) });
    const bounded = store.readEvidence(record, { maxChars: 20 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.startsWith("x".repeat(20))).toBe(true);
    expect(bounded.text).toContain("truncated by maxChars=20");
  });

  it("putSnippet stores text as-is under real line citations (no empty re-slice)", () => {
    const store = new EvidenceStore();
    const record = store.putSnippet({
      path: "src/a.ts",
      text: "function greet",
      startLine: 12,
      endLine: 12,
      hash: "deadbeef",
    });
    expect(record.text).toBe("function greet");
    expect(record.startLine).toBe(12);
    const loaded = store.readEvidence(record);
    expect(loaded.text).toBe("function greet");
    expect(loaded.truncated).toBe(false);
  });
});
