/**
 * Host CLI backends for builtin grep/glob.
 *
 * Grep order: ugrep → rg → grep → node walker
 * Glob order: ugrep → rg → bfs → find → node walker
 *
 * Missing tools are skipped; XioCode never requires a brew install.
 */
import { spawn } from "node:child_process";
import path from "node:path";

export type GrepEngineKind = "ugrep" | "rg" | "grep" | "node";
export type GlobEngineKind = "ugrep" | "rg" | "bfs" | "find" | "node";

export type GrepEngine =
  | Readonly<{ kind: "ugrep" | "rg" | "grep"; binary: string }>
  | Readonly<{ kind: "node" }>;

export type GlobEngine =
  | Readonly<{ kind: "ugrep" | "rg" | "bfs" | "find"; binary: string }>
  | Readonly<{ kind: "node" }>;

export type SearchBackendResult =
  | Readonly<{ kind: "ok"; text: string; backend: string }>
  | Readonly<{ kind: "error"; text: string; backend: string }>
  | Readonly<{ kind: "fallback" }>;

/** Optional host tools we recommend on first install (never required). */
export const RECOMMENDED_CLI_TOOLS = [
  {
    name: "ugrep",
    brew: "ugrep",
    role: "grep 首选（内容搜索）",
  },
  {
    name: "rg",
    brew: "ripgrep",
    role: "grep/glob 次选（内容搜索 + 文件枚举）",
  },
  {
    name: "bfs",
    brew: "bfs",
    role: "glob 目录遍历（优于 find）",
  },
] as const;

export type RecommendedToolProbe = Readonly<{
  name: string;
  brew: string;
  role: string;
  available: boolean;
}>;

const GREP_PROBE_ORDER = ["ugrep", "rg", "grep"] as const;
const GLOB_PROBE_ORDER = ["ugrep", "rg", "bfs", "find"] as const;

type ProbeCache = {
  grep?: Promise<GrepEngine>;
  glob?: Promise<GlobEngine>;
  binaries: Map<string, Promise<boolean>>;
};

const cache: ProbeCache = { binaries: new Map() };

/** Test-only: clear process-wide resolution caches. */
export function resetSearchBackendCacheForTests(): void {
  cache.grep = undefined;
  cache.glob = undefined;
  cache.binaries.clear();
}

/** @deprecated prefer resetSearchBackendCacheForTests */
export function resetRgBinaryCacheForTests(): void {
  resetSearchBackendCacheForTests();
}

/**
 * Resolve content-search engine: ugrep → rg → grep → node.
 * `override`: force engine kind, absolute binary path (rg-compatible), or null/"node".
 */
export async function resolveGrepEngine(
  override?: string | null,
): Promise<GrepEngine> {
  if (override === null || override === "node") {
    return { kind: "node" };
  }
  if (override === "ugrep" || override === "rg" || override === "grep") {
    if (await probeBinary(override)) return { kind: override, binary: override };
    return { kind: "node" };
  }
  if (typeof override === "string" && override.length > 0) {
    // Legacy: explicit binary path treated as ripgrep-compatible.
    return { kind: "rg", binary: override };
  }
  if (!cache.grep) {
    cache.grep = resolveGrepEngineAuto();
  }
  return cache.grep;
}

/**
 * Resolve file-glob engine: ugrep → rg → bfs → find → node.
 */
export async function resolveGlobEngine(
  override?: string | null,
): Promise<GlobEngine> {
  if (override === null || override === "node") {
    return { kind: "node" };
  }
  if (override === "ugrep" || override === "rg" || override === "bfs" || override === "find") {
    if (await probeBinary(override)) return { kind: override, binary: override };
    return { kind: "node" };
  }
  if (typeof override === "string" && override.length > 0) {
    return { kind: "rg", binary: override };
  }
  if (!cache.glob) {
    cache.glob = resolveGlobEngineAuto();
  }
  return cache.glob;
}

/** Legacy helper: path to `rg` if installed (not necessarily selected as grep engine). */
export async function resolveRgBinary(): Promise<string | null> {
  return (await probeBinary("rg")) ? "rg" : null;
}

export async function probeRecommendedTools(): Promise<readonly RecommendedToolProbe[]> {
  const results: RecommendedToolProbe[] = [];
  for (const tool of RECOMMENDED_CLI_TOOLS) {
    results.push({
      name: tool.name,
      brew: tool.brew,
      role: tool.role,
      available: await probeBinary(tool.name),
    });
  }
  return results;
}

