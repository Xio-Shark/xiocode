import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ErrorTracker } from "./error-tracker.ts";
import type { Executable } from "./types.ts";

export type ProjectState = Readonly<{
  branch: string;
  status: string;
  recentCommits: string;
}>;

export type ContextInjectorOptions = Readonly<{
  cwd?: string;
  exec?: Executable;
  ttlMs?: number;
  maxStatusEntries?: number;
  now?: () => number;
  errorTracker?: ErrorTracker;
}>;

export type FormatProjectStateOptions = Readonly<{
  maxStatusEntries?: number;
}>;

export type ContextInjectionOptions = Readonly<{
  allowExpiredCache?: boolean;
  allowMissingCache?: boolean;
}>;

type ContextCacheEntry = Readonly<{
  expiresAt: number;
  injected: string;
  state: ProjectState;
}>;

type RecentCommitsCacheEntry = Readonly<{
  branch: string;
  expiresAt: number;
  recentCommits: string;
}>;

type ProjectStateReadOptions = Readonly<{
  includeCleanDetails?: boolean;
}>;

const DEFAULT_CONTEXT_CACHE_TTL_MS = 15_000;
const DEFAULT_RECENT_COMMITS_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_STATUS_ENTRIES = 40;
const WORKSPACE_PATHSPEC = ".";
const LF_CODE = 10;
const CR_CODE = 13;
const execFileAsync = promisify(execFile);
const EMPTY_CONTEXT_ENTRY: ContextCacheEntry = {
  expiresAt: 0,
  injected: "",
  state: { branch: "", status: "", recentCommits: "" },
};

export class ContextInjector {
  private readonly cwd: string;
  private readonly exec: Executable;
  private readonly ttlMs: number;
  private readonly maxStatusEntries: number;
  private readonly now: () => number;
  private readonly errorTracker: ErrorTracker;
  private cache: ContextCacheEntry | undefined;
  private recentCommitsCache: RecentCommitsCacheEntry | undefined;
  private pendingContext: Promise<ContextCacheEntry> | undefined;
  private cacheGeneration = 0;

  constructor(options: ContextInjectorOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.exec = options.exec ?? ((command, args) => runGit(command, args, this.cwd));
    this.ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_CACHE_TTL_MS;
    this.maxStatusEntries = options.maxStatusEntries ?? DEFAULT_MAX_STATUS_ENTRIES;
    this.now = options.now ?? Date.now;
    this.errorTracker = options.errorTracker ?? new ErrorTracker();
  }

  async collect(): Promise<ProjectState> {
    return this.readProjectState({ includeCleanDetails: true });
  }

  async inject(options: ContextInjectionOptions = {}): Promise<string> {
    const contextEntry = await this.getContext(options);
    const parts: string[] = [];

    // 添加项目状态
    if (contextEntry.injected) {
      parts.push(contextEntry.injected);
    }

    // 添加错误摘要（如果有最近的错误）
    const errorSummary = this.errorTracker.generateSummary();
    if (errorSummary) {
      parts.push("");
      parts.push(errorSummary);
    }

    return parts.join("\n");
  }

  getErrorTracker(): ErrorTracker {
    return this.errorTracker;
  }

  invalidate(): void {
    this.cache = undefined;
    this.recentCommitsCache = undefined;
    this.pendingContext = undefined;
    this.cacheGeneration += 1;
  }

  private async getContext(options: ContextInjectionOptions = {}): Promise<ContextCacheEntry> {
    const cached = this.cache;
    if (cached && cached.expiresAt > this.now()) {
      return cached;
    }
    if (cached && options.allowExpiredCache === true) {
      const pending = this.pendingContext ?? this.startContextRead();
      void pending.catch(() => undefined);
      return cached;
    }
    if (options.allowMissingCache === true) {
      const pending = this.pendingContext ?? this.startContextRead();
      void pending.catch(() => undefined);
      return EMPTY_CONTEXT_ENTRY;
    }
    if (this.pendingContext) {
      return this.pendingContext;
    }
    return this.startContextRead();
  }

  private startContextRead(): Promise<ContextCacheEntry> {
    const generation = this.cacheGeneration;
    const pending = this.readAndCacheContext(generation).finally(() => {
      if (this.pendingContext === pending) {
        this.pendingContext = undefined;
      }
    });
    this.pendingContext = pending;
    return pending;
  }

