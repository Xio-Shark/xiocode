import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgentsMd, type AgentsMdConfig } from "../src/agents-md.ts";
import { registerXioHygiene } from "../src/index.ts";
import { ExtensionHost } from "../../../src/runtime/extension-host.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function config(partial: Partial<AgentsMdConfig> = {}): AgentsMdConfig {
  return {
    enabled: true,
    readClaudeDirs: true,
    maxBytes: 65_536,
    maxImportDepth: 3,
    ...partial,
  };
}

describe("loadAgentsMd", () => {
  it("returns empty when no CLAUDE.md or AGENTS.md exist", async () => {
    const root = await tempRoot("xio-agents-none-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });

    const bundle = await loadAgentsMd({ cwd, home, config: config() });
    expect(bundle.text).toBe("");
    expect(bundle.sources).toEqual([]);
  });

  it("loads project CLAUDE.md only", async () => {
    const root = await tempRoot("xio-agents-claude-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "CLAUDE.md"), "project claude rules\n", "utf8");

    const bundle = await loadAgentsMd({ cwd, home, config: config() });
    expect(bundle.text).toContain("project claude rules");
    expect(bundle.text).toContain("[agents_md]");
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.path).toBe(path.join(cwd, "CLAUDE.md"));
  });

  it("loads project AGENTS.md only", async () => {
    const root = await tempRoot("xio-agents-agents-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "project agents rules\n", "utf8");

    const bundle = await loadAgentsMd({ cwd, home, config: config() });
    expect(bundle.text).toContain("project agents rules");
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.path).toBe(path.join(cwd, "AGENTS.md"));
  });

  it("loads both project CLAUDE.md and AGENTS.md in order", async () => {
    const root = await tempRoot("xio-agents-both-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "CLAUDE.md"), "CLAUDE_BODY\n", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "AGENTS_BODY\n", "utf8");

    const bundle = await loadAgentsMd({ cwd, home, config: config() });
    const claudeAt = bundle.text.indexOf("CLAUDE_BODY");
    const agentsAt = bundle.text.indexOf("AGENTS_BODY");
    expect(claudeAt).toBeGreaterThanOrEqual(0);
    expect(agentsAt).toBeGreaterThan(claudeAt);
    expect(bundle.sources).toHaveLength(2);
  });

  it("merges global Claude + global Xio + project files", async () => {
    const root = await tempRoot("xio-agents-global-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".xiocode"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(home, ".claude", "CLAUDE.md"), "GLOBAL_CLAUDE\n", "utf8");
    await writeFile(path.join(home, ".xiocode", "AGENTS.md"), "GLOBAL_XIO\n", "utf8");
    await writeFile(path.join(cwd, "CLAUDE.md"), "PROJECT_CLAUDE\n", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "PROJECT_AGENTS\n", "utf8");

    const bundle = await loadAgentsMd({ cwd, home, config: config() });
    const order = ["GLOBAL_CLAUDE", "GLOBAL_XIO", "PROJECT_CLAUDE", "PROJECT_AGENTS"].map((marker) =>
      bundle.text.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(order[2]).toBeLessThan(order[3]!);
    expect(bundle.sources).toHaveLength(4);
  });

  it("skips ~/.claude when read_claude_dirs is false", async () => {
    const root = await tempRoot("xio-agents-no-claude-dir-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(home, ".claude", "CLAUDE.md"), "GLOBAL_CLAUDE\n", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "PROJECT_AGENTS\n", "utf8");

    const bundle = await loadAgentsMd({
      cwd,
      home,
      config: config({ readClaudeDirs: false }),
    });
    expect(bundle.text).not.toContain("GLOBAL_CLAUDE");
    expect(bundle.text).toContain("PROJECT_AGENTS");
  });

  it("expands @ imports and detects cycles", async () => {
    const root = await tempRoot("xio-agents-import-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "shared.md"), "SHARED_RULE\n", "utf8");
    await writeFile(path.join(cwd, "CLAUDE.md"), "@shared.md\n@loop.md\n", "utf8");
    await writeFile(path.join(cwd, "loop.md"), "@CLAUDE.md\nLOOP_BODY\n", "utf8");

    const warnings: string[] = [];
    const bundle = await loadAgentsMd({
      cwd,
      home,
      config: config(),
      warn: (message) => warnings.push(message),
    });
    expect(bundle.text).toContain("SHARED_RULE");
    expect(warnings.some((message) => message.includes("cycle"))).toBe(true);
  });

  it("expands ~/ imports against the configured home", async () => {
    const root = await tempRoot("xio-agents-tilde-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(home, ".xiocode"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(home, ".xiocode", "shared.md"), "HOME_SHARED\n", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "@~/.xiocode/shared.md\n", "utf8");

    const bundle = await loadAgentsMd({ cwd, home, config: config() });
    expect(bundle.text).toContain("HOME_SHARED");
    expect(bundle.sources.some((source) => source.path.endsWith(path.join(".xiocode", "shared.md")))).toBe(true);
  });

  it("truncates oversized content under max_bytes", async () => {
    const root = await tempRoot("xio-agents-trunc-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const big = "X".repeat(4000);
    await writeFile(path.join(cwd, "AGENTS.md"), `${big}\n`, "utf8");

    const bundle = await loadAgentsMd({
      cwd,
      home,
      config: config({ maxBytes: 200 }),
    });
    expect(bundle.text.length).toBeLessThanOrEqual(250);
    expect(bundle.text).toContain("…[truncated]");
    expect(bundle.sources[0]?.truncated).toBe(true);
  });

  it("returns empty when enabled=false", async () => {
    const root = await tempRoot("xio-agents-disabled-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "SHOULD_NOT_LOAD\n", "utf8");

    const bundle = await loadAgentsMd({
      cwd,
      home,
      config: config({ enabled: false }),
    });
    expect(bundle.text).toBe("");
    expect(bundle.sources).toEqual([]);
  });
});

describe("registerXioHygiene", () => {
  it("injects agents_md before_agent_start and skips when disabled", async () => {
    const root = await tempRoot("xio-hygiene-ext-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "HYGIENE_RULE\n", "utf8");

    const host = new ExtensionHost();
    host.setSystemPrompt("base identity");
    registerXioHygiene(
      {
        on(event, handler) {
          host.on(event, handler);
        },
      },
      { cwd, home, agentsMd: config(), hooks: { enabled: false } },
    );

    await host.emit("session_start", {});
    const results = await host.emit("before_agent_start", { systemPrompt: "base identity" });
    const prompt = (results[0] as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
    expect(prompt).toContain("base identity");
    expect(prompt).toContain("HYGIENE_RULE");

    const disabled = new ExtensionHost();
    disabled.setSystemPrompt("base identity");
    registerXioHygiene(
      {
        on(event, handler) {
          disabled.on(event, handler);
        },
      },
      { cwd, home, agentsMd: config({ enabled: false }), hooks: { enabled: false } },
    );
    await disabled.emit("session_start", {});
    const disabledResults = await disabled.emit("before_agent_start", { systemPrompt: "base identity" });
    expect(disabledResults[0]).toBeUndefined();
  });

  it("composes with a later before_agent_start handler via progressive emit", async () => {
    const root = await tempRoot("xio-hygiene-compose-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "HYGIENE_RULE\n", "utf8");

    const host = new ExtensionHost();
    host.setSystemPrompt("base");
    registerXioHygiene(
      {
        on(event, handler) {
          host.on(event, handler);
        },
      },
      { cwd, home, agentsMd: config(), hooks: { enabled: false } },
    );
    host.on("before_agent_start", (_payload, ctx) => {
      const base = ctx?.getSystemPrompt?.() ?? "base";
      return { systemPrompt: `${base}\n\nTODO_ADDENDUM` };
    });

    await host.emit("session_start", {});
    const results = await host.emit("before_agent_start", { systemPrompt: "base" });
    const final = (results[results.length - 1] as { systemPrompt?: string })?.systemPrompt ?? "";
    expect(final).toContain("HYGIENE_RULE");
    expect(final).toContain("TODO_ADDENDUM");
    expect(final.indexOf("HYGIENE_RULE")).toBeLessThan(final.indexOf("TODO_ADDENDUM"));
  });
});
