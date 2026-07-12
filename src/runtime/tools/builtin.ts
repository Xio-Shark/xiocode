import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyPatch, parsePatch } from "diff";

import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";
import { verifyWriteBack } from "../verify/write-back.ts";

import type { ToolDefinition } from "../types.ts";

export type BuiltinToolsOptions = Readonly<{
  cwd?: string;
  /** When set, write/edit paths must stay inside this workspace root. */
  workspaceRoot?: string;
  writeBackVerify?: boolean;
  /**
   * Override ripgrep binary. `null` forces the Node walker fallback.
   * Omit to resolve `rg` once per process from PATH.
   */
  rgBinary?: string | null;
}>;

const NODE_BACKEND_NOTE = "backend=node (rg unavailable)";

let rgBinaryPromise: Promise<string | null> | undefined;

/** Resolve system `rg` once per process. Returns null when unavailable. */
export async function resolveRgBinary(): Promise<string | null> {
  if (!rgBinaryPromise) {
    rgBinaryPromise = probeRgBinary();
  }
  return rgBinaryPromise;
}

/** Test-only: clear the process-wide rg resolution cache. */
export function resetRgBinaryCacheForTests(): void {
  rgBinaryPromise = undefined;
}

async function probeRgBinary(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("rg", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? "rg" : null));
  });
}

async function resolveToolRgBinary(override: string | null | undefined): Promise<string | null> {
  if (override !== undefined) {
    return override;
  }
  return resolveRgBinary();
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): readonly ToolDefinition[] {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : path.resolve(cwd);
  const writeBackVerify = options.writeBackVerify !== false;
  const rgBinary = options.rgBinary;
  return [
    createReadTool(cwd),
    createWriteTool(cwd, workspaceRoot, writeBackVerify),
    createEditTool(cwd, workspaceRoot, writeBackVerify),
    createBashTool(cwd),
    createGrepTool(cwd, rgBinary),
    createGlobTool(cwd, rgBinary),
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
    description:
      "Edit a file by exact unique old_string→new_string replace (default), optional replace_all, " +
      "or optional unified patch. On not-found, one whitespace-normalized fuzzy retry may apply. " +
      "Result is verified by read-back.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit." }),
      old_string: Type.String({ description: "Exact text to find (required unless patch is set)." }),
      new_string: Type.String({ description: "Replacement text (required unless patch is set)." }),
      replace_all: Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness." }),
      patch: Type.String({ description: "Unified diff to apply to this file instead of old/new replace." }),
    }, { required: ["path"] }),
    async execute(_id, params) {
      const filePath = resolvePath(cwd, String(params.path));
      const containment = assertInsideWorkspace(filePath, workspaceRoot);
      if (containment) {
        return textResult(containment, true);
      }
      const content = await readFile(filePath, "utf8");
      const patchText = typeof params.patch === "string" ? params.patch : undefined;
      if (patchText !== undefined && patchText.length > 0) {
        const patched = applyUnifiedPatch(content, patchText);
        if (!patched.ok) {
          return textResult(patched.error, true);
        }
        return finishEdit(filePath, patched.next, writeBackVerify);
      }

      if (params.old_string === undefined || params.new_string === undefined) {
        return textResult("edit failed: old_string and new_string are required unless patch is set", true);
      }
      const oldString = String(params.old_string);
      const newString = String(params.new_string);
      const replaceAll = params.replace_all === true;
      const replaced = replaceInFileContent(filePath, content, oldString, newString, replaceAll);
      if (!replaced.ok) {
        return textResult(replaced.error, true);
      }
      return finishEdit(filePath, replaced.next, writeBackVerify, replaced.fuzzy);
    },
  });
}

async function finishEdit(
  filePath: string,
  next: string,
  writeBackVerify: boolean,
  fuzzy = false,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  await writeFile(filePath, next, "utf8");
  const fuzzyNote = fuzzy ? "; fuzzy: whitespace normalized" : "";
  if (!writeBackVerify) {
    return textResult(`edited ${filePath}${fuzzyNote}`);
  }
  const verified = await verifyWriteBack(filePath, next);
  if (!verified.ok) {
    return textResult(verified.message, true);
  }
  return textResult(`edited ${filePath}${fuzzyNote}; ${verified.message}`);
}

