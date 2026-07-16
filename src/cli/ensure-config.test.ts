import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_TOML } from "./default-config.ts";
import { ensureConfigFile } from "./ensure-config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("ensureConfigFile", () => {
  it("creates a default config once and leaves existing files alone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-ensure-config-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.toml");
    const notices: string[] = [];
    const env = { XIO_CONFIG: configPath };

    const created = await ensureConfigFile(env, { write: (chunk) => notices.push(chunk) });
    expect(created.created).toBe(true);
    expect(created.path).toBe(configPath);
    expect(await readFile(configPath, "utf8")).toBe(DEFAULT_CONFIG_TOML);
    const noticeText = notices.join("");
    expect(noticeText).toContain("DEEPSEEK_API_KEY");
    expect(noticeText).toContain("project directory");
    expect(noticeText).not.toMatch(/git repo/i);
    expect(noticeText).toContain("Recommended CLI tools");
    expect(noticeText).toMatch(/ugrep → rg → grep/);

    await writeFile(configPath, "custom = true\n", "utf8");
    const second = await ensureConfigFile(env, { write: (chunk) => notices.push(chunk) });
    expect(second.created).toBe(false);
    expect(second.content).toBe("custom = true\n");
  });
});
