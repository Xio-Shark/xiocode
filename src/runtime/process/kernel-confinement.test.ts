import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxExecConfinementDriver } from "@xioflow/kernel";

import { DirectRollbackGate } from "../../../extensions/xio-sandbox/src/direct-gate.ts";
import { gitOk } from "../../../extensions/xio-sandbox/src/git.ts";
import { ExtensionHost } from "../extension-host.ts";
import { registerKernelCommand, setConfinement } from "../kernel-binding.ts";
import { KernelSession } from "./kernel-session.ts";

const SMALL = { headBytes: 4_096, tailBytes: 0, hardCapBytes: 64_000 } as const;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function open(): Promise<Readonly<{ session: KernelSession; workspace: string; outside: string }>> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xio-confine-")));
  const workspace = path.join(root, "ws");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const session = await KernelSession.open({ sessionId: "confine", workspaceRoot: workspace, domainPath: path.join(root, "domain") });
  cleanups.push(() => {
    session.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { session, workspace, outside };
}

const writeFile = (target: string) => ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`];

describe("write confinement", () => {
  it("is refused when commands bypass the kernel, since it could not see them", async () => {
    const { session } = await open();
    expect(() => setConfinement(session, true, { XIOCODE_PROCESS_KERNEL: "0" })).toThrow(/not run by the kernel/);
    expect(session.confinement).toEqual({ enabled: false });
  });

  it.skipIf(!SandboxExecConfinementDriver.isAvailable())(
    "keeps writes inside the workspace, explains a denied write and refuses commands started outside",
    async () => {
      const { session, workspace, outside } = await open();
      const host = new ExtensionHost();
      registerKernelCommand(host, () => session);
      expect(String(await host.runCommand("confine", "on"))).toContain("Write confinement is on (sandbox-exec)");
      expect(String(await host.runCommand("kernel", ""))).toContain("confinement: on (sandbox-exec)");

      const inside = await session.run({ command: process.execPath, args: writeFile(path.join(workspace, "a.txt")), cwd: workspace, output: SMALL });
      expect(inside.code).toBe(0);

      const denied = await session.run({ command: process.execPath, args: writeFile(path.join(outside, "b.txt")), cwd: workspace, output: SMALL });
      expect(denied.code).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "b.txt"))).toBe(false);
      expect(denied.stderr).toContain("[kernel] write confinement is on");

      const elsewhere = await session.run({ command: process.execPath, args: ["-e", "0"], cwd: outside, output: SMALL });
      expect(elsewhere.stderr).toMatch(/only run inside the workspace.*nothing was started/);

      await host.runCommand("confine", "off");
      const free = await session.run({ command: process.execPath, args: writeFile(path.join(outside, "b.txt")), cwd: workspace, output: SMALL });
      expect(free.code).toBe(0);
    },
  );

  it.skipIf(!SandboxExecConfinementDriver.isAvailable())(
    "lets the kernel vouch for a complete rollback only when every command since the checkpoint was confined",
    async () => {
      const { session, workspace } = await open();
      await gitOk(workspace, ["init"]);
      await gitOk(workspace, ["config", "user.email", "xio@test"]);
      await gitOk(workspace, ["config", "user.name", "xio"]);
      fs.writeFileSync(path.join(workspace, "app.txt"), "v0\n");
      await gitOk(workspace, ["add", "app.txt"]);
      await gitOk(workspace, ["commit", "-m", "init"]);
      const gate = new DirectRollbackGate(session);
      await gate.initSessionBaseline();
      const approve = async () => true;
      const edit = (content: string) => session.run({
        command: process.execPath,
        args: ["-e", `require('fs').writeFileSync('app.txt', ${JSON.stringify(content)})`],
        cwd: workspace,
        output: SMALL,
      });

      session.enableConfinement("test");
      await gate.captureTurnCheckpoint();
      expect((await edit("confined\n")).code).toBe(0);
      const complete = await gate.promptRollbackTurn(approve);
      // The checkpoint was taken under confinement, so it carries the ignored-file manifest that proves them unchanged.
      expect(complete.summary).toContain("found them unchanged");
      expect(complete.summary).toContain("the kernel vouches for a complete rollback");

      // A confined command that touches an ignored file: nothing escaped the workspace, but the claim is no longer complete.
      fs.writeFileSync(path.join(workspace, ".gitignore"), "*.cache\n");
      await gate.captureTurnCheckpoint();
      const touchIgnored = await session.run({
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('app.txt', 'x\\n'); require('fs').writeFileSync('build.cache', 'junk')"],
        cwd: workspace,
        output: SMALL,
      });
      expect(touchIgnored.code).toBe(0);
      const nonIgnored = await gate.promptRollbackTurn(approve);
      expect(nonIgnored.summary).toContain(`added (1):\n    ${path.join(workspace, "build.cache")}`);
      expect(nonIgnored.summary).toContain("everything except the ignored files");
      expect(nonIgnored.summary).not.toContain("complete");
      fs.rmSync(path.join(workspace, "build.cache"));
      fs.rmSync(path.join(workspace, ".gitignore"));

      session.disableConfinement("test");
      await gate.captureTurnCheckpoint();
      expect((await edit("unconfined\n")).code).toBe(0);
      const partial = await gate.promptRollbackTurn(approve);
      expect(partial.summary).toContain("may remain and were not rolled back");
      expect(partial.summary).not.toContain("vouches");
    },
  );

  it.skipIf(!SandboxExecConfinementDriver.isAvailable())(
    "does not vouch for a rollback while an unconfined service (an MCP server) is running",
    async () => {
      const { session, workspace } = await open();
      await gitOk(workspace, ["init"]);
      await gitOk(workspace, ["config", "user.email", "xio@test"]);
      await gitOk(workspace, ["config", "user.name", "xio"]);
      fs.writeFileSync(path.join(workspace, "app.txt"), "v0\n");
      await gitOk(workspace, ["add", "app.txt"]);
      await gitOk(workspace, ["commit", "-m", "init"]);
      const gate = new DirectRollbackGate(session);
      await gate.initSessionBaseline();
      const service = await session.startService("mcp", {
        command: { execPath: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: workspace },
        readiness: "spawned",
        restart: "never",
      });
      await service.ready;
      try {
        session.enableConfinement("test");
        await gate.captureTurnCheckpoint();
        fs.writeFileSync(path.join(workspace, "app.txt"), "changed\n");
        const result = await gate.promptRollbackTurn(async () => true);
        expect(result.summary).toContain("still running unconfined");
        expect(result.summary).not.toContain("vouches");
      } finally {
        await service.stop(500);
      }
    },
  );
});
