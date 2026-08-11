import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

import { applyPatch, parsePatch } from "diff";

import { defineTool } from "../define-tool.ts";
import { FileReadSet } from "../file-read-set.ts";
import { FileShiftRegistry, type FileShiftInfo } from "../file-shift.ts";
import { FileWriteQueue } from "../file-write-queue.ts";
import { WorkspacePathPolicy, type CheckedWorkspacePath } from "../workspace-path-policy.ts";
import { GrepSeenState, annotateGrepOutput } from "./grep-outline.ts";
import { Type } from "../schema.ts";
import { hashContent } from "../verify/write-back.ts";
import { withFixHint } from "./error-guidance.ts";
import {
  matchGlob,
  nodeBackendNote,
  resolveGlobEngine,
  resolveGrepEngine,
  runGlobWithEngine,
  runGrepWithEngine,
} from "./search-backend.ts";

import type { ToolDefinition } from "../types.ts";

export type BuiltinToolsOptions = Readonly<{
  cwd?: string;
  /** When set, write/edit paths must stay inside this workspace root. */
  workspaceRoot?: string;
  /** Shared session path capability policy. A lazy policy is created when omitted. */
  pathPolicy?: WorkspacePathPolicy;
  writeBackVerify?: boolean;
  /**
   * Override search backend for tests:
   * - `null` / `"node"` → Node walker
   * - `"ugrep"` | `"rg"` | `"grep"` → force that engine if present
   * - absolute path → treat as rg-compatible binary (legacy)
   * - omit → auto: ugrep → rg → grep → node (grep); ugrep → rg → bfs → find → node (glob)
   */
  searchEngine?: string | null;
  /**
   * @deprecated Use `searchEngine`. Kept for tests: `null` forces Node; path forces rg-compatible binary.
   */
  rgBinary?: string | null;
  /**
   * Shared write/edit queue (realpath-keyed). When omitted, a fresh queue is created
   * for this tool set so same-path mutations still serialize within the set.
   */
  writeQueue?: FileWriteQueue;
  /**
   * Session/run read tracker. When omitted, a fresh set is created for this tool set.
   * Clear on new user turn (session `beforePrompt`); keep across abort within a run.
   */
  readSet?: FileReadSet;
  /**
   * Require a successful `read` (or prior successful write/edit) before edit or
   * overwrite-write. Default true. Set false to rollback ([tools] require_read_before_edit).
   */
  requireReadBeforeEdit?: boolean;
  /**
   * Session grep outline memory (structure-aware grep). When omitted, a fresh state is
   * created for this tool set. Cleared on new user turn alongside `readSet`.
   */
  grepSeen?: GrepSeenState;
  /** Disable the grep structure outline (default enabled). */
  grepOutline?: boolean;
  /**
   * Cross-context file-shift registry (shared across main + explore workers). When a write
   * lands on a path another context read, `onFileShift` fires. Omit to disable detection.
   */
  fileShift?: FileShiftRegistry;
  /** Logical context id for this tool set (main agent vs an explore worker). Default "main". */
  contextId?: string;
  /** Called once when a write shifts a file another context had read. */
  onFileShift?: (info: FileShiftInfo) => void;
}>;

export {
  resolveRgBinary,
  resolveGrepEngine,
  resolveGlobEngine,
  resetRgBinaryCacheForTests,
  resetSearchBackendCacheForTests,
  formatRecommendedCliToolsNotice,
  probeRecommendedTools,
  RECOMMENDED_CLI_TOOLS,
} from "./search-backend.ts";

