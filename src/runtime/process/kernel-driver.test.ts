import { describe, expect, it } from "vitest";

import { ReaperPlatformDriver } from "@xioflow/kernel";

import { resolveKernelDriver } from "./kernel-driver.ts";

describe("resolveKernelDriver", () => {
  it("auto picks the native reaper exactly when its helper ships for this platform", () => {
    const choice = resolveKernelDriver({});
    expect(choice.name).toBe(ReaperPlatformDriver.isAvailable() ? "reaper" : "node");
    expect(choice.reason.length).toBeGreaterThan(0);
    expect(choice.create().name).toBe(choice.name === "reaper" ? "reaper" : "node-default");
  });

  it("honors an explicit node choice", () => {
    const choice = resolveKernelDriver({ XIOCODE_KERNEL_DRIVER: "node" });
    expect(choice).toMatchObject({ name: "node", reason: "XIOCODE_KERNEL_DRIVER=node" });
  });

  it("rejects an unknown value instead of guessing", () => {
    expect(() => resolveKernelDriver({ XIOCODE_KERNEL_DRIVER: "fast" })).toThrow(/auto, node or reaper/);
  });
});
