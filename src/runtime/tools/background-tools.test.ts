import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeKernelSession } from "../process/index.ts";
import type { ToolDefinition } from "../types.ts";
import { WorkspacePathPolicy } from "../workspace-path-policy.ts";
import { createBuiltinTools } from "./builtin.ts";

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function call(t: ToolDefinition, params: Record<string, unknown>) {
  const result = await t.execute("call-1", params as never, undefined as never);
  return { text: result.content.map((part) => ("text" in part ? part.text : "")).join(""), isError: result.isError === true };
}

describe("bash background mode and the jobs tool", () => {
  let root: string;
  let tools: readonly ToolDefinition[];

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xiocode-bgtool-")));
    // Resolved up front: a policy still initializing when afterEach removes root would reject unobserved.
    const pathPolicy = await WorkspacePathPolicy.create({ workspaceRoot: root, cwd: root });
    tools = createBuiltinTools({ cwd: root, searchEngine: "node", pathPolicy });
  });

  afterEach(async () => {
    // Ends the ephemeral kernel session the tools opened, stopping its jobs.
    await closeKernelSession();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a server in the background, reads its output and stops it", async () => {
    const started = await call(tool(tools, "bash"), { command: "echo serving; sleep 30", background: true });
    expect(started.isError).toBe(false);
    expect(started.text).toMatch(/^job-1 running: echo serving; sleep 30/);
    expect(started.text).toContain("serving");

    const listed = await call(tool(tools, "jobs"), { action: "list" });
    expect(listed.text).toBe("job-1 running: echo serving; sleep 30");

    const output = await call(tool(tools, "jobs"), { action: "output", id: "job-1" });
    expect(output.text).toContain("serving");

    const stopped = await call(tool(tools, "jobs"), { action: "stop", id: "job-1" });
    expect(stopped.isError).toBe(false);
    expect(stopped.text).toMatch(/^job-1 stopped( exit_code=\S+( signal=\S+)?)?: echo serving; sleep 30$/);
  });

  it("tells the model when a foreground command's leftovers were stopped", async () => {
    const result = await call(tool(tools, "bash"), { command: "nohup sleep 30 >/dev/null 2>&1 &" });
    expect(result.isError).toBe(false);
    expect(result.text.split("\n")[1]).toMatch(/^note: processes this command left running were stopped/);
  });

  it("reports an unknown job id as an error", async () => {
    const result = await call(tool(tools, "jobs"), { action: "stop", id: "job-7" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no background job job-7");
  });
});