type EditReplaceResult =
  | { ok: true; next: string; fuzzy: boolean }
  | { ok: false; error: string };

function replaceInFileContent(
  filePath: string,
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditReplaceResult {
  const exactCount = countOccurrences(content, oldString);
  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      return {
        ok: false,
        error: `edit failed: old_string matched ${exactCount} times in ${filePath}; must be unique`,
      };
    }
    return {
      ok: true,
      next: replaceOccurrences(content, oldString, newString, replaceAll || exactCount === 1),
      fuzzy: false,
    };
  }

  // One internal fuzzy retry: CRLF→LF and trim trailing whitespace per line.
  const normContent = normalizeEditWhitespace(content);
  const normOld = normalizeEditWhitespace(oldString);
  const normNew = normalizeEditWhitespace(newString);
  const fuzzyCount = countOccurrences(normContent, normOld);
  if (fuzzyCount === 0) {
    return { ok: false, error: `edit failed: old_string not found in ${filePath}` };
  }
  if (fuzzyCount > 1 && !replaceAll) {
    return {
      ok: false,
      error: `edit failed: old_string matched ${fuzzyCount} times in ${filePath}; must be unique`,
    };
  }
  return {
    ok: true,
    next: replaceOccurrences(normContent, normOld, normNew, replaceAll || fuzzyCount === 1),
    fuzzy: true,
  };
}

function normalizeEditWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function replaceOccurrences(
  haystack: string,
  needle: string,
  replacement: string,
  all: boolean,
): string {
  if (!all) {
    return haystack.replace(needle, replacement);
  }
  return haystack.split(needle).join(replacement);
}

type PatchApplyResult =
  | { ok: true; next: string }
  | { ok: false; error: string };

function applyUnifiedPatch(content: string, patchText: string): PatchApplyResult {
  let parsed;
  try {
    parsed = parsePatch(patchText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `edit failed: patch parse error: ${message}` };
  }
  const hasHunks = parsed.some((entry) => (entry.hunks?.length ?? 0) > 0);
  if (!hasHunks) {
    return { ok: false, error: "edit failed: patch parse error: no hunks found" };
  }
  const result = applyPatch(content, patchText);
  if (result === false) {
    return { ok: false, error: "edit failed: patch apply error: hunks did not match file content" };
  }
  return { ok: true, next: result };
}

function createBashTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "bash",
    description: "Run a shell command in the workspace.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
    }),
    async execute(_id, params, ctx) {
      const command = String(params.command ?? "");
      const result = await runCommand(command, cwd, ctx?.signal);
      return textResult(`exit_code=${result.exitCode}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`, result.exitCode !== 0);
    },
  });
}

function createGrepTool(cwd: string, rgBinaryOverride?: string | null): ToolDefinition {
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
      const rgBinary = await resolveToolRgBinary(rgBinaryOverride);
      if (rgBinary) {
        const rgResult = await grepWithRg(rgBinary, cwd, pattern, searchRoot, globFilter);
        if (rgResult.kind === "ok") {
          return textResult(rgResult.text);
        }
        if (rgResult.kind === "error") {
          return textResult(rgResult.text, true);
        }
        // spawn failure → Node fallback
      }
      const nodeText = await grepWithNode(cwd, pattern, searchRoot, globFilter);
      return textResult(`${NODE_BACKEND_NOTE}\n${nodeText}`);
    },
  });
}

function createGlobTool(cwd: string, rgBinaryOverride?: string | null): ToolDefinition {
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
      const rgBinary = await resolveToolRgBinary(rgBinaryOverride);
      if (rgBinary) {
        const rgResult = await globWithRg(rgBinary, cwd, pattern, root);
        if (rgResult.kind === "ok") {
          return textResult(rgResult.text);
        }
        if (rgResult.kind === "error") {
          return textResult(rgResult.text, true);
        }
        // spawn failure → Node fallback
      }
      const nodeText = await globWithNode(cwd, pattern, root);
      return textResult(`${NODE_BACKEND_NOTE}\n${nodeText}`);
    },
  });
}