export function createBuiltinTools(options: BuiltinToolsOptions = {}): readonly ToolDefinition[] {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : path.resolve(cwd);
  const writeBackVerify = options.writeBackVerify !== false;
  const searchOverride = options.searchEngine !== undefined ? options.searchEngine : options.rgBinary;
  const writeQueue = options.writeQueue ?? new FileWriteQueue();
  const readSet = options.readSet ?? new FileReadSet();
  const requireReadBeforeEdit = options.requireReadBeforeEdit !== false;
  const grepSeen = options.grepSeen ?? new GrepSeenState();
  const grepOutline = options.grepOutline !== false;
  const fileShift = options.fileShift;
  const contextId = options.contextId ?? "main";
  const onFileShift = options.onFileShift;
  const pathPolicy = options.pathPolicy
    ? Promise.resolve(options.pathPolicy)
    : WorkspacePathPolicy.create({ workspaceRoot, cwd });
  return [
    createReadTool(cwd, pathPolicy, readSet, fileShift, contextId),
    createWriteTool(cwd, pathPolicy, writeBackVerify, writeQueue, readSet, requireReadBeforeEdit, fileShift, contextId, onFileShift),
    createEditTool(cwd, pathPolicy, writeBackVerify, writeQueue, readSet, requireReadBeforeEdit, fileShift, contextId, onFileShift),
    createBashTool(cwd),
    createGrepTool(cwd, pathPolicy, searchOverride, grepOutline ? grepSeen : undefined),
    createGlobTool(cwd, pathPolicy, searchOverride),
  ];
}

function createReadTool(
  cwd: string,
  pathPolicy: Promise<WorkspacePathPolicy>,
  readSet: FileReadSet,
  fileShift?: FileShiftRegistry,
  contextId = "main",
): ToolDefinition {
  return defineTool({
    name: "read",
    description: "Read a file. Optionally limit to a line range with offset and limit.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to workspace or absolute." }),
      offset: Type.Number({ description: "1-based start line (optional)." }),
      limit: Type.Number({ description: "Max number of lines to return (optional)." }),
    }, { required: ["path"] }),
    async execute(id, params) {
      const requestedPath = String(params.path);
      const filePath = resolvePath(cwd, requestedPath);
      try {
        const content = (await (await pathPolicy).readFile(requestedPath, id)).toString("utf8");
        const lines = content.split("\n");
        const offset = typeof params.offset === "number" && params.offset > 0 ? Math.floor(params.offset) : 1;
        const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : lines.length;
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((line, index) => `${offset + index}|${line}`).join("\n");
        await readSet.mark(filePath);
        await fileShift?.markRead(contextId, filePath);
        return textResult(numbered);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("read", message);
      }
    },
  });
}

/** Emit a file-shift notification once when a write lands on a path another context read. */
async function noteFileShift(
  fileShift: FileShiftRegistry | undefined,
  contextId: string,
  onFileShift: ((info: FileShiftInfo) => void) | undefined,
  filePath: string,
): Promise<void> {
  if (!fileShift) return;
  const readers = await fileShift.noteWrite(contextId, filePath);
  if (readers.length > 0) {
    onFileShift?.({ path: filePath, writer: contextId, readers });
  }
}

function createWriteTool(
  cwd: string,
  pathPolicy: Promise<WorkspacePathPolicy>,
  writeBackVerify: boolean,
  writeQueue: FileWriteQueue,
  readSet: FileReadSet,
  requireReadBeforeEdit: boolean,
  fileShift?: FileShiftRegistry,
  contextId = "main",
  onFileShift?: (info: FileShiftInfo) => void,
): ToolDefinition {
  return defineTool({
    name: "write",
    description:
      "Write content to a file, creating parent directories as needed. Content is verified by read-back. "
      + "Overwriting an existing file requires a prior successful read (or write/edit) of that path.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write." }),
      content: Type.String({ description: "Full file content." }),
    }),
    async execute(id, params) {
      const requestedPath = String(params.path);
      const filePath = resolvePath(cwd, requestedPath);
      try {
        return await writeQueue.run(filePath, async () => {
          const policy = await pathPolicy;
          const checked = await policy.resolve("write-file", requestedPath, id);
          if (requireReadBeforeEdit && checked.kind === "regular-file") {
            if (!(await readSet.has(filePath))) {
              return errorResult(
                "write",
                `write blocked: path not read in this run before overwrite: ${filePath}`,
              );
            }
          }
          const content = String(params.content ?? "");
          await policy.writeFileAtomic(requestedPath, content);
          await readSet.mark(filePath);
          await noteFileShift(fileShift, contextId, onFileShift, filePath);
          if (!writeBackVerify) {
            return textResult(`wrote ${filePath}`);
          }
          return textResult(
            `wrote ${filePath}; write-back ok sha256=${hashContent(content).slice(0, 12)}`,
          );
        });
      } catch (error) {
        return errorResult("write", errorMessage(error));
      }
    },
  });
}

