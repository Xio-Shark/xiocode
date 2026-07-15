import { describe, expect, it } from "vitest";

import { fixHintFor, withFixHint } from "./error-guidance.ts";

describe("error-guidance", () => {
  it("adds Fix for ambiguous edit", () => {
    const msg = "edit failed: old_string matched 2 times in src/a.ts; must be unique";
    const out = withFixHint("edit", msg);
    expect(out).toContain(msg);
    expect(out).toMatch(/Fix:/);
    expect(out.toLowerCase()).toMatch(/replace_all|unique/);
  });

  it("adds Fix for bash non-zero exit", () => {
    const out = withFixHint("bash", "exit_code=1\n\nstderr:\nboom");
    expect(out).toMatch(/Fix:/);
    expect(out.toLowerCase()).toMatch(/stderr|root cause|non-zero/);
  });

  it("adds Fix for workspace escape", () => {
    const out = withFixHint("write", "path escapes workspace root: /tmp/x (root=/ws)");
    expect(out).toMatch(/Fix:/);
    expect(out.toLowerCase()).toMatch(/workspace|worktree/);
  });

  it("does not double-append Fix", () => {
    const once = withFixHint("edit", "edit failed: old_string not found in f.ts");
    const twice = withFixHint("edit", once);
    expect(twice.match(/Fix:/g)?.length).toBe(1);
  });

  it("covers done contract", () => {
    expect(fixHintFor("done", "DONE CONTRACT FAILED")).toMatch(/exit 0|complete/i);
  });
});
