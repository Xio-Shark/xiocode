/**
 * `xio-setup trellis` — configure the Trellis DAG (parallel dispatch) feature
 * and update `.trellis/` managed files from the Xio-Shark/Trellis fork.
 *
 * `dag` appends a `parallel:` block to .trellis/config.yaml with the same
 * defaults task.py uses when the section is absent — adding it never changes
 * behavior until values are edited (auto_confirm stays false / dry-run).
 * `update` syncs scripts/** , workflow.md and agents/** from the fork's
 * template dir; user data (config.yaml, tasks/, workspace/, spec/) is never
 * touched. Existing-file overwrites require confirmation (--yes or y/N).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TRELLIS_REPO_URL = "https://github.com/Xio-Shark/Trellis.git";
/** Template root inside the Trellis repo (what `trellis init` distributes). */
const REPO_TEMPLATE_SUBDIR = "packages/cli/src/templates/trellis";

/** Files under .trellis/ that update manages; everything else is user data. */
const MANAGED_DIRS = ["scripts", "agents"] as const;
const MANAGED_FILES = ["workflow.md"] as const;
const IGNORED_SEGMENTS = new Set(["__pycache__", ".DS_Store"]);

export const PARALLEL_WORKERS = ["xio", "channel", "claude", "codex"] as const;

export type DagOptions = Readonly<{
  autoConfirm?: boolean;
  maxConcurrency?: number;
  worker?: string;
}>;

export type TrellisCliOptions = Readonly<{
  write?: (chunk: string) => void;
  ask?: (question: string) => Promise<string>;
  isTty?: boolean;
  cwd?: string;
}>;

const HELP = `xio-setup trellis — Trellis DAG (parallel dispatch) configuration & update

Usage:
  xio-setup trellis                Show status (.trellis, DAG scripts, parallel config)
  xio-setup trellis dag [flags]    Add the parallel: section to .trellis/config.yaml
      --auto-confirm               dispatch-ready spawns without per-wave y/N
      --max-concurrency <1-64>     parallel worker cap (default 8)
      --worker <id>                ${PARALLEL_WORKERS.join(" | ")} (default xio)
  xio-setup trellis update [--yes] [--source <dir>]
                                   Sync .trellis scripts/workflow.md/agents from
                                   ${TRELLIS_REPO_URL}
                                   (--source: local repo/template dir, skips clone)

dag defaults match task.py's absent-section semantics — adding the block never
changes behavior until you edit values. update never touches config.yaml,
tasks/, workspace/ or spec/.
`;

export async function runTrellisCommand(
  args: readonly string[],
  options: TrellisCliOptions = {},
): Promise<number> {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const root = options.cwd ?? process.cwd();
  const [sub, ...rest] = args;
  if (sub === "help" || sub === "--help" || sub === "-h") {
    write(HELP);
    return 0;
  }
  if (sub === undefined || sub === "status") {
    return runStatus(root, write);
  }
  if (sub === "dag") {
    return runDag(rest, root, write, options);
  }
  if (sub === "update") {
    return runUpdate(rest, root, write, options);
  }
  write(`xio-setup: unknown trellis subcommand: ${sub}\n\n${HELP}`);
  return 1;
}

// ---------------------------------------------------------------------------
// status

