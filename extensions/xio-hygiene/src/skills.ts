import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { defineTool } from "../../../src/runtime/define-tool.ts";
import { Type } from "../../../src/runtime/schema.ts";

import type { ToolDefinition } from "../../../src/runtime/types.ts";

export type SkillsConfig = Readonly<{
  enabled: boolean;
  readClaude: boolean;
  readCursor: boolean;
  maxBodyBytes: number;
}>;

export type SkillSourceKind = "user-claude" | "project-cursor" | "project-claude";

export type SkillEntry = Readonly<{
  name: string;
  description: string;
  path: string;
  body: string;
  hash: string;
  truncated: boolean;
  source: SkillSourceKind;
  bytes: number;
}>;

export type SkillsIndex = Readonly<{
  skills: readonly SkillEntry[];
  warnings: readonly string[];
}>;

export type DiscoverSkillsOptions = Readonly<{
  cwd: string;
  home?: string;
  config: SkillsConfig;
  /** When false, skip project `.claude`/`.cursor` skills (user global still loads). */
  includeProject?: boolean;
  warn?: (message: string) => void;
}>;

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  enabled: true,
  readClaude: true,
  readCursor: true,
  maxBodyBytes: 32_768,
};

const SOURCE_PRIORITY: Readonly<Record<SkillSourceKind, number>> = {
  "user-claude": 10,
  "project-cursor": 20,
  "project-claude": 30,
};

/**
 * Discover SKILL.md using Claude Code layout (+ optional Cursor).
 * Same-name resolution: project .claude > project .cursor > ~/.claude/skills.
 * No ~/.xiocode/skills — agent extensions live in Claude paths only.
 */
export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillsIndex> {
  const config = options.config;
  if (!config.enabled) {
    return { skills: [], warnings: [] };
  }

  const home = options.home ?? homedir();
  const cwd = path.resolve(options.cwd);
  const warn = options.warn ?? (() => undefined);
  const warnings: string[] = [];
  const byName = new Map<string, SkillEntry>();

  const roots = listSkillRoots(cwd, home, config, options.includeProject !== false);
  // Parallelize independent skill roots (user/project trees do not depend on each other).
  const rootBatches = await Promise.all(roots.map(async (root) => {
    const localWarnings: string[] = [];
    const files = await listSkillFiles(root.dir, (message) => {
      localWarnings.push(message);
      warn(message);
    });
    const parsedEntries = await Promise.all(files.map((filePath) =>
      parseSkillFile(filePath, root.kind, config.maxBodyBytes, (message) => {
        localWarnings.push(message);
        warn(message);
      })));
    return { parsedEntries, localWarnings };
  }));

  for (const batch of rootBatches) {
    warnings.push(...batch.localWarnings);
    for (const parsed of batch.parsedEntries) {
      if (!parsed) {
        continue;
      }
      const existing = byName.get(parsed.name);
      if (!existing || SOURCE_PRIORITY[parsed.source] >= SOURCE_PRIORITY[existing.source]) {
        byName.set(parsed.name, parsed);
      }
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}

function listSkillRoots(
  cwd: string,
  home: string,
  config: SkillsConfig,
  includeProject: boolean,
): readonly { dir: string; kind: SkillSourceKind }[] {
  const roots: { dir: string; kind: SkillSourceKind }[] = [];
  // Lower priority first so later overwrites win when priorities tie on first-seen.
  if (config.readClaude) {
    roots.push({ dir: path.join(home, ".claude", "skills"), kind: "user-claude" });
  }
  if (includeProject && config.readCursor) {
    roots.push({ dir: path.join(cwd, ".cursor", "skills"), kind: "project-cursor" });
  }
  if (includeProject && config.readClaude) {
    roots.push({ dir: path.join(cwd, ".claude", "skills"), kind: "project-claude" });
  }
  return roots;
}

async function listSkillFiles(
  root: string,
  warn: (message: string) => void,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true, encoding: "utf8" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return [];
    }
    warn(`skills: failed to scan ${root}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  return entries
    .filter((entry) => path.basename(entry) === "SKILL.md")
    .map((entry) => path.join(root, entry));
}

async function parseSkillFile(
  filePath: string,
  source: SkillSourceKind,
  maxBodyBytes: number,
  warn: (message: string) => void,
): Promise<SkillEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    warn(`skills: failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    warn(`skills: missing or invalid frontmatter in ${filePath}; skipping`);
    return undefined;
  }

  const dirName = path.basename(path.dirname(filePath));
  const name = (parsed.fields.name ?? dirName).trim();
  if (!name) {
    warn(`skills: empty name in ${filePath}; skipping`);
    return undefined;
  }

  const description = (parsed.fields.description ?? "").trim();
  const hash = shortHash(raw);
  const truncatedBody = truncateUtf8(parsed.body, maxBodyBytes);

  return {
    name,
    description,
    path: path.resolve(filePath),
    body: truncatedBody.text,
    hash,
    truncated: truncatedBody.truncated,
    source,
    bytes: Buffer.byteLength(truncatedBody.text, "utf8"),
  };
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code unit. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: `${buf.subarray(0, end).toString("utf8")}\n\n…[truncated]`,
    truncated: true,
  };
}

type FrontmatterParse = Readonly<{
  fields: Readonly<Record<string, string>>;
  body: string;
}>;

function parseFrontmatter(raw: string): FrontmatterParse | undefined {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return undefined;
  }
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) {
    return undefined;
  }
  const fmBlock = normalized.slice(3, end).replace(/^\r?\n/, "");
  const body = normalized.slice(end + 4).replace(/^\r?\n/, "");
  const fields: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body };
}

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Short catalog for system prompt — name + description only, never full bodies. */
export function formatSkillsCatalog(index: SkillsIndex): string {
  if (index.skills.length === 0) {
    return "";
  }
  const lines = [
    "### [skills] available skills (use the `skill` tool to load full body)",
    ...index.skills.map((skill) => {
      const desc = skill.description.length > 0 ? skill.description : "(no description)";
      return `- ${skill.name}: ${desc}`;
    }),
  ];
  return lines.join("\n");
}

export function createSkillTool(getIndex: () => SkillsIndex | undefined): ToolDefinition {
  return defineTool({
    name: "skill",
    description:
      "List discovered local skills or load one by name. System prompt only has a short catalog; call this tool for full skill body.",
    parameters: Type.Object(
      {
        action: Type.String({ description: 'Action: "list" or "load".' }),
        name: Type.String({ description: "Skill name when action is load." }),
      },
      { required: ["action"] },
    ),
    async execute(_id, params) {
      const index = getIndex() ?? { skills: [], warnings: [] };
      const action = String(params.action ?? "").trim().toLowerCase();
      if (action === "list") {
        const catalog = index.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          source: skill.source,
          hash: skill.hash,
          truncated: skill.truncated,
        }));
        return textResult(JSON.stringify({ skills: catalog }, null, 2));
      }
      if (action === "load") {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!name) {
          return textResult('skill load requires "name"', true);
        }
        const skill = index.skills.find((entry) => entry.name === name);
        if (!skill) {
          return textResult(`skill not found: ${name}`, true);
        }
        const payload = {
          name: skill.name,
          description: skill.description,
          path: skill.path,
          source: skill.source,
          hash: skill.hash,
          truncated: skill.truncated,
          body: skill.body,
        };
        return textResult(JSON.stringify(payload, null, 2));
      }
      return textResult(`unknown skill action: ${action}; use "list" or "load"`, true);
    },
  });
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: { text },
    isError,
  };
}