function createEditTool(
  cwd: string,
  pathPolicy: Promise<WorkspacePathPolicy>,
  writeBackVerify: boolean,
  writeQueue: FileWriteQueue,
  readSet: FileReadSet,
  requireReadBeforeEdit: boolean,
  fileShift?: FileShiftRegistry,
  contextId = "main",
  onFileShift?: (info: FileShiftInfo) => void,
): ToolDefinition {
  return defineTool({
    name: "edit",
    description:
      "Edit a file by exact unique old_string→new_string replace (default), optional replace_all, " +
      "or optional unified patch. On not-found, one whitespace-normalized fuzzy retry may apply. " +
      "Requires a prior successful read (or write/edit) of the path in this run. " +
      "Result is verified by read-back.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit." }),
      old_string: Type.String({ description: "Exact text to find (required unless patch is set)." }),
      new_string: Type.String({ description: "Replacement text (required unless patch is set)." }),
      replace_all: Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness." }),
      patch: Type.String({ description: "Unified diff to apply to this file instead of old/new replace." }),
    }, { required: ["path"] }),
    async execute(id, params) {
      const requestedPath = String(params.path);
      const filePath = resolvePath(cwd, requestedPath);
      try {
        const policy = await pathPolicy;
        await policy.resolve("edit-file", requestedPath, id);
        if (requireReadBeforeEdit && !(await readSet.has(filePath))) {
          return errorResult(
            "edit",
            `edit blocked: path not read in this run before edit: ${filePath}`,
          );
        }
        return await writeQueue.run(filePath, async () => {
          // Re-check after queue entry — another writer may have replaced the path.
          await policy.resolve("edit-file", requestedPath);
          if (requireReadBeforeEdit && !(await readSet.has(filePath))) {
            return errorResult(
              "edit",
              `edit blocked: path not read in this run before edit: ${filePath}`,
            );
          }
          const content = (await policy.readFile(requestedPath)).toString("utf8");
          const patchText = typeof params.patch === "string" ? params.patch : undefined;
          if (patchText !== undefined && patchText.length > 0) {
            const patched = applyUnifiedPatch(content, patchText);
            if (!patched.ok) {
              return errorResult("edit", patched.error);
            }
            return finishEdit(
              policy,
              requestedPath,
              filePath,
              patched.next,
              writeBackVerify,
              readSet,
              false,
              fileShift,
              contextId,
              onFileShift,
            );
          }

          if (params.old_string === undefined || params.new_string === undefined) {
            return errorResult("edit", "edit failed: old_string and new_string are required unless patch is set");
          }
          const oldString = String(params.old_string);
          const newString = String(params.new_string);
          const replaceAll = params.replace_all === true;
          const replaced = replaceInFileContent(filePath, content, oldString, newString, replaceAll);
          if (!replaced.ok) {
            return errorResult("edit", replaced.error);
          }
          return finishEdit(
            policy,
            requestedPath,
            filePath,
            replaced.next,
            writeBackVerify,
            readSet,
            replaced.fuzzy,
            fileShift,
            contextId,
            onFileShift,
          );
        });
      } catch (error) {
        return errorResult("edit", errorMessage(error));
      }
    },
  });
}

