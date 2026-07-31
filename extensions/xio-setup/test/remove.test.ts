import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_TOML } from "../../../src/cli/default-config.ts";
import { parseXioConfig } from "../../../src/cli/config-parser.ts";
import {
  applyConfigSection,
  hasConfigSection,
  removeConfigSection,
} from "../src/sections.ts";
import { runSetupCli } from "../src/setup-cli.ts";

describe("removeConfigSection", () => {
  it("is a no-op when the section is absent", () => {
    expect(removeConfigSection(DEFAULT_CONFIG_TOML, "explore")).toBe(DEFAULT_CONFIG_TOML);
  });

  it("removes only the target block (with attached comments) and stays parseable", () => {
    let content = applyConfigSection(DEFAULT_CONFIG_TOML, "explore");
    content = applyConfigSection(content, "mcp");
    const next = removeConfigSection(content, "explore");
    expect(hasConfigSection(next, "explore")).toBe(false);
    expect(hasConfigSection(next, "mcp")).toBe(true);
    // Attached doc comments of the removed block are gone too.
    expect(next).not.toContain("Multi-explore scouts");
    expect(() => parseXioConfig(next)).not.toThrow();
  });

  it("removes dotted subtables and preserves comments attached to the next section", () => {
    const content = [
      "[general]",
      'default_provider = "deepseek"',
      'default_model = "deepseek-chat"',
      "",
      "[providers.deepseek]",
      'kind = "openai"',
      'model = "deepseek-chat"',
      'api_key_env = "DEEPSEEK_API_KEY"',
      "",
      "# explore docs",
      "[explore]",
      "enabled = true",
      "",
      "[explore.x]",
      "y = 1",
      "",
      "# mcp comment stays",
      "[mcp]",
      "timeout_ms = 30000",
      "",
    ].join("\n");
    const next = removeConfigSection(content, "explore");
    expect(hasConfigSection(next, "explore")).toBe(false);
    expect(next).not.toContain("[explore.x]");
    expect(next).not.toContain("# explore docs");
    expect(next).toContain("# mcp comment stays");
    expect(next).toContain("[mcp]");
    expect(() => parseXioConfig(next)).not.toThrow();
  });
});

describe("runSetupCli remove", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const makeEnv = async (): Promise<NodeJS.ProcessEnv> => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-remove-"));
    return { ...process.env, XIO_CONFIG: path.join(tmp, "config.toml") };
  };

  it("removes an added section, leaves the rest, and is idempotent", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);
    await runSetupCli(["add", "explore", "mcp"], { env, write });

    expect(await runSetupCli(["remove", "explore"], { env, write })).toBe(0);
    const content = await readFile(env.XIO_CONFIG!, "utf8");
    expect(hasConfigSection(content, "explore")).toBe(false);
    expect(hasConfigSection(content, "mcp")).toBe(true);
    expect(() => parseXioConfig(content)).not.toThrow();

    out.length = 0;
    expect(await runSetupCli(["remove", "explore"], { env, write })).toBe(0);
    expect(out.join("")).toContain("not present (nothing to remove): explore");
    expect(await readFile(env.XIO_CONFIG!, "utf8")).toBe(content);
  });

  it("rejects unknown ids and requires at least one id", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);
    expect(await runSetupCli(["remove", "nope"], { env, write })).toBe(1);
    expect(out.join("")).toContain("unknown section(s): nope");
    out.length = 0;
    expect(await runSetupCli(["remove"], { env, write })).toBe(1);
    expect(out.join("")).toContain("remove requires section id(s)");
  });
});
