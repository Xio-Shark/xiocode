import { describe, expect, it } from "vitest";

import {
  createDeadlineSignal,
  forceKillProcessTree,
  runSupervisedProcess,
} from "./process-supervisor.ts";
import { defineSupervisorContract } from "./supervisor-contract.testkit.ts";

defineSupervisorContract("runSupervisedProcess (legacy supervisor)", () => ({
  run: runSupervisedProcess,
}));

describe("runSupervisedProcess: legacy-only seams", () => {
  it("surfaces cleanup_failed when the tree refuses to die", async () => {
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 50)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      output: { headBytes: 256, tailBytes: 256, hardCapBytes: 64_000 },
      isTreeAlive: () => true,
      terminateTree: async () => false,
      termGraceMs: 20,
      killDeadlineMs: 20,
    });
    expect(result.termination).toBe("cleanup_failed");
    expect(result.cleanupError).toMatch(/remained alive/i);
  });

});

describe("createDeadlineSignal", () => {
  it("aborts on timeout with TimeoutError reason", async () => {
    const { signal, dispose, timedOut } = createDeadlineSignal(undefined, 30);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(timedOut()).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
    dispose();
  });
});

describe("forceKillProcessTree", () => {
  it("ignores invalid pids", () => {
    expect(() => forceKillProcessTree(null)).not.toThrow();
    expect(() => forceKillProcessTree(-1)).not.toThrow();
  });
});
