import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatUpdateNotice,
  isNewerVersion,
  parseSemver,
  runUpdateCheck,
  scheduleUpdateCheck,
  shouldSkipUpdateCheck,
} from "./update-check.ts";

describe("update-check", () => {
  it("parses and compares semver cores", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(isNewerVersion("1.1.1", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.0.9", "1.1.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });

  it("formats a Codex-style notice", () => {
    expect(formatUpdateNotice({
      current: "1.1.0",
      latest: "1.2.0",
      packageName: "@xioshark/xiocode",
    })).toBe("Update available: 1.1.0 → 1.2.0 · npm i -g @xioshark/xiocode");
  });

  it("skips under CI / disable flags", () => {
    expect(shouldSkipUpdateCheck({ CI: "1" })).toBe(true);
    expect(shouldSkipUpdateCheck({ XIO_DISABLE_UPDATE_CHECK: "true" })).toBe(true);
    expect(shouldSkipUpdateCheck({ XIO_PERF_BOOT_EXIT: "1" })).toBe(true);
    expect(shouldSkipUpdateCheck({})).toBe(false);
  });

  it("returns a notice when registry latest is newer", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "xio-update-"));
    const cachePath = path.join(dir, "update-check.json");
    const result = await runUpdateCheck({
      current: "1.1.0",
      packageName: "@xioshark/xiocode",
      cachePath,
      env: {},
      fetchLatest: async () => "1.2.0",
    });
    expect(result?.notice).toContain("1.1.0 → 1.2.0");
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as { latest: string };
    expect(cached.latest).toBe("1.2.0");
  });

  it("uses fresh cache without refetch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "xio-update-"));
    const cachePath = path.join(dir, "update-check.json");
    await writeFile(cachePath, JSON.stringify({
      checkedAt: Date.now(),
      latest: "1.3.0",
      packageName: "@xioshark/xiocode",
    }));
    let fetches = 0;
    const result = await runUpdateCheck({
      current: "1.1.0",
      packageName: "@xioshark/xiocode",
      cachePath,
      env: {},
      fetchLatest: async () => {
        fetches += 1;
        return "9.9.9";
      },
    });
    expect(fetches).toBe(0);
    expect(result?.latest).toBe("1.3.0");
  });

  it("returns null when up to date or fetch fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "xio-update-"));
    const cachePath = path.join(dir, "update-check.json");
    await expect(scheduleUpdateCheck({
      current: "1.2.0",
      packageName: "@xioshark/xiocode",
      cachePath,
      env: {},
      fetchLatest: async () => "1.2.0",
    })).resolves.toBeNull();

    await expect(scheduleUpdateCheck({
      current: "1.1.0",
      packageName: "@xioshark/xiocode",
      cachePath: path.join(dir, "miss.json"),
      env: {},
      fetchLatest: async () => {
        throw new Error("network down");
      },
    })).resolves.toBeNull();
  });
});