type RgToolResult =
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string }
  | { kind: "fallback" };

async function grepWithRg(
  rgBinary: string,
  cwd: string,
  pattern: string,
  searchRoot: string,
  globFilter: string | undefined,
): Promise<RgToolResult> {
  const args = ["-n", "--no-heading", "--color=never"];
  if (globFilter) {
    args.push("-g", globFilter);
  }
  args.push("--", pattern, searchRoot);
  const result = await runArgv(rgBinary, args, cwd);
  if (result.spawnError) {
    return { kind: "fallback" };
  }
  if (result.exitCode >= 2) {
    return { kind: "error", text: formatRgError(result.exitCode, result.stderr) };
  }
  if (result.exitCode === 1 || result.stdout.trim().length === 0) {
    return { kind: "ok", text: "no matches" };
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 100)
    .map((line) => relativizeRgMatchLine(line, cwd));
  return { kind: "ok", text: lines.length > 0 ? lines.join("\n") : "no matches" };
}

async function grepWithNode(
  cwd: string,
  pattern: string,
  searchRoot: string,
  globFilter: string | undefined,
): Promise<string> {
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
        return matches.join("\n");
      }
    }
  }
  return matches.length > 0 ? matches.join("\n") : "no matches";
}

async function globWithRg(
  rgBinary: string,
  cwd: string,
  pattern: string,
  root: string,
): Promise<RgToolResult> {
  const args = ["--files", "-g", pattern, "--", root];
  const result = await runArgv(rgBinary, args, cwd);
  if (result.spawnError) {
    return { kind: "fallback" };
  }
  if (result.exitCode >= 2) {
    return { kind: "error", text: formatRgError(result.exitCode, result.stderr) };
  }
  if (result.exitCode === 1 || result.stdout.trim().length === 0) {
    return { kind: "ok", text: "no files" };
  }
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 500)
    .map((file) => toCwdRelative(file, cwd));
  return { kind: "ok", text: files.length > 0 ? files.join("\n") : "no files" };
}

async function globWithNode(cwd: string, pattern: string, root: string): Promise<string> {
  const files: string[] = [];
  for await (const file of walkFiles(root, pattern)) {
    files.push(path.relative(cwd, file));
    if (files.length >= 500) {
      break;
    }
  }
  return files.length > 0 ? files.join("\n") : "no files";
}

function formatRgError(exitCode: number, stderr: string): string {
  const snippet = stderr.trim().slice(0, 400);
  return snippet.length > 0
    ? `rg failed (exit ${exitCode}): ${snippet}`
    : `rg failed (exit ${exitCode})`;
}

function toCwdRelative(file: string, cwd: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  return path.relative(cwd, absolute);
}

function relativizeRgMatchLine(line: string, cwd: string): string {
  const match = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!match) {
    return line;
  }
  const file = match[1] ?? "";
  const lineNo = match[2] ?? "";
  const content = match[3] ?? "";
  return `${toCwdRelative(file, cwd)}:${lineNo}:${content}`;
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

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnError?: boolean;
};

async function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) {
    return { exitCode: 1, stdout: "", stderr: "bash cancelled: AbortSignal aborted before start" };
  }
  return runArgv("/bin/sh", ["-c", command], cwd, signal, {
    abortedMessage: "bash cancelled: AbortSignal aborted",
  });
}

async function runArgv(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  options?: Readonly<{ abortedMessage?: string }>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      // Escalate if the child ignores SIGTERM.
      const escalate = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      escalate.unref?.();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr: stderr.length > 0 ? stderr : (options?.abortedMessage ?? "cancelled: AbortSignal aborted"),
        });
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: 1, stdout, stderr: error.message, spawnError: true });
    });
    if (signal?.aborted) {
      onAbort();
    }
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