/** Human-facing first-install / `xio init` notice. */
export async function formatRecommendedCliToolsNotice(): Promise<string> {
  const probes = await probeRecommendedTools();
  const lines = [
    "Recommended CLI tools (optional — XioCode uses whatever is already on PATH):",
    "  grep 顺序: ugrep → rg → grep → node",
    "  glob 顺序: ugrep → rg → bfs → find → node",
  ];
  for (const probe of probes) {
    if (probe.available) {
      lines.push(`  ✓ ${probe.name} — ${probe.role}`);
    } else {
      lines.push(`  ○ ${probe.name} — ${probe.role}  ·  brew install ${probe.brew}`);
    }
  }
  const missing = probes.filter((p) => !p.available);
  if (missing.length > 0) {
    lines.push(`Install missing (Homebrew): brew install ${missing.map((p) => p.brew).join(" ")}`);
  } else {
    lines.push("All recommended search tools are available.");
  }
  return `${lines.join("\n")}\n`;
}

export async function runGrepWithEngine(
  engine: GrepEngine,
  input: Readonly<{
    cwd: string;
    pattern: string;
    searchRoot: string;
    globFilter?: string;
  }>,
): Promise<SearchBackendResult> {
  if (engine.kind === "node") {
    return { kind: "fallback" };
  }
  if (engine.kind === "ugrep") {
    return grepWithUgrep(engine.binary, input);
  }
  if (engine.kind === "rg") {
    return grepWithRg(engine.binary, input);
  }
  return grepWithSystemGrep(engine.binary, input);
}

export async function runGlobWithEngine(
  engine: GlobEngine,
  input: Readonly<{
    cwd: string;
    pattern: string;
    root: string;
  }>,
): Promise<SearchBackendResult> {
  if (engine.kind === "node") {
    return { kind: "fallback" };
  }
  if (engine.kind === "ugrep") {
    return globWithUgrep(engine.binary, input);
  }
  if (engine.kind === "rg") {
    return globWithRg(engine.binary, input);
  }
  return globWithWalker(engine.binary, engine.kind, input);
}

export function nodeBackendNote(forTool: "grep" | "glob"): string {
  if (forTool === "grep") {
    return "backend=node (no ugrep/rg/grep)";
  }
  return "backend=node (no ugrep/rg/bfs/find)";
}

async function resolveGrepEngineAuto(): Promise<GrepEngine> {
  for (const name of GREP_PROBE_ORDER) {
    if (await probeBinary(name)) {
      return { kind: name, binary: name };
    }
  }
  return { kind: "node" };
}

async function resolveGlobEngineAuto(): Promise<GlobEngine> {
  for (const name of GLOB_PROBE_ORDER) {
    if (await probeBinary(name)) {
      return { kind: name, binary: name };
    }
  }
  return { kind: "node" };
}

export async function probeBinary(name: string): Promise<boolean> {
  let pending = cache.binaries.get(name);
  if (!pending) {
    pending = probeBinaryOnce(name);
    cache.binaries.set(name, pending);
  }
  return pending;
}

async function probeBinaryOnce(name: string): Promise<boolean> {
  // --version works for ugrep/rg/grep; bfs accepts -version via find-compat? use -print with empty
  const versionArgs = name === "bfs" || name === "find"
    ? ["-version"]
    : ["--version"];
  const first = await runArgv(name, versionArgs, process.cwd());
  if (!first.spawnError && first.exitCode === 0) {
    return true;
  }
  // macOS find has no --version; presence via spawn without error on -print of empty is hard.
  // Try `which`-style: run with no-op that still starts.
  if (name === "find" || name === "bfs") {
    const probe = await runArgv(name, [process.cwd(), "-maxdepth", "0", "-type", "d", "-print"], process.cwd());
    return !probe.spawnError && probe.exitCode === 0;
  }
  if (name === "grep") {
    const probe = await runArgv(name, ["--help"], process.cwd());
    return !probe.spawnError && (probe.exitCode === 0 || probe.exitCode === 2 || probe.stdout.length + probe.stderr.length > 0);
  }
  return false;
}

async function grepWithUgrep(
  binary: string,
  input: Readonly<{ cwd: string; pattern: string; searchRoot: string; globFilter?: string }>,
): Promise<SearchBackendResult> {
  const args = ["-rn", "--color=never", "--ignore-files"];
  if (input.globFilter) {
    args.push("-g", input.globFilter);
  }
  args.push("--", input.pattern, input.searchRoot);
  return finishLineMatches(binary, args, input.cwd, "ugrep");
}

async function grepWithRg(
  binary: string,
  input: Readonly<{ cwd: string; pattern: string; searchRoot: string; globFilter?: string }>,
): Promise<SearchBackendResult> {
  const args = ["-n", "--no-heading", "--color=never"];
  if (input.globFilter) {
    args.push("-g", input.globFilter);
  }
  args.push("--", input.pattern, input.searchRoot);
  return finishLineMatches(binary, args, input.cwd, "rg");
}