async function finishEdit(
  pathPolicy: WorkspacePathPolicy,
  requestedPath: string,
  filePath: string,
  next: string,
  writeBackVerify: boolean,
  readSet: FileReadSet,
  fuzzy = false,
  fileShift?: FileShiftRegistry,
  contextId = "main",
  onFileShift?: (info: FileShiftInfo) => void,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  await pathPolicy.writeFileAtomic(requestedPath, next, undefined, "edit-file");
  const fuzzyNote = fuzzy ? "; fuzzy: whitespace normalized" : "";
  if (!writeBackVerify) {
    await readSet.mark(filePath);
    await noteFileShift(fileShift, contextId, onFileShift, filePath);
    return textResult(`edited ${filePath}${fuzzyNote}`);
  }
  await readSet.mark(filePath);
  await noteFileShift(fileShift, contextId, onFileShift, filePath);
  return textResult(
    `edited ${filePath}${fuzzyNote}; write-back ok sha256=${hashContent(next).slice(0, 12)}`,
  );
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
      const body = `exit_code=${result.exitCode}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`;
      if (result.exitCode !== 0) {
        return errorResult("bash", body);
      }
      return textResult(body);
    },
  });
}

function createGrepTool(
  cwd: string,
  pathPolicy: Promise<WorkspacePathPolicy>,
  searchOverride?: string | null,
  grepSeen?: GrepSeenState,
): ToolDefinition {
  return defineTool({
    name: "grep",
    description:
      "Search file contents with a regular expression. "
      + "Uses host tools in order: ugrep → rg → grep → node. "
      + "Appends a lightweight structure outline per hit file (heuristic; omitted on repeat).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression pattern." }),
      path: Type.String({ description: "File or directory to search (optional)." }),
      glob: Type.String({ description: "Glob filter (optional)." }),
    }, { required: ["pattern"] }),
    async execute(id, params) {
      const pattern = String(params.pattern ?? "");
      const requestedRoot = params.path ? String(params.path) : ".";
      try {
        const policy = await pathPolicy;
        const searchScope = await policy.resolve("search", requestedRoot, id);
        const searchRoot = searchScope.canonicalPath;
        const searchCwd = policy.cwd;
        const globFilter = typeof params.glob === "string" ? params.glob : undefined;
        const withOutline = (text: string): Promise<string> =>
          grepSeen
            ? annotateGrepOutput(text, {
              cwd: searchCwd,
              seen: grepSeen,
              readText: async (filePath) =>
                (await policy.readFileWithin(searchScope, filePath)).toString("utf8"),
            })
            : Promise.resolve(text);
        const engine = await resolveGrepEngine(searchOverride);
        if (engine.kind !== "node") {
          const result = await runGrepWithEngine(engine, {
            cwd: searchCwd,
            pattern,
            searchRoot,
            globFilter,
          });
          if (result.kind === "ok") {
            const filtered = await filterGrepOutput(result.text, searchCwd, searchScope, policy);
            return textResult(await withOutline(filtered));
          }
          if (result.kind === "error") {
            return errorResult("grep", result.text);
          }
          // spawn failure → Node fallback
        }
        const nodeText = await grepWithNode(searchCwd, pattern, searchScope, globFilter, policy);
        return textResult(`${nodeBackendNote("grep")}\n${await withOutline(nodeText)}`);
      } catch (error) {
        return errorResult("grep", errorMessage(error));
      }
    },
  });
}

function createGlobTool(
  cwd: string,
  pathPolicy: Promise<WorkspacePathPolicy>,
  searchOverride?: string | null,
): ToolDefinition {
  return defineTool({
    name: "glob",
    description:
      "Find files matching a glob pattern. "
      + "Uses host tools in order: ugrep → rg → bfs → find → node.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts" }),
      path: Type.String({ description: "Root directory (optional)." }),
    }, { required: ["pattern"] }),
    async execute(id, params) {
      const pattern = String(params.pattern ?? "");
      const requestedRoot = params.path ? String(params.path) : ".";
      try {
        const policy = await pathPolicy;
        const searchScope = await policy.resolve("search", requestedRoot, id);
        const root = searchScope.canonicalPath;
        const searchCwd = policy.cwd;
        const engine = await resolveGlobEngine(searchOverride);
        if (engine.kind !== "node") {
          const result = await runGlobWithEngine(engine, { cwd: searchCwd, pattern, root });
          if (result.kind === "ok") {
            return textResult(await filterGlobOutput(result.text, searchCwd, searchScope, policy));
          }
          if (result.kind === "error") {
            return errorResult("glob", result.text);
          }
        }
        const nodeText = await globWithNode(searchCwd, pattern, searchScope, policy);
        return textResult(`${nodeBackendNote("glob")}\n${nodeText}`);
      } catch (error) {
        return errorResult("glob", errorMessage(error));
      }
    },
  });
}

