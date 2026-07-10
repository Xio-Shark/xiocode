import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";
import { verifyWriteBack } from "../verify/write-back.ts";

import type { ToolDefinition } from "../types.ts";

export type BuiltinToolsOptions = Readonly<{
  cwd?: string;
  /** When set, write/edit paths must stay inside this workspace root. */
  workspaceRoot?: string;
  writeBackVerify?: boolean;
}>;

export function createBuiltinTools(options: BuiltinToolsOptions = {}): readonly ToolDefinition[] {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : path.resolve(cwd);
  const writeBackVerify = options.writeBackVerify !== false;
  return [
    createReadTool(cwd),
    createWriteTool(cwd, workspaceRoot, writeBackVerify),
    createEditTool(cwd, workspaceRoot, writeBackVerify),
    createBashTool(cwd),
    createGrepTool(cwd),
    createGlobTool(cwd),
  ];
}

function createReadTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "read",
    description: "Read a file. Optionally limit to a line range with offset and limit.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to workspace or absolute." }),
      offset: Type.Number({ description: "1-based start line (optional)." }),
      limit: Type.Number({ description: "Max number of lines to return (optional)." }),
    }, { required: ["path"] }),
    async execute(_id, params) {
      const filePath = resolvePath(cwd, String(params.path));
      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n");
      const offset = typeof params.offset === "number" && params.offset > 0 ? Math.floor(params.offset) : 1;
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : lines.length;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, index) => `${offset + index}|${line}`).join("\n");
      return textResult(numbered);
    },
  });
}

function createWriteTool(cwd: string, workspaceRoot: string, writeBackVerify: boolean): ToolDefinition {
  return defineTool({
    name: "write",
    description: "Write content to a file, creating parent directories as needed. Content is verified by read-back.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write." }),
      content: Type.String({ description: "Full file content." }),
    }),
    async execute(_id, params) {
      const filePath = resolvePath(cwd, String(params.path));
      const containment = assertInsideWorkspace(filePath, workspaceRoot);
      if (containment) {
        return textResult(containment, true);
      }
      const content = String(params.content ?? "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      if (!writeBackVerify) {
        return textResult(`wrote ${filePath}`);
      }
      const verified = await verifyWriteBack(filePath, content);
      return textResult(verified.ok ? `wrote ${filePath}; ${verified.message}` : verified.message, !verified.ok);
    },
  });
}

function createEditTool(cwd: string, workspaceRoot: string, writeBackVerify: boolean): ToolDefinition {
  return defineTool({
    name: "edit",
    description: "Replace an exact old_string with new_string in a file. Result is verified by read-back.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit." }),
      old_string: Type.String({ description: "Exact text to find." }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    async execute(_id, params) {
      const filePath = resolvePath(cwd, String(params.path));
      const containment = assertInsideWorkspace(filePath, workspaceRoot);
      if (containment) {
        return textResult(containment, true);
      }
      const oldString = String(params.old_string ?? "");
      const newString = String(params.new_string ?? "");
      const content = await readFile(filePath, "utf8");
      const count = content.split(oldString).length - 1;
      if (count === 0) {
        return textResult(`edit failed: old_string not found in ${filePath}`, true);
      }
      if (count > 1) {
        return textResult(`edit failed: old_string matched ${count} times in ${filePath}; must be unique`, true);
      }
      const next = content.replace(oldString, newString);
      await writeFile(filePath, next, "utf8");
      if (!writeBackVerify) {
        return textResult(`edited ${filePath}`);
      }
      const verified = await verifyWriteBack(filePath, next);
      return textResult(verified.ok ? `edited ${filePath}; ${verified.message}` : verified.message, !verified.ok);
    },
  });
}

function createBashTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "bash",
    description: "Run a shell command in the workspace.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
    }),
    async execute(_id, params) {
      const command = String(params.command ?? "");
      const result = await runCommand(command, cwd);
      return textResult(`exit_code=${result.exitCode}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`, result.exitCode !== 0);
    },
  });
}

function createGrepTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "grep",
    description: "Search file contents with a regular expression.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression pattern." }),
      path: Type.String({ description: "File or directory to search (optional)." }),
      glob: Type.String({ description: "Glob filter (optional)." }),
    }, { required: ["pattern"] }),
    async execute(_id, params) {
      const pattern = String(params.pattern ?? "");
      const searchRoot = params.path ? resolvePath(cwd, String(params.path)) : cwd;
      const globFilter = typeof params.glob === "string" ? params.glob : undefined;
      const regex = new RegExp(pattern);
      const matches: string[] = [];
      for await (const file of walkFiles(searchRoot, globFilter)) {
        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          if (!regex.test(line)) {
            continue;
          }
          matches.push(`${path.relative(cwd, file)}:${i + 1}:${line}`);
          if (matches.length >= 100) {
            return textResult(matches.join("\n"));
          }
        }
      }
      return textResult(matches.length > 0 ? matches.join("\n") : "no matches");
    },
  });
}

function createGlobTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts" }),
      path: Type.String({ description: "Root directory (optional)." }),
    }, { required: ["pattern"] }),
    async execute(_id, params) {
      const pattern = String(params.pattern ?? "");
      const root = params.path ? resolvePath(cwd, String(params.path)) : cwd;
      const files: string[] = [];
      for await (const file of walkFiles(root, pattern)) {
        files.push(path.relative(cwd, file));
        if (files.length >= 500) {
          break;
        }
      }
      return textResult(files.length > 0 ? files.join("\n") : "no files");
    },
  });
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

function resolvePath(cwd: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

function assertInsideWorkspace(filePath: string, workspaceRoot: string): string | undefined {
  const resolved = path.resolve(filePath);
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `path escapes workspace root: ${resolved} (root=${root})`;
  }
  return undefined;
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
  });
}

async function* walkFiles(root: string, globFilter?: string): AsyncGenerator<string> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return;
  }
  if (rootStat.isFile()) {
    if (!globFilter || matchGlob(path.basename(root), globFilter)) {
      yield root;
    }
    return;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = path.relative(root, full);
      if (!globFilter || matchGlob(relative, globFilter) || matchGlob(entry.name, globFilter)) {
        yield full;
      }
    }
  }
}

function matchGlob(value: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/");
  const target = value.replace(/\\/g, "/");
  if (normalized === "**/*" || normalized === "*") {
    return true;
  }
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
