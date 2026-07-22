/**
 * Non-blocking npm update check for CLI startup.
 * Fetches the published latest tag (cached ~24h) and returns a short notice when
 * the installed package is behind — does not auto-install.
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readPackageVersion } from "./version.ts";

const DEFAULT_PACKAGE = "@xioshark/xiocode";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 2_000;

export type UpdateCheckCache = Readonly<{
  checkedAt: number;
  latest: string;
  packageName: string;
}>;

export type UpdateCheckResult = Readonly<{
  current: string;
  latest: string;
  packageName: string;
  notice: string;
}>;

export type ScheduleUpdateCheckOptions = Readonly<{
  current?: string;
  packageName?: string;
  registry?: string;
  env?: NodeJS.ProcessEnv;
  /** Override cache file path (tests). */
  cachePath?: string;
  /** Override fetch (tests). */
  fetchLatest?: (input: Readonly<{
    packageName: string;
    registry: string;
    signal: AbortSignal;
  }>) => Promise<string | undefined>;
  now?: () => number;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
}>;

/** True when `latest` is a higher major.minor.patch than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

export function formatUpdateNotice(input: Readonly<{
  current: string;
  latest: string;
  packageName: string;
}>): string {
  return `Update available: ${input.current} → ${input.latest} · npm i -g ${input.packageName}`;
}

export function readPackageName(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { name?: string };
    return pkg.name?.trim() || DEFAULT_PACKAGE;
  } catch {
    return DEFAULT_PACKAGE;
  }
}

export function defaultUpdateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = expandXioHome(env);
  return path.join(home, "update-check.json");
}

export function shouldSkipUpdateCheck(env: NodeJS.ProcessEnv = process.env): boolean {
  if (truthy(env.XIO_DISABLE_UPDATE_CHECK) || truthy(env.XIO_NO_UPDATE_CHECK)) {
    return true;
  }
  if (truthy(env.CI) || truthy(env.XIO_PERF_BOOT_EXIT)) {
    return true;
  }
  return false;
}

/**
 * Schedule a background update check. Never throws to callers.
 * Resolves to a user-facing notice string, or null when up-to-date / skipped / failed.
 */
export function scheduleUpdateCheck(
  options: ScheduleUpdateCheckOptions = {},
): Promise<string | null> {
  return runUpdateCheck(options).then((result) => result?.notice ?? null).catch(() => null);
}

/** Full result for tests / advanced callers. */
export async function runUpdateCheck(
  options: ScheduleUpdateCheckOptions = {},
): Promise<UpdateCheckResult | undefined> {
  const env = options.env ?? process.env;
  if (shouldSkipUpdateCheck(env)) {
    return undefined;
  }

  const current = options.current ?? readPackageVersion();
  const packageName = options.packageName ?? readPackageName();
  const registry = normalizeRegistry(options.registry ?? env.XIO_INSTALL_REGISTRY ?? DEFAULT_REGISTRY);
  const cachePath = options.cachePath ?? defaultUpdateCachePath(env);
  const now = options.now?.() ?? Date.now();
  const ttl = options.cacheTtlMs
    ?? (Number(env.XIO_UPDATE_CHECK_INTERVAL_MS) || DEFAULT_CACHE_TTL_MS);
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetchLatest = options.fetchLatest ?? fetchLatestFromRegistry;

  let latest = await readFreshCachedLatest({
    cachePath,
    packageName,
    now,
    ttlMs: ttl,
  });

  if (!latest) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      latest = await fetchLatest({
        packageName,
        registry,
        signal: controller.signal,
      });
      if (latest) {
        await writeCache(cachePath, {
          checkedAt: now,
          latest,
          packageName,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (!latest || !isNewerVersion(latest, current)) {
    return undefined;
  }

  return {
    current,
    latest,
    packageName,
    notice: formatUpdateNotice({ current, latest, packageName }),
  };
}

export function parseSemver(version: string): readonly [number, number, number] | undefined {
  const cleaned = version.trim().replace(/^v/i, "");
  const core = cleaned.split("-")[0]?.split("+")[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 3) return undefined;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) {
    return undefined;
  }
  return [major, minor, patch];
}

async function fetchLatestFromRegistry(input: Readonly<{
  packageName: string;
  registry: string;
  signal: AbortSignal;
}>): Promise<string | undefined> {
  // Scoped names stay as @scope/name in the path (do not URI-encode the slash).
  const url = `${normalizeRegistry(input.registry)}${input.packageName}/latest`;
  const response = await fetch(url, {
    signal: input.signal,
    headers: {
      accept: "application/json",
      "user-agent": `xiocode-update-check/${readPackageVersion()}`,
    },
  });
  if (!response.ok) {
    return undefined;
  }
  const body = await response.json() as { version?: unknown };
  return typeof body.version === "string" && body.version.trim() ? body.version.trim() : undefined;
}

async function readFreshCachedLatest(input: Readonly<{
  cachePath: string;
  packageName: string;
  now: number;
  ttlMs: number;
}>): Promise<string | undefined> {
  try {
    const raw = await readFile(input.cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateCheckCache>;
    if (
      typeof parsed.checkedAt !== "number"
      || typeof parsed.latest !== "string"
      || typeof parsed.packageName !== "string"
      || parsed.packageName !== input.packageName
    ) {
      return undefined;
    }
    if (input.now - parsed.checkedAt > input.ttlMs) {
      return undefined;
    }
    return parsed.latest.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, cache: UpdateCheckCache): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");
}

function expandXioHome(env: NodeJS.ProcessEnv): string {
  const raw = env.XIO_HOME?.trim() || "~/.xiocode";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function normalizeRegistry(registry: string): string {
  const trimmed = registry.trim() || DEFAULT_REGISTRY;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
