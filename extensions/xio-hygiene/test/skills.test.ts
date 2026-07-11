import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSkillTool,
  discoverSkills,
  formatSkillsCatalog,
  type SkillsConfig,
} from "../src/skills.ts";
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

function config(partial: Partial<SkillsConfig> = {}): SkillsConfig {
  return {
    enabled: true,
    readClaude: true,
    readCursor: true,
    maxBodyBytes: 32_768,
    ...partial,
  };
}

async function writeSkill(
  root: string,
  relativeDir: string,
  options: { name?: string; description?: string; body?: string; raw?: string },
): Promise<string> {
  const dir = path.join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  if (options.raw !== undefined) {
    await writeFile(filePath, options.raw, "utf8");
    return filePath;
  }
  const name = options.name ?? path.basename(relativeDir);
  const description = options.description ?? `${name} description`;
  const body = options.body ?? `${name} BODY_SECRET_FULL_TEXT`;
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
  return filePath;
}

describe("discoverSkills", () => {
  it("discovers skills from .claude/skills and .cursor/skills", async () => {
    const root = await tempRoot("xio-skills-discover-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "claude-skill"), {
      name: "claude-skill",
      description: "from claude",
      body: "CLAUDE_FULL_BODY",
    });
    await writeSkill(cwd, path.join(".cursor", "skills", "cursor-skill"), {
      name: "cursor-skill",
      description: "from cursor",
      body: "CURSOR_FULL_BODY",
    });

    const index = await discoverSkills({ cwd, home, config: config() });
    const names = index.skills.map((skill) => skill.name).sort();
    expect(names).toEqual(["claude-skill", "cursor-skill"]);
    expect(index.skills.find((s) => s.name === "claude-skill")?.source).toBe("project-claude");
    expect(index.skills.find((s) => s.name === "cursor-skill")?.source).toBe("project-cursor");
  });

  it("prefers project .claude over .cursor and user skills for same name", async () => {
    const root = await tempRoot("xio-skills-priority-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(path.join(home, ".claude"), path.join("skills", "shared"), {
      name: "shared",
      description: "user",
      body: "USER",
    });
    await writeSkill(cwd, path.join(".cursor", "skills", "shared"), {
      name: "shared",
      description: "cursor",
      body: "CURSOR",
    });
    await writeSkill(cwd, path.join(".claude", "skills", "shared"), {
      name: "shared",
      description: "claude",
      body: "CLAUDE",
    });

    const index = await discoverSkills({ cwd, home, config: config() });
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]?.source).toBe("project-claude");
    expect(index.skills[0]?.body).toContain("CLAUDE");
  });

  it("skips claude or cursor roots when flags are false", async () => {
    const root = await tempRoot("xio-skills-flags-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "a"), { name: "a", body: "A" });
    await writeSkill(cwd, path.join(".cursor", "skills", "b"), { name: "b", body: "B" });

    const noClaude = await discoverSkills({
      cwd,
      home,
      config: config({ readClaude: false }),
    });
    expect(noClaude.skills.map((s) => s.name)).toEqual(["b"]);

    const noCursor = await discoverSkills({
      cwd,
      home,
      config: config({ readCursor: false }),
    });
    expect(noCursor.skills.map((s) => s.name)).toEqual(["a"]);
  });

  it("skips corrupt SKILL.md without failing", async () => {
    const root = await tempRoot("xio-skills-bad-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "good"), {
      name: "good",
      body: "GOOD",
    });
    await writeSkill(cwd, path.join(".claude", "skills", "bad"), {
      raw: "not frontmatter at all\n",
    });

    const warnings: string[] = [];
    const index = await discoverSkills({
      cwd,
      home,
      config: config(),
      warn: (message) => warnings.push(message),
    });
    expect(index.skills.map((s) => s.name)).toEqual(["good"]);
    expect(warnings.some((message) => message.includes("frontmatter"))).toBe(true);
  });

  it("truncates oversized skill bodies", async () => {
    const root = await tempRoot("xio-skills-trunc-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "big"), {
      name: "big",
      body: "Y".repeat(5000),
    });

    const index = await discoverSkills({
      cwd,
      home,
      config: config({ maxBodyBytes: 100 }),
    });
    expect(index.skills[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(index.skills[0]?.body ?? "", "utf8")).toBeLessThanOrEqual(130);
    expect(index.skills[0]?.body).toContain("…[truncated]");
  });

  it("returns empty when enabled=false", async () => {
    const root = await tempRoot("xio-skills-off-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "x"), { name: "x", body: "X" });

    const index = await discoverSkills({
      cwd,
      home,
      config: config({ enabled: false }),
    });
    expect(index.skills).toEqual([]);
  });
});

