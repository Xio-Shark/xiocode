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
    expect(addendum).toContain("Fan out with glob/grep/find");
    expect(addendum).not.toContain("search_context");
    expect(addendum).toContain("gather file-backed evidence before answering");
    expect(addendum).toContain("repo/code/config/debug/audit");
    expect(addendum).toContain("files, command output, tests");
    expect(addendum).toContain("multi-step coding tasks");
    expect(addendum).toContain("simple direct questions");
    expect(addendum).toContain("parallel independent searches and reads");
    expect(addendum.length).toBeLessThan(1400);
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