async function grepWithSystemGrep(
  binary: string,
  input: Readonly<{ cwd: string; pattern: string; searchRoot: string; globFilter?: string }>,
): Promise<SearchBackendResult> {
  const args = [
    "-RIn",
    "--color=never",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
  ];
  if (input.globFilter) {
    args.push(`--include=${input.globFilter}`);
  }
  args.push("--", input.pattern, input.searchRoot);
  return finishLineMatches(binary, args, input.cwd, "grep");
}

async function finishLineMatches(
  binary: string,
  args: readonly string[],
  cwd: string,
  backend: string,
): Promise<SearchBackendResult> {
  const result = await runArgv(binary, args, cwd);
  if (result.spawnError) {
    return { kind: "fallback" };
  }
  if (result.exitCode >= 2) {
    return {
      kind: "error",
      backend,
      text: formatEngineError(backend, result.exitCode, result.stderr),
    };
  }
  if (result.exitCode === 1 || result.stdout.trim().length === 0) {
    return { kind: "ok", backend, text: "no matches" };
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 100)
    .map((line) => relativizeMatchLine(line, cwd));
  return {
    kind: "ok",
    backend,
    text: lines.length > 0 ? lines.join("\n") : "no matches",
  };
}

async function globWithUgrep(
  binary: string,
  input: Readonly<{ cwd: string; pattern: string; root: string }>,
): Promise<SearchBackendResult> {
  // List files matching name glob: any-line match under -g filter.
  const args = [
    "-l",
    "-r",
    "--color=never",
    "--ignore-files",
    "-g",
    input.pattern,
    "--",
    ".",
    input.root,
  ];
  return finishFileList(binary, args, input.cwd, "ugrep");
}

async function globWithRg(
  binary: string,
  input: Readonly<{ cwd: string; pattern: string; root: string }>,
): Promise<SearchBackendResult> {
  const args = ["--files", "-g", input.pattern, "--", input.root];
  return finishFileList(binary, args, input.cwd, "rg");
}

async function globWithWalker(
  binary: string,
  kind: "bfs" | "find",
  input: Readonly<{ cwd: string; pattern: string; root: string }>,
): Promise<SearchBackendResult> {
  const args = [
    input.root,
    "-type",
    "f",
    "-not",
    "-path",
    "*/node_modules/*",
    "-not",
    "-path",
    "*/.git/*",
  ];
  const result = await runArgv(binary, args, input.cwd);
  if (result.spawnError) {
    return { kind: "fallback" };
  }
  if (result.exitCode !== 0) {
    return {
      kind: "error",
      backend: kind,
      text: formatEngineError(kind, result.exitCode, result.stderr),
    };
  }
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => toCwdRelative(file, input.cwd))
    .filter((relative) => matchGlob(relative, input.pattern) || matchGlob(path.basename(relative), input.pattern))
    .slice(0, 500);
  return {
    kind: "ok",
    backend: kind,
    text: files.length > 0 ? files.join("\n") : "no files",
  };
}

async function finishFileList(
  binary: string,
  args: readonly string[],
  cwd: string,
  backend: string,
): Promise<SearchBackendResult> {
  const result = await runArgv(binary, args, cwd);
  if (result.spawnError) {
    return { kind: "fallback" };
  }
  if (result.exitCode >= 2) {
    return {
      kind: "error",
      backend,
      text: formatEngineError(backend, result.exitCode, result.stderr),
    };
  }
  if (result.exitCode === 1 || result.stdout.trim().length === 0) {
    return { kind: "ok", backend, text: "no files" };
  }
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 500)
    .map((file) => toCwdRelative(file, cwd));
  return {
    kind: "ok",
    backend,
    text: files.length > 0 ? files.join("\n") : "no files",
  };
}

function formatEngineError(backend: string, exitCode: number, stderr: string): string {
  const snippet = stderr.trim().slice(0, 400);
  return snippet.length > 0
    ? `${backend} failed (exit ${exitCode}): ${snippet}`
    : `${backend} failed (exit ${exitCode})`;
}

function toCwdRelative(file: string, cwd: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  return path.relative(cwd, absolute);
}

function relativizeMatchLine(line: string, cwd: string): string {
  const match = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!match) {
    return line;
  }
  const file = match[1] ?? "";
  const lineNo = match[2] ?? "";
  const content = match[3] ?? "";
  return `${toCwdRelative(file, cwd)}:${lineNo}:${content}`;
}

/** Shared glob matcher for bfs/find post-filter and Node walker. */
export function matchGlob(value: string, pattern: string): boolean {
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

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnError?: boolean;
};

async function runArgv(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: 1, stdout, stderr: error.message, spawnError: true });
    });
  });
}
