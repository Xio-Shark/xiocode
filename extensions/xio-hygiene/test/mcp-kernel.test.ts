import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { connectMcpServer } from "../src/mcp.ts";
import { bindKernelSession, closeKernelSession } from "../../../src/runtime/process/index.ts";

const STDIO_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-echo.mjs");
const tempDirs: string[] = [];

afterEach(async () => {
  await closeKernelSession();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("MCP stdio on a kernel service", () => {
  it("runs the server as a supervised service, stops it confirmed, and keeps env values out of the journal", async () => {
    const workspace = await tempDir("xio-mcp-kernel-ws-");
    const domainRoot = await tempDir("xio-mcp-kernel-domain-");
    const session = await bindKernelSession({
      sessionId: "mcp-kernel",
      workspaceRoot: workspace,
      env: { XIOCODE_KERNEL_DOMAIN_ROOT: domainRoot },
    });
    const secret = "fixture-secret-value-42";

    const connection = await connectMcpServer(
      {
        name: "echo",
        source: "config",
        spec: { transport: "stdio", command: process.execPath, args: [STDIO_FIXTURE], env: { FIXTURE_TOKEN: secret } },
      },
      { cwd: workspace, timeoutMs: 15_000 },
    );
    const result = await connection.client.callTool({ name: "echo", arguments: { text: "k" } });
    expect((result.content as { text: string }[])[0]?.text).toBe("fixture-echo:k");

    const serviceOp = session.status().operations.find((op) => op.kind === "service");
    expect(serviceOp?.id).toMatch(/^svc-.*-mcp-echo-\d+#1$/);
    expect(serviceOp?.status).toBe("active");
    expect(serviceOp?.runId).toBe(session.launchRunId);
    const pid = serviceOp!.processIdentity!.pid;
    expect(isAlive(pid)).toBe(true);

    await connection.close();

    const after = session.status().operations.find((op) => op.id === serviceOp!.id);
    expect(after?.status).toBe("done");
    expect(isAlive(pid)).toBe(false);
    const status = session.status();
    expect(JSON.stringify(status.operations)).not.toContain(secret);
  });
});
