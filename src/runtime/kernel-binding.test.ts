import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionDomain } from "@xioflow/kernel";

import { ExtensionHost } from "./extension-host.ts";
import {
  annotateInterruptedTools,
  createAuthorizationRecorder,
  createKernelTurnHooks,
  registerKernelCommand,
} from "./kernel-binding.ts";
import { formatOrphanRecoveryNotice, formatSessionRecoveryNotice } from "./process/kernel-notice.ts";
import { KernelSession } from "./process/kernel-session.ts";
import { INTERRUPTED_TOOL_PREFIX } from "./session-recovery.ts";
import type { ChatMessage } from "./types.ts";

const SMALL = { headBytes: 1_024, tailBytes: 0, hardCapBytes: 64_000 } as const;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function openSession(sessionId = "binding"): Promise<KernelSession> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xio-kernel-binding-")));
  const session = await KernelSession.open({ sessionId, workspaceRoot: dir, domainPath: path.join(dir, ".domain") });
  cleanups.push(() => {
    session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return session;
}

describe("createKernelTurnHooks", () => {
  it("opens and closes one Run per turn and reports a kernel refusal instead of swallowing it", async () => {
    const session = await openSession();
    const notices: string[] = [];
    const hooks = createKernelTurnHooks(session, (message) => notices.push(message));

    hooks.begin("t1");
    const turnRun = session.currentRunId;
    hooks.end({ status: "succeeded" });
    expect(session.status().runs.find((run) => run.id === turnRun)?.status).toBe("succeeded");
    expect(notices).toEqual([]);

    // A second begin for the same turn id collides with the finished Run → the kernel refuses.
    hooks.begin("t1");
    expect(notices[0]).toMatch(/could not open a Run/);
    hooks.end({ status: "succeeded" }); // no Run open → no-op, no second notice
    expect(notices).toHaveLength(1);
  });
});

describe("annotateInterruptedTools", () => {
  it("replaces 'completion unknown' with what the kernel recorded", async () => {
    const session = await openSession("resume");
    await session.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('tests passed')"],
      cwd: session.workspaceRoot,
      output: SMALL,
      operationKey: "call-done",
    });
    const interrupted = (id: string): ChatMessage => ({
      role: "tool",
      toolCallId: id,
      name: "bash",
      content: `${INTERRUPTED_TOOL_PREFIX} for bash; inspect workspace state before retrying`,
    });
    const untouched: ChatMessage = { role: "tool", toolCallId: "other", name: "read", content: "file text" };

    const [done, never, other] = annotateInterruptedTools(
      [interrupted("call-done"), interrupted("call-never"), untouched],
      session,
    );
    expect(done?.content).toContain("the process finished before the interruption (status=succeeded, exit=0)");
    expect(done?.content).toContain("tests passed");
    expect(never?.content).toContain("never started");
    expect(other).toBe(untouched);
  });

  it("does not present an exit recovery never observed as a finished command", () => {
    // Recovery records `failed` + `exit_unobserved` when the process died while
    // XioCode was down before its exit was recorded (kernel 0.5.0).
    const session = {
      getOperationByKey: () => ({
        opId: "op-x",
        status: "done",
        result: {
          kind: "process",
          status: "failed",
          terminationReason: "exit_unobserved",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
        },
      }),
    } as unknown as KernelSession;
    const [message] = annotateInterruptedTools([{
      role: "tool",
      toolCallId: "call-x",
      name: "bash",
      content: `${INTERRUPTED_TOOL_PREFIX} for bash`,
    }], session);
    expect(message?.content).toContain("its exit was never observed");
    expect(message?.content).not.toContain("finished before the interruption");
  });

  it("says recovery stopped a process that was still running, not that it had finished", () => {
    const session = {
      getOperationByKey: () => ({
        opId: "op-y",
        status: "done",
        result: {
          kind: "process",
          status: "cancelled",
          evidence: "unobserved",
          identityVerification: "is_original_process",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
        },
      }),
    } as unknown as KernelSession;
    const [message] = annotateInterruptedTools([{
      role: "tool",
      toolCallId: "call-y",
      name: "bash",
      content: `${INTERRUPTED_TOOL_PREFIX} for bash`,
    }], session);
    expect(message?.content).toContain("was still running when XioCode came back, and recovery stopped it");
    expect(message?.content).not.toContain("finished before the interruption");
  });

  it("does not claim a call never started when commands bypass the kernel", () => {
    const session = { getOperationByKey: () => undefined } as unknown as KernelSession;
    const interrupted: ChatMessage = {
      role: "tool",
      toolCallId: "call-z",
      name: "bash",
      content: `${INTERRUPTED_TOOL_PREFIX} for bash`,
    };
    const [bypassed] = annotateInterruptedTools([interrupted], session, { XIOCODE_PROCESS_KERNEL: "0" });
    expect(bypassed?.content).toContain("it has no record of this call");
    expect(bypassed?.content).not.toContain("never started");
    const [viaKernel] = annotateInterruptedTools([interrupted], session, {});
    expect(viaKernel?.content).toContain("never started");
  });
});