async function runStatus(root: string, write: (chunk: string) => void): Promise<number> {
  const trellisDir = path.join(root, ".trellis");
  if (!(await exists(trellisDir))) {
    write(`.trellis: missing — run trellis init (or xio-setup trellis update) in ${root}\n`);
    return 1;
  }
  const dagScripts = await exists(path.join(trellisDir, "scripts/common/task_deps.py"));
  const config = await readFileIfExists(path.join(trellisDir, "config.yaml"));
  const configured = config !== undefined && hasParallelSection(config);
  const mark = (ok: boolean) => (ok ? "✓" : "·");
  write(`trellis status (workspace: ${root}):\n`);
  write(` ${mark(true)} .trellis/            present\n`);
  write(` ${mark(dagScripts)} DAG scripts          ${dagScripts ? "task_deps.py + dispatch-ready available" : "missing — run: xio-setup trellis update"}\n`);
  write(` ${mark(configured)} parallel: config     ${configured ? "present in .trellis/config.yaml" : "absent (defaults) — run: xio-setup trellis dag"}\n`);
  write(`update source: ${TRELLIS_REPO_URL}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// dag — append parallel: section to .trellis/config.yaml

/** True when a real (column-0, non-comment) `parallel:` table exists. */
export function hasParallelSection(content: string): boolean {
  return /^parallel:[ \t]*$/m.test(content);
}

export function buildParallelBlock(options: DagOptions = {}): string {
  const autoConfirm = options.autoConfirm ?? false;
  const maxConcurrency = options.maxConcurrency ?? 8;
  const worker = options.worker ?? "xio";
  return `#-------------------------------------------------------------------------------
# Parallel task dispatch (DAG) — added by xio-setup trellis dag
#-------------------------------------------------------------------------------
# Read by task.py dispatch-ready / integrate. auto_confirm: false keeps the
# human-confirm default: dry-run plan only until --yes or auto_confirm: true.
parallel:
  auto_confirm: ${autoConfirm}
  max_concurrency: ${maxConcurrency}
  worker: ${worker}                 # or ${PARALLEL_WORKERS.filter((w) => w !== worker).join(" / ")}
  worker_fallback: channel   # when xio missing; false/none = fail closed
  agent: implement
  timeout: 30m
  max_retries: 0
  drift_fail_closed: false
  verify_command: "npm run check"
  context_max_chars: 24000
`;
}

/** Append the parallel block (idempotent: an existing real section wins). */
export function applyParallelSection(content: string, options: DagOptions = {}): string {
  if (hasParallelSection(content)) return content;
  const trimmed = content.replace(/\s*$/, "");
  return `${trimmed}\n\n${buildParallelBlock(options)}`;
}

async function runDag(
  args: readonly string[],
  root: string,
  write: (chunk: string) => void,
  options: TrellisCliOptions,
): Promise<number> {
  const flags = parseDagFlags(args);
  if (flags.error) {
    write(`xio-setup: ${flags.error}\n`);
    return 1;
  }
  const configPath = path.join(root, ".trellis", "config.yaml");
  const content = await readFileIfExists(configPath);
  if (content === undefined) {
    write(`xio-setup: ${configPath} not found — initialize Trellis first (trellis init).\n`);
    return 1;
  }
  if (hasParallelSection(content)) {
    write("parallel: already present in .trellis/config.yaml — nothing to write.\n");
    write("edit it directly to change values; xio-setup never rewrites existing sections.\n");
    return 0;
  }
  let dag: DagOptions = flags.options;
  const hasFlags = args.length > 0;
  const isTty = options.isTty ?? process.stdin.isTTY === true;
  if (!hasFlags && (options.ask || isTty)) {
    const answered = await askDagOptions(write, options.ask);
    if (answered === undefined) return 1;
    dag = answered;
  }
  const next = applyParallelSection(content, dag);
  await writeFile(configPath, next, "utf8");
  write(`added parallel: (auto_confirm=${dag.autoConfirm ?? false}, max_concurrency=${dag.maxConcurrency ?? 8}, worker=${dag.worker ?? "xio"}) → ${configPath}\n`);
  write("dispatch waves: python3 .trellis/scripts/task.py dispatch-ready <parent-dir> [--yes]\n");
  return 0;
}

async function askDagOptions(
  write: (chunk: string) => void,
  askOverride?: (question: string) => Promise<string>,
): Promise<DagOptions | undefined> {
  const { createInterface } = await import("node:readline/promises");
  const rl = askOverride
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout });
  const ask = askOverride ?? (async (question: string) => rl!.question(question));
  try {
    const autoConfirm = /^y(es)?$/i.test(
      (await ask("auto-confirm dispatch waves (no per-wave y/N)? [y/N]: ")).trim(),
    );
    const rawConcurrency = (await ask("max concurrent workers [8]: ")).trim();
    const maxConcurrency = rawConcurrency === "" ? 8 : Number(rawConcurrency);
    if (!isValidConcurrency(maxConcurrency)) {
      write(`invalid max concurrency: ${rawConcurrency} (expected 1-64)\n`);
      return undefined;
    }
    const worker = (await ask(`worker backend [xio] (${PARALLEL_WORKERS.join("/")}): `)).trim() || "xio";
    if (!PARALLEL_WORKERS.includes(worker as (typeof PARALLEL_WORKERS)[number])) {
      write(`invalid worker: ${worker}\n`);
      return undefined;
    }
    return { autoConfirm, maxConcurrency, worker };
  } finally {
    rl?.close();
  }
}

function isValidConcurrency(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 64;
}

function parseDagFlags(args: readonly string[]): Readonly<{
  options: DagOptions;
  error?: string;
}> {
  let autoConfirm: boolean | undefined;
  let maxConcurrency: number | undefined;
  let worker: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--auto-confirm") {
      autoConfirm = true;
    } else if (arg === "--max-concurrency") {
      const raw = args[index + 1];
      if (!raw) return { options: {}, error: "--max-concurrency requires a value" };
      const value = Number(raw);
      if (!isValidConcurrency(value)) {
        return { options: {}, error: `invalid --max-concurrency: ${raw} (expected 1-64)` };
      }
      maxConcurrency = value;
      index += 1;
    } else if (arg === "--worker") {
      const raw = args[index + 1];
      if (!raw) return { options: {}, error: "--worker requires a value" };
      if (!PARALLEL_WORKERS.includes(raw as (typeof PARALLEL_WORKERS)[number])) {
        return { options: {}, error: `invalid --worker: ${raw} (known: ${PARALLEL_WORKERS.join(" ")})` };
      }
      worker = raw;
      index += 1;
    } else {
      return { options: {}, error: `unknown dag flag: ${arg}` };
    }
  }
  return {
    options: {
      ...(autoConfirm !== undefined ? { autoConfirm } : {}),
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      ...(worker !== undefined ? { worker } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// update — sync managed files from the fork's template dir

export type UpdateEntry = Readonly<{
  relativePath: string;
  action: "add" | "update" | "skip";
}>;

export type UpdatePlan = Readonly<{
  entries: readonly UpdateEntry[];
  pending: readonly UpdateEntry[];
}>;

/** Compare template files against .trellis/; never plans deletions. */
export async function planTrellisUpdate(
  templateRoot: string,
  trellisDir: string,
): Promise<UpdatePlan> {
  const entries: UpdateEntry[] = [];
  for (const relative of await listManagedFiles(templateRoot)) {
    const source = await readFile(path.join(templateRoot, relative), "utf8");
    const local = await readFileIfExists(path.join(trellisDir, relative));
    const action = local === undefined ? "add" : local === source ? "skip" : "update";
    entries.push({ relativePath: relative, action });
  }
  return {
    entries,
    pending: entries.filter((entry) => entry.action !== "skip"),
  };
}

async function listManagedFiles(templateRoot: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const file of MANAGED_FILES) {
    if (await exists(path.join(templateRoot, file))) files.push(file);
  }
  for (const dir of MANAGED_DIRS) {
    const base = path.join(templateRoot, dir);
    if (!(await exists(base))) continue;
    const listed = await readdir(base, { recursive: true, withFileTypes: true });
    for (const entry of listed) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path.relative(templateRoot, absolute);
      if (relative.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment))) continue;
      files.push(relative);
    }
  }
  return files.sort();
}

async function runUpdate(
  args: readonly string[],
  root: string,
  write: (chunk: string) => void,
  options: TrellisCliOptions,
): Promise<number> {
  const yes = args.includes("--yes");
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
  if (sourceIndex >= 0 && !source) {
    write("xio-setup: --source requires a value\n");
    return 1;
  }
  const unknown = args.filter(
    (arg, index) => arg !== "--yes" && arg !== "--source" && index !== sourceIndex + 1,
  );
  if (unknown.length > 0) {
    write(`xio-setup: unknown update flag(s): ${unknown.join(", ")}\n`);
    return 1;
  }
  const trellisDir = path.join(root, ".trellis");
  if (!(await exists(trellisDir))) {
    write(`xio-setup: ${trellisDir} not found — this updater only refreshes an existing .trellis (trellis init creates one).\n`);
    return 1;
  }

  let cloneDir: string | undefined;
  try {
    let templateRoot: string;
    if (source) {
      const resolved = await resolveTemplateRoot(source);
      if (!resolved) {
        write(`xio-setup: ${source} is neither a Trellis repo root nor a template dir (need workflow.md + scripts/).\n`);
        return 1;
      }
      templateRoot = resolved;
    } else {
      write(`cloning ${TRELLIS_REPO_URL} (depth 1)…\n`);
      cloneDir = await mkdtemp(path.join(os.tmpdir(), "xio-setup-trellis-"));
      await execFileAsync("git", ["clone", "--depth", "1", TRELLIS_REPO_URL, cloneDir]);
      templateRoot = path.join(cloneDir, REPO_TEMPLATE_SUBDIR);
      if (!(await exists(templateRoot))) {
        write(`xio-setup: clone missing ${REPO_TEMPLATE_SUBDIR} — repo layout changed?\n`);
        return 1;
      }
    }

    const plan = await planTrellisUpdate(templateRoot, trellisDir);
    write(formatUpdatePlan(plan));
    if (plan.pending.length === 0) {
      write("already up to date — nothing to write.\n");
      return 0;
    }
    if (!yes) {
      const isTty = options.isTty ?? process.stdin.isTTY === true;
      if (!options.ask && !isTty) {
        write("xio-setup: refusing to write without confirmation — re-run with --yes or in a TTY.\n");
        return 1;
      }
      const { createInterface } = await import("node:readline/promises");
      const rl = options.ask
        ? undefined
        : createInterface({ input: process.stdin, output: process.stdout });
      const ask = options.ask ?? (async (question: string) => rl!.question(question));
      try {
        const answer = (await ask(`write ${plan.pending.length} file(s) into ${trellisDir}? [y/N]: `)).trim();
        if (!/^y(es)?$/i.test(answer)) {
          write("aborted — nothing written.\n");
          return 0;
        }
      } finally {
        rl?.close();
      }
    }
    for (const entry of plan.pending) {
      const target = path.join(trellisDir, entry.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const content = await readFile(path.join(templateRoot, entry.relativePath), "utf8");
      await writeFile(target, content, "utf8");
    }
    write(`written: ${plan.pending.length} file(s) → ${trellisDir}\n`);
    write("config.yaml / tasks / workspace / spec untouched (user data).\n");
    return 0;
  } finally {
    if (cloneDir) await rm(cloneDir, { recursive: true, force: true });
  }
}

/** Accept a repo root (contains the template subdir) or a template dir itself. */
async function resolveTemplateRoot(source: string): Promise<string | undefined> {
  const asRepo = path.join(source, REPO_TEMPLATE_SUBDIR);
  if (await exists(path.join(asRepo, "workflow.md"))) return asRepo;
  if (
    (await exists(path.join(source, "workflow.md"))) &&
    (await exists(path.join(source, "scripts")))
  ) {
    return source;
  }
  return undefined;
}

function formatUpdatePlan(plan: UpdatePlan): string {
  const marks: Record<UpdateEntry["action"], string> = { add: "+", update: "~", skip: "✓" };
  const lines = [".trellis managed files (+ new, ~ changed, ✓ up to date):"];
  for (const entry of plan.entries) {
    if (entry.action === "skip") continue;
    lines.push(`  ${marks[entry.action]} ${entry.relativePath}`);
  }
  const skipped = plan.entries.length - plan.pending.length;
  lines.push(`  (${skipped} file(s) already up to date)`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}
