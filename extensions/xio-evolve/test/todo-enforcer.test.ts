import { describe, expect, it } from "vitest";

import { TodoEnforcer, parseTodos } from "../src/todo-enforcer.ts";

describe("TodoEnforcer", () => {
  it("returns the TODO protocol addendum", () => {
    const addendum = new TodoEnforcer().getSystemAddendum();

    expect(addendum).toContain("XioCode TODO Protocol");
    expect(addendum).toContain("Host Environment");
    expect(addendum).toContain("POSIX (macOS/Linux");
    expect(addendum).toContain("Windows (PowerShell/cmd)");
    expect(addendum).toContain("XioCode Tool Strategy");
    expect(addendum).not.toContain("search_context");
    expect(addendum).toContain("multi-step coding tasks");
    expect(addendum).toContain("simple direct questions");
    expect(addendum).toContain("parallel independent searches and reads");
    // Guidance already carried by DEFAULT_SYSTEM_PROMPT must not be restated here.
    expect(addendum).not.toMatch(/read the target files|edit surgically|gather file-backed evidence/i);
    expect(addendum.length).toBeLessThan(700);
  });

  it("parses markdown checkbox TODO items", () => {
    const todos = parseTodos("- [ ] inspect\n- [-] implement\n- [x] verify\nplain text");

    expect(todos).toEqual([
      { text: "inspect", status: "pending" },
      { text: "implement", status: "in_progress" },
      { text: "verify", status: "done" },
    ]);
  });
});
