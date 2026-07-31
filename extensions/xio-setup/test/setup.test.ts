import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_TOML } from "../../../src/cli/default-config.ts";
import { parseXioConfig } from "../../../src/cli/config-parser.ts";
import {
  applyConfigSection,
  applyConfigSections,
  CONFIG_SECTIONS,
  hasConfigSection,
  listSectionStatus,
} from "../src/sections.ts";
import { formatSectionList, runSetupCli } from "../src/setup-cli.ts";

describe("config sections catalog", () => {
  it("keeps ids unique and every snippet parseable on top of the minimal template", () => {
    const ids = CONFIG_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Applying everything must yield a config the real parser accepts.
    const full = applyConfigSections(DEFAULT_CONFIG_TOML, ids);
    const parsed = parseXioConfig(full);
    // Values written are the same safe defaults used when sections are absent.
    expect(parsed.runtimeConfig.explore.enabled).toBe(false);
    expect(parsed.xio.worktree.enabled).toBe(false);
    expect(parsed.xio.trust.mode).toBe("ask");
  });

  it("slim default template has no optional sections; commented headers never count", () => {
    for (const status of listSectionStatus(DEFAULT_CONFIG_TOML)) {
      expect(status.present).toBe(false);
    }
    expect(hasConfigSection("# [explore]\n# enabled = true\n", "explore")).toBe(false);
    expect(hasConfigSection("[explore]\nenabled = false\n", "explore")).toBe(true);
    // Dotted subtable alone still marks the section as user-managed.
    expect(hasConfigSection("[explore.x]\n", "explore")).toBe(true);
    // providers.deepseek must not shadow unrelated ids.
    expect(hasConfigSection(DEFAULT_CONFIG_TOML, "tools")).toBe(false);
  });

  it("apply is idempotent and appends exactly one block", () => {
    const once = applyConfigSection(DEFAULT_CONFIG_TOML, "mcp");
    const twice = applyConfigSection(once, "mcp");
    expect(twice).toBe(once);
    expect(once.match(/^\[mcp\]/gm)).toHaveLength(1);
  });
});

describe("runSetupCli", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const makeEnv = async (): Promise<NodeJS.ProcessEnv> => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-"));
    return { ...process.env, XIO_CONFIG: path.join(tmp, "config.toml") };
  };

  it("add appends sections, validates with the parser, and stays idempotent", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);

    expect(await runSetupCli(["add", "explore", "mcp"], { env, write })).toBe(0);
    const content = await readFile(env.XIO_CONFIG!, "utf8");
    expect(hasConfigSection(content, "explore")).toBe(true);
    expect(hasConfigSection(content, "mcp")).toBe(true);
    expect(() => parseXioConfig(content)).not.toThrow();

    expect(await runSetupCli(["add", "explore"], { env, write })).toBe(0);
    expect(await readFile(env.XIO_CONFIG!, "utf8")).toBe(content);
    expect(out.join("")).toContain("already present: explore");
  });

  it("rejects unknown sections and lists known ids", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    expect(await runSetupCli(["add", "nope"], { env, write: (c) => out.push(c) })).toBe(1);
    expect(out.join("")).toContain("unknown section(s): nope");
    expect(out.join("")).toContain("explore");
  });

  it("list marks present sections and add --all fills the rest", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);
    await runSetupCli(["add", "trust"], { env, write });
    out.length = 0;
    await runSetupCli(["list"], { env, write });
    const listing = out.join("");
    expect(listing).toContain("✓ trust");
    expect(listing).toMatch(/· explore/);

    expect(await runSetupCli(["add", "--all"], { env, write })).toBe(0);
    const content = await readFile(env.XIO_CONFIG!, "utf8");
    for (const status of listSectionStatus(content)) {
      expect(status.present).toBe(true);
    }
  });

  it("interactive menu applies a numbered pick then quits", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const answers = ["1", "q"];
    const code = await runSetupCli([], {
      env,
      write: (chunk) => out.push(chunk),
      ask: async () => answers.shift() ?? "q",
    });
    expect(code).toBe(0);
    const content = await readFile(env.XIO_CONFIG!, "utf8");
    expect(hasConfigSection(content, CONFIG_SECTIONS[0]!.id)).toBe(true);
  });

  it("non-TTY bare invocation prints help + status instead of hanging", async () => {
    const env = await makeEnv();
    const out: string[] = [];
    const code = await runSetupCli([], { env, write: (c) => out.push(c), isTty: false });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("xio-setup — progressively enable");
    expect(text).toContain("optional sections");
    expect(formatSectionList(DEFAULT_CONFIG_TOML)).toContain("explore");
  });
});