describe("authorization recorder and /kernel", () => {
  it("journals decisions on the current Run and exposes status and adjudication", async () => {
    const session = await openSession("ledger");
    const record = createAuthorizationRecorder(session, () => undefined);
    session.beginTurn("t1");
    const turnRun = session.currentRunId;
    record({ gate: "tool", tool: "bash", decision: "allow", by: "user", scope: "session", mode: "auto", toolCallId: "c1" });

    const host = new ExtensionHost();
    registerKernelCommand(host, () => session);
    const status = String(await host.runCommand("kernel"));
    expect(status).toContain(`domain: ${session.domainPath}`);
    expect(status).toContain(`driver: ${session.driver.name} (${session.driver.reason})`);
    expect(status).toContain("leases: none");
    await expect(host.runCommand("kernel", "adjudicate nope")).rejects.toThrow(/not found/);
    expect(String(await host.runCommand("kernel", "adjudicate"))).toMatch(/usage/);

    session.endTurn({ status: "succeeded" });
    const domainPath = session.domainPath;
    session.close();
    const domain = ExecutionDomain.acquire(domainPath, "ledger");
    try {
      const facts = domain.getStore().getEventsByRun(turnRun).filter((event) => event.type === "XIOCODE_AUTHORIZATION");
      expect(facts.map((event) => event.payload)).toEqual([
        { gate: "tool", tool: "bash", decision: "allow", by: "user", scope: "session", mode: "auto", toolCallId: "c1" },
      ]);
    } finally {
      domain.close();
    }
  });
});

describe("recovery notices", () => {
  it("tells the user what recovery did and how to resolve what it could not", () => {
    const text = formatSessionRecoveryNotice([
      { opId: "op-a", action: "stopped_alive_process", resourcesReleased: true },
      { opId: "op-b", action: "isolated_indeterminate", resourcesReleased: false },
    ], "/tmp/domain");
    expect(text).toContain("Recovered 2 operation(s)");
    expect(text).toContain("op-a: was still running — stopped");
    expect(text).toContain("/kernel adjudicate op-b");
    expect(formatSessionRecoveryNotice([], "/tmp/domain")).toBeUndefined();

    const orphan = formatOrphanRecoveryNotice([
      { domainPath: "/k/ws-1-s2", sameWorkspace: true, recovered: [{ opId: "op-c", action: "isolated_indeterminate", resourcesReleased: false }] },
      { domainPath: "/k/other", sameWorkspace: false, recovered: [], error: "disk full" },
    ]);
    expect(orphan).toContain("a crashed session in this workspace");
    expect(orphan).toContain("xio kernel adjudicate op-c --domain /k/ws-1-s2");
    expect(orphan).toContain("Could not recover a crashed session (/k/other): disk full");
  });
});