async function grepWithNode(
  cwd: string,
  pattern: string,
  searchScope: CheckedWorkspacePath,
  globFilter: string | undefined,
  pathPolicy: WorkspacePathPolicy,
): Promise<string> {
  const regex = new RegExp(pattern);
  const matches: string[] = [];
  for await (const file of walkFiles(searchScope, globFilter, pathPolicy)) {
    let content: string;
    try {
      content = (await pathPolicy.readFileWithin(searchScope, file)).toString("utf8");
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

async function globWithNode(
  cwd: string,
  pattern: string,
  searchScope: CheckedWorkspacePath,
  pathPolicy: WorkspacePathPolicy,
): Promise<string> {
  const files: string[] = [];
  for await (const file of walkFiles(searchScope, pattern, pathPolicy)) {
    files.push(path.relative(cwd, file));
    if (files.length >= 500) {
      break;
    }
  }
  return files.length > 0 ? files.join("\n") : "no files";
}

function textResult(text: string, isError = false, tool?: string) {
  const body = isError && tool ? withFixHint(tool, text) : text;
  return {
    content: [{ type: "text" as const, text: body }],
    isError,
  };
}

/** Error result with Fix: guidance for the model. */
function errorResult(tool: string, text: string) {
  return textResult(text, true, tool);
}

function resolvePath(cwd: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

async function filterGrepOutput(
  text: string,
  cwd: string,
  searchScope: CheckedWorkspacePath,
  pathPolicy: WorkspacePathPolicy,
): Promise<string> {
  if (text === "no matches") return text;
  const accepted: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const candidate = path.isAbsolute(match[1]!)
      ? match[1]!
      : path.resolve(cwd, match[1]!);
    try {
      const checked = await pathPolicy.resolveWithin(searchScope, "read-file", candidate);
      accepted.push(`${path.relative(cwd, checked.canonicalPath)}:${match[2]}:${match[3]}`);
    } catch {
      // A host backend may emit a stale/escaped path; never return it or its line content.
    }
  }
  return accepted.length > 0 ? accepted.join("\n") : "no matches";
}

async function filterGlobOutput(
  text: string,
  cwd: string,
  searchScope: CheckedWorkspacePath,
  pathPolicy: WorkspacePathPolicy,
): Promise<string> {
  if (text === "no files") return text;
  const accepted: string[] = [];
  for (const line of text.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const candidate = path.isAbsolute(line) ? line : path.resolve(cwd, line);
    try {
      const checked = await pathPolicy.resolveWithin(searchScope, "read-file", candidate);
      accepted.push(path.relative(cwd, checked.canonicalPath));
    } catch {
      // Post-filter every host result against the same no-symlink capability.
    }
  }
  return accepted.length > 0 ? accepted.join("\n") : "no files";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function* walkFiles(
  searchScope: CheckedWorkspacePath,
  globFilter: string | undefined,
  pathPolicy: WorkspacePathPolicy,
): AsyncGenerator<string> {
  const root = searchScope.canonicalPath;
  if (searchScope.kind === "regular-file") {
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
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        try {
          const checked = await pathPolicy.resolveWithin(searchScope, "search", full);
          if (checked.kind === "directory") stack.push(checked.canonicalPath);
        } catch {
          // Entry changed or escaped after readdir; skip it.
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let checked: CheckedWorkspacePath;
      try {
        checked = await pathPolicy.resolveWithin(searchScope, "read-file", full);
      } catch {
        continue;
      }
      const relative = path.relative(root, full);
      if (!globFilter || matchGlob(relative, globFilter) || matchGlob(entry.name, globFilter)) {
        yield checked.canonicalPath;
      }
    }
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
