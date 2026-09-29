import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionDomain } from "@xioflow/kernel";

import { runKernelCli } from "./kernel-cli.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempRoot(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xio-kernel-cli-")));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A domain holding one indeterminate operation that keeps its lease. */
function seedIndeterminate(domainPath: string, domainId: string, opId: string): ExecutionDomain {
  const domain = ExecutionDomain.acquire(domainPath, domainId);
  const store = domain.getStore();
  store.saveTask({ id: "t", domainId, name: "t", createdAt: new Date().toISOString() });
  store.saveRun({ id: "r", taskId: "t", domainId, owner: "o", status: "running", startedAt: new Date().toISOString() });
  domain.registerOperationIntent({
    id: opId, runId: "r", kind: "process", name: "process:/bin/sh",
    inputFingerprint: "fp", requiredResources: [`workspace:write:/w/${opId}`], status: "pending",
  });
  store.recordOperationResult(opId, {
    kind: "indeterminate", status: "indeterminate", reason: "stop not confirmed",
    recoveryGuidance: "inspect", durationMs: 1, completedAt: new Date().toISOString(),
  }, false);
  return domain;
}

async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runKernelCli(args, { env, write: (c) => { out += c; }, writeErr: (c) => { err += c; } });
  return { code, out, err };
}

describe("xio kernel", () => {
  it("status lists domains that need attention under XIOCODE_KERNEL_DOMAIN_ROOT", async () => {
    const root = tempRoot();
    const env = { XIOCODE_KERNEL_DOMAIN_ROOT: root };
    seedIndeterminate(path.join(root, "closed-domain"), "closed", "op-closed").close();
    const live = seedIndeterminate(path.join(root, "live-domain"), "live", "op-live");
    cleanups.push(() => live.close());
    ExecutionDomain.acquire(path.join(root, "clean-domain"), "clean").close();

    const { code, out } = await cli(["status"], env);
    expect(code).toBe(0);
    expect(out).toContain(`kernel domains: ${root} (3 total)`);
    expect(out).toContain(`xio kernel adjudicate op-closed --domain ${path.join(root, "closed-domain")}`);
    expect(out).toContain(`live session pid ${process.pid}`);
    expect(out).toContain("/kernel adjudicate op-live  (in that session)");
    expect(out).not.toContain("clean-domain");
    expect((await cli(["status", "--all"], env)).out).toContain("clean-domain");
  });

  it("adjudicates by searching the configured root, and points to /kernel when a live session owns the domain", async () => {
    const root = tempRoot();
    const env = { XIOCODE_KERNEL_DOMAIN_ROOT: root };
    seedIndeterminate(path.join(root, "closed-domain"), "closed", "op-closed").close();
    const live = seedIndeterminate(path.join(root, "live-domain"), "live", "op-live");
    cleanups.push(() => live.close());

    const done = await cli(["adjudicate", "op-closed", "--note", "checked"], env);
    expect(done.code).toBe(0);
    expect(done.out).toContain("Verdict:            confirmed_stopped");

    const blocked = await cli(["adjudicate", "op-live"], env);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain(`running XioCode session (pid ${process.pid})`);
    expect(blocked.err).toContain("/kernel adjudicate op-live");

    const missing = await cli(["adjudicate", "op-nowhere"], env);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(`no execution domain under ${root}`);
  });
});
