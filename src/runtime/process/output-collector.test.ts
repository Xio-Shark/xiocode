import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BoundedOutputCollector } from "./output-collector.ts";

describe("BoundedOutputCollector", () => {
  it("keeps head and tail with an explicit truncation marker", async () => {
    const collector = new BoundedOutputCollector({
      headBytes: 8,
      tailBytes: 8,
      hardCapBytes: 1_000,
    });
    collector.push("stdout", "AAAAAAAA"); // 8
    collector.push("stdout", "MMMMMMMM"); // middle dropped after soft cap
    collector.push("stdout", "ZZZZZZZZ");
    const snap = await collector.finalize();
    expect(snap.stdout.truncated).toBe(true);
    expect(snap.stdout.text.startsWith("AAAAAAAA")).toBe(true);
    expect(snap.stdout.text.endsWith("ZZZZZZZZ")).toBe(true);
    expect(snap.stdout.text).toContain("…[truncated]…");
    expect(snap.stdout.bytesSeen).toBe(24);
  });

  it("enforces aggregate hard cap across stdout and stderr", async () => {
    const collector = new BoundedOutputCollector({
      headBytes: 64,
      tailBytes: 64,
      hardCapBytes: 20,
    });
    expect(collector.push("stdout", "x".repeat(12))).toBe(false);
    expect(collector.push("stderr", "y".repeat(12))).toBe(true);
    expect(collector.isHardCapExceeded()).toBe(true);
    expect(collector.getAggregateBytesSeen()).toBe(24);
  });

  it("bounds peak retained bytes under configured soft cap", async () => {
    const collector = new BoundedOutputCollector({
      headBytes: 32,
      tailBytes: 32,
      hardCapBytes: 10_000,
    });
    for (let i = 0; i < 50; i += 1) {
      collector.push("stdout", "n".repeat(40));
    }
    expect(collector.getPeakRetainedBytes()).toBeLessThanOrEqual(
      collector.configuredBoundBytes() + 40,
    );
    const snap = await collector.finalize();
    expect(snap.stdout.truncated).toBe(true);
    expect(snap.peakRetainedBytes).toBeLessThanOrEqual(collector.configuredBoundBytes() + 40);
  });

  it("handles UTF-8 characters split across chunks", async () => {
    const collector = new BoundedOutputCollector({
      headBytes: 64,
      tailBytes: 64,
      hardCapBytes: 1_000,
    });
    const euro = Buffer.from("€", "utf8"); // 3 bytes
    collector.push("stdout", euro.subarray(0, 1));
    collector.push("stdout", euro.subarray(1));
    const snap = await collector.finalize();
    expect(snap.stdout.text).toBe("€");
  });

  it("spills after trigger with private file mode and keeps streaming append", async () => {
    const spillDir = await mkdtemp(path.join(os.tmpdir(), "xio-spill-"));
    const collector = new BoundedOutputCollector({
      headBytes: 8,
      tailBytes: 8,
      hardCapBytes: 10_000,
      spillTriggerBytes: 16,
      spillDir,
    });
    collector.push("stdout", "A".repeat(10));
    collector.push("stdout", "B".repeat(10)); // crosses 16
    collector.push("stdout", "C".repeat(10));
    const snap = await collector.finalize();
    expect(snap.stdout.spillPath).toBeTruthy();
    expect(snap.stdout.truncated).toBe(true);
    const st = await stat(snap.stdout.spillPath!);
    if (process.platform !== "win32") {
      expect(st.mode & 0o777).toBe(0o600);
    }
    const onDisk = await readFile(snap.stdout.spillPath!, "utf8");
    expect(onDisk).toBe(`${"A".repeat(10)}${"B".repeat(10)}${"C".repeat(10)}`);
    expect(snap.stdout.text).toContain("[process_output spilled:");
  });
});