describe("skill tool", () => {
  it("lists and loads skills by name", async () => {
    const root = await tempRoot("xio-skills-tool-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "demo"), {
      name: "demo",
      description: "demo skill",
      body: "DEMO_FULL_BODY",
    });

    const index = await discoverSkills({ cwd, home, config: config() });
    const tool = createSkillTool(() => index);

    const listed = await tool.execute("1", { action: "list" });
    const listText = listed.content[0]?.text ?? "";
    expect(listText).toContain("demo");
    expect(listText).toContain("demo skill");
    expect(listText).not.toContain("DEMO_FULL_BODY");

    const loaded = await tool.execute("2", { action: "load", name: "demo" });
    const loadText = loaded.content[0]?.text ?? "";
    expect(loadText).toContain("DEMO_FULL_BODY");
    expect(loadText).toContain('"hash"');
  });
});

describe("formatSkillsCatalog", () => {
  it("includes name and description but not full body", async () => {
    const root = await tempRoot("xio-skills-catalog-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "demo"), {
      name: "demo",
      description: "short desc",
      body: "FULL_BODY_MUST_NOT_APPEAR_IN_PROMPT",
    });
    const index = await discoverSkills({ cwd, home, config: config() });
    const catalog = formatSkillsCatalog(index);
    expect(catalog).toContain("demo");
    expect(catalog).toContain("short desc");
    expect(catalog).not.toContain("FULL_BODY_MUST_NOT_APPEAR_IN_PROMPT");
  });
});

describe("registerXioHygiene skills", () => {
  it("injects short catalog, registers skill tool, and skips when disabled", async () => {
    const root = await tempRoot("xio-skills-ext-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSkill(cwd, path.join(".claude", "skills", "demo"), {
      name: "demo",
      description: "short desc",
      body: "FULL_BODY_MUST_NOT_APPEAR_IN_PROMPT",
    });

    const host = new ExtensionHost();
    host.setSystemPrompt("base identity");
    registerXioHygiene(
      {
        on(event, handler) {
          host.on(event, handler);
        },
      },
      {
        cwd,
        home,
        skills: config(),
        hooks: { enabled: false },
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    expect(host.getAllTools().some((tool) => tool.name === "skill")).toBe(true);

    await host.emit("session_start", {});
    const results = await host.emit("before_agent_start", { systemPrompt: "base identity" });
    const prompt = (results[0] as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
    expect(prompt).toContain("base identity");
    expect(prompt).toContain("[skills]");
    expect(prompt).toContain("demo");
    expect(prompt).toContain("short desc");
    expect(prompt).not.toContain("FULL_BODY_MUST_NOT_APPEAR_IN_PROMPT");

    const skill = host.getTool("skill");
    expect(skill).toBeDefined();
    const loaded = await skill!.execute("t", { action: "load", name: "demo" });
    expect(loaded.content[0]?.text).toContain("FULL_BODY_MUST_NOT_APPEAR_IN_PROMPT");

    const disabled = new ExtensionHost();
    disabled.setSystemPrompt("base identity");
    registerXioHygiene(
      {
        on(event, handler) {
          disabled.on(event, handler);
        },
      },
      {
        cwd,
        home,
        skills: config({ enabled: false }),
        hooks: { enabled: false },
        registerTool: (tool) => disabled.registerTool(tool),
      },
    );
    expect(disabled.getAllTools().some((tool) => tool.name === "skill")).toBe(false);
    await disabled.emit("session_start", {});
    const disabledResults = await disabled.emit("before_agent_start", { systemPrompt: "base identity" });
    // agents_md still default-enabled but no files → undefined; skills disabled → no catalog
    expect(disabledResults[0]).toBeUndefined();
  });
});