  private async readAndCacheContext(generation: number): Promise<ContextCacheEntry> {
    const state = await this.readProjectState();
    const injected = state.status ? formatProjectState(state, { maxStatusEntries: this.maxStatusEntries }) : "";
    const entry = { expiresAt: this.now() + this.ttlMs, injected, state };
    if (generation === this.cacheGeneration) {
      this.cache = entry;
    }
    return entry;
  }

  private async readProjectState(options: ProjectStateReadOptions = {}): Promise<ProjectState> {
    let branchStatus: BranchStatus;
    let recentCommits: string;
    try {
      branchStatus = parseBranchStatus(await this.exec("git", ["status", "--short", "--branch", "--", WORKSPACE_PATHSPEC]));
      if (branchStatus.status.length === 0) {
        if (options.includeCleanDetails === true) {
          return { branch: branchStatus.branch, status: "", recentCommits: await this.readRecentCommits(branchStatus.branch) };
        }
        return { branch: "", status: "", recentCommits: "" };
      }
      recentCommits = await this.readRecentCommits(branchStatus.branch);
    } catch (error) {
      if (isNotGitRepository(error)) {
        return { branch: "", status: "", recentCommits: "" };
      }
      throw error;
    }
    return {
      branch: branchStatus.branch,
      status: branchStatus.status,
      recentCommits: recentCommits.trim(),
    };
  }

  private async readRecentCommits(branch: string): Promise<string> {
    const cached = this.recentCommitsCache;
    if (cached && cached.branch === branch && cached.expiresAt > this.now()) {
      return cached.recentCommits;
    }
    const recentCommits = (await this.exec("git", ["log", "--oneline", "-5", "--", WORKSPACE_PATHSPEC])).trim();
    this.recentCommitsCache = { branch, expiresAt: this.now() + DEFAULT_RECENT_COMMITS_CACHE_TTL_MS, recentCommits };
    return recentCommits;
  }
}

export function formatProjectState(state: ProjectState, options: FormatProjectStateOptions = {}): string {
  const commits = state.recentCommits || "(none)";
  return [
    "",
    "## Project State (auto-injected)",
    `- Branch: ${state.branch || "(unknown)"}`,
    formatStatus(state.status, options.maxStatusEntries ?? DEFAULT_MAX_STATUS_ENTRIES),
    `- Recent commits: ${commits}`,
  ].join("\n");
}

function formatStatus(status: string, maxEntries: number): string {
  const entries = firstNonEmptyLines(status, maxEntries);
  if (entries.total === 0) {
    return "- Uncommitted: (clean)";
  }
  if (entries.total <= maxEntries) {
    return `- Uncommitted (${entries.total}):\n${entries.items.join("\n")}`;
  }
  const shown = entries.items.join("\n");
  return `- Uncommitted (${entries.total}, showing ${maxEntries}):\n${shown}\n... (${entries.total - maxEntries} more changes)`;
}

async function runGit(command: string, args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
  });
  return stdout;
}

function isNotGitRepository(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = error instanceof Error ? error.message : "";
  return `${stderr}\n${message}`.includes("not a git repository");
}

type BranchStatus = Readonly<{
  branch: string;
  status: string;
}>;

function parseBranchStatus(output: string): BranchStatus {
  const lines = allNonEmptyLines(output.trim());
  const [branchLine, ...statusLines] = lines;
  const branch = branchLine?.startsWith("## ") ? branchLine.slice(3).split("...")[0]?.trim() ?? "" : "";
  return {
    branch,
    status: statusLines.join("\n"),
  };
}

function firstNonEmptyLines(text: string, maxItems: number): { readonly items: readonly string[]; readonly total: number } {
  const keepLimit = Math.max(Math.trunc(maxItems), 0);
  const items: string[] = [];
  let total = 0;
  scanLines(text, (line) => {
    if (line.length === 0) {
      return;
    }
    total++;
    if (items.length < keepLimit) {
      items.push(line);
    }
  });
  return { items, total };
}

function allNonEmptyLines(text: string): readonly string[] {
  const lines: string[] = [];
  scanLines(text, (line) => {
    if (line.length > 0) {
      lines.push(line);
    }
  });
  return lines;
}

function scanLines(text: string, onLine: (line: string) => void): void {
  let lineStart = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== LF_CODE) {
      continue;
    }
    onLine(lineSlice(text, lineStart, index));
    lineStart = index + 1;
  }
  onLine(text.slice(lineStart));
}

function lineSlice(text: string, start: number, newlineIndex: number): string {
  const end = text.charCodeAt(newlineIndex - 1) === CR_CODE ? newlineIndex - 1 : newlineIndex;
  return text.slice(start, end);
}
