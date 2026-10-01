import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashObservation, normalizeObservation, resultText, toObservationEntry } from "./parallel-observations.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import { WorkspacePathPolicy } from "./workspace-path-policy.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The same small tree in a fresh directory, with worker-style tools rooted in it. */
async function tree(): Promise<Readonly<{ root: string; run: (tool: string, args: Record<string, unknown>) => Promise<string> }>> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xio-observe-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, "src", `m${i}.ts`), `export const value${i} = ${i};\n// marker\n`);
  fs.writeFileSync(path.join(root, "README.md"), "# tree\nmarker here too\n");
  const pathPolicy = await WorkspacePathPolicy.create({ workspaceRoot: root, cwd: root });
  const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, pathPolicy, grepOutline: false });
  return {
    root,
    async run(tool, args) {
      const definition = tools.find((t) => t.name === tool)!;
      return resultText(await definition.execute(`call-${tool}`, args));
    },
  };
}

describe("normalizeObservation", () => {
  it.each([
    ["read", { path: "src/m3.ts" }],
    ["grep", { pattern: "marker" }],
    ["glob", { pattern: "src/*.ts" }],
  ])("%s: the same tree in two directories hashes the same, twice in a row", async (tool, args) => {
    const first = await tree();
    const second = await tree();
    const hashes = [
      hashObservation(tool, await first.run(tool, args), first.root),
      hashObservation(tool, await first.run(tool, args), first.root),
      hashObservation(tool, await second.run(tool, args), second.root),
    ];
    expect(new Set(hashes).size).toBe(1);
  });

  it("a changed tree hashes differently", async () => {
    const first = await tree();
    const before = hashObservation("grep", await first.run("grep", { pattern: "marker" }), first.root);
    fs.writeFileSync(path.join(first.root, "src", "extra.ts"), "// marker\n");
    expect(hashObservation("grep", await first.run("grep", { pattern: "marker" }), first.root)).not.toBe(before);
  });

  it("sorts search results and removes the root from results and arguments", () => {
    expect(normalizeObservation("grep", "/fork/b.ts:1:x\n/fork/a.ts:2:x", "/fork")).toBe("<root>/a.ts:2:x\n<root>/b.ts:1:x");
    expect(normalizeObservation("read", "line 2\nline 1", "/fork")).toBe("line 2\nline 1");
    const entry = toObservationEntry(
      { id: "c", name: "read", arguments: { path: "/fork/src/a.ts" } },
      { content: [{ type: "text", text: "body" }] },
      "/fork",
    );
    expect(entry).toMatchObject({ kind: "observe", tool: "read", args: { path: "<root>/src/a.ts" }, resultBytes: 4, isError: false });
    expect(toObservationEntry({ id: "c", name: "skill", arguments: {} }, { content: [] }, "/fork")).toBeUndefined();
  });
});
