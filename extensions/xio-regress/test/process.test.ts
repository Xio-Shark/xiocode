import { describe, expect, it } from "vitest";

import { spawnCommand } from "../../xio-eval/src/process.ts";

describe("private regression process boundary", () => {
  it("bounds verifier output captured by the shared process runner", async () => {
    const result = await spawnCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096))"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 128,
    });

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(128);
    expect(Buffer.byteLength(result.stderr)).toBe(128);
  });
});
