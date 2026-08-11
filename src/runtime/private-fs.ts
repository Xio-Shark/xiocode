/**
 * POSIX-oriented private filesystem helpers for XioCode-owned state.
 *
 * Creates and migrates directories/files to 0700/0600 without following symlinks.
 * Does not call process.umask(). Native Windows: best-effort chmod + symlink rejection only.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class PrivateFsError extends Error {
  readonly operation: string;
  readonly path: string;
  readonly code?: string;

  constructor(input: Readonly<{
    operation: string;
    path: string;
    message: string;
    code?: string;
    cause?: unknown;
  }>) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "PrivateFsError";
    this.operation = input.operation;
    this.path = input.path;
    this.code = input.code;
  }
}

export type TightenOwnedTreeOptions = Readonly<{
  /**
   * When false, only directories are tightened (0700); regular files are left alone.
   * Use for worktree management trees so Git checkout executable bits stay intact.
   * Default true.
   */
  tightenFiles?: boolean;
  /** Limit directory recursion depth (0 = root only). Default unlimited. */
  maxDepth?: number;
}>;

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function supportsNofollow(): boolean {
  return process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number";
}

function withNofollow(flags: number): number {
  return supportsNofollow() ? flags | fsConstants.O_NOFOLLOW : flags;
}

function describeType(st: Stats): string {
  if (st.isSymbolicLink()) return "symbolic link";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "regular file";
  if (st.isSocket()) return "socket";
  if (st.isFIFO()) return "fifo";
  if (st.isCharacterDevice()) return "character device";
  if (st.isBlockDevice()) return "block device";
  return "unknown";
}

function assertOwned(st: Stats, target: string, operation: string): void {
  const uid = currentUid();
  if (uid !== undefined && typeof st.uid === "number" && st.uid !== uid) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: "EPERM",
      message: `cannot secure local state ${target}: inode owned by uid ${st.uid}, expected ${uid}`,
    });
  }
}

function assertDirectory(st: Stats, target: string, operation: string): void {
  if (st.isSymbolicLink()) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: "ELOOP",
      message: `cannot secure local state ${target}: expected directory, found symbolic link`,
    });
  }
  if (!st.isDirectory()) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: "ENOTDIR",
      message: `cannot secure local state ${target}: expected directory, found ${describeType(st)}`,
    });
  }
  assertOwned(st, target, operation);
}

function assertRegularFile(st: Stats, target: string, operation: string): void {
  if (st.isSymbolicLink()) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: "ELOOP",
      message: `cannot secure local state ${target}: expected regular file, found symbolic link`,
    });
  }
  if (!st.isFile()) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: "EINVAL",
      message: `cannot secure local state ${target}: expected regular file, found ${describeType(st)}`,
    });
  }
  assertOwned(st, target, operation);
}

async function chmodPath(target: string, mode: number, operation: string): Promise<void> {
  const st = await lstat(target);
  if (mode === PRIVATE_DIR_MODE) assertDirectory(st, target, operation);
  else assertRegularFile(st, target, operation);
  if ((st.mode & 0o777) === mode) return;

  // Prefer fchmod after O_NOFOLLOW open so the final component cannot be swapped to a symlink.
  try {
    const handle = await open(target, withNofollow(fsConstants.O_RDONLY));
    try {
      await handle.chmod(mode);
      return;
    } finally {
      await handle.close();
    }
  } catch {
    // Directories on some platforms, or mode-000 files, may not open readable.
  }

  const again = await lstat(target);
  if (mode === PRIVATE_DIR_MODE) assertDirectory(again, target, operation);
  else assertRegularFile(again, target, operation);
  try {
    await chmod(target, mode);
  } catch (error) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot secure local state ${target}: chmod failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }
}

/**
 * Ensure `directory` exists as a real directory with mode 0700.
 * Creates missing components one-by-one (never chmod'ing pre-existing host ancestors).
 * Rejects if the leaf path is a symlink or non-directory.
 */
export async function ensurePrivateDir(directory: string): Promise<void> {
  const target = path.resolve(directory);
  const operation = "ensurePrivateDir";
  const toCreate: string[] = [];
  let cursor = target;

  for (;;) {
    try {
      const st = await lstat(cursor);
      if (cursor === target) {
        assertDirectory(st, target, operation);
        if ((st.mode & 0o777) !== PRIVATE_DIR_MODE) {
          await chmodPath(target, PRIVATE_DIR_MODE, operation);
        }
        return;
      }
      // Existing host/parent ancestor — do not chmod; only create missing children below.
      // Allow system compatibility symlinks (macOS /tmp → /private/tmp, /var → /private/var).
      // The managed leaf itself is still rejected when it is a symlink (cursor === target above).
      if (st.isSymbolicLink()) {
        break;
      }
      if (!st.isDirectory()) {
        throw new PrivateFsError({
          operation,
          path: cursor,
          code: "ENOTDIR",
          message: `cannot secure local state ${target}: ancestor ${cursor} is ${describeType(st)}`,
        });
      }
      break;
    } catch (error) {
      if (error instanceof PrivateFsError) throw error;
      if (errorCode(error) !== "ENOENT") {
        throw new PrivateFsError({
          operation,
          path: cursor,
          code: errorCode(error),
          message: `cannot secure local state ${cursor}: lstat failed (${errorCode(error) ?? "unknown"})`,
          cause: error,
        });
      }
      toCreate.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new PrivateFsError({
          operation,
          path: target,
          code: "ENOENT",
          message: `cannot secure local state ${target}: no existing ancestor`,
        });
      }
      cursor = parent;
    }
  }

  for (const dir of toCreate.reverse()) {
    try {
      await mkdir(dir, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new PrivateFsError({
          operation,
          path: dir,
          code: errorCode(error),
          message: `cannot secure local state ${dir}: mkdir failed (${errorCode(error) ?? "unknown"})`,
          cause: error,
        });
      }
    }
    const st = await lstat(dir);
    assertDirectory(st, dir, operation);
    if ((st.mode & 0o777) !== PRIVATE_DIR_MODE) {
      await chmodPath(dir, PRIVATE_DIR_MODE, operation);
    }
  }
}

/**
 * Ensure an existing regular file has mode 0600 (no symlink follow).
 * Missing files are a no-op so callers can create them next.
 * Always ensures the parent directory is private first.
 */
export async function ensurePrivateFile(filePath: string): Promise<void> {
  const target = path.resolve(filePath);
  const operation = "ensurePrivateFile";
  await ensurePrivateDir(path.dirname(target));
  try {
    const st = await lstat(target);
    assertRegularFile(st, target, operation);
    if ((st.mode & 0o777) !== PRIVATE_FILE_MODE) {
      await chmodPath(target, PRIVATE_FILE_MODE, operation);
    }
  } catch (error) {
    if (error instanceof PrivateFsError) throw error;
    if (errorCode(error) === "ENOENT") return;
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot secure local state ${target}: lstat failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }
}

/**
 * Recursively tighten an owned tree: directories → 0700, regular files → 0600.
 * Never follows symlinks; encountering a symlink fails closed.
 */
export async function tightenOwnedTree(
  root: string,
  options: TightenOwnedTreeOptions = {},
): Promise<void> {
  const target = path.resolve(root);
  const operation = "tightenOwnedTree";
  const tightenFiles = options.tightenFiles !== false;
  const maxDepth = options.maxDepth;

  let st: Stats;
  try {
    st = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot secure local state ${target}: lstat failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }

  assertDirectory(st, target, operation);
  if ((st.mode & 0o777) !== PRIVATE_DIR_MODE) {
    await chmodPath(target, PRIVATE_DIR_MODE, operation);
  }

  if (maxDepth !== undefined && maxDepth <= 0) return;

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    // Dirent from readdir does not follow links; still lstat to decide.
    const childStat = await lstat(child);
    if (childStat.isSymbolicLink()) {
      throw new PrivateFsError({
        operation,
        path: child,
        code: "ELOOP",
        message: `cannot secure local state ${child}: expected directory or regular file, found symbolic link`,
      });
    }
    if (childStat.isDirectory()) {
      await tightenOwnedTree(child, {
        tightenFiles,
        maxDepth: maxDepth === undefined ? undefined : maxDepth - 1,
      });
      continue;
    }
    if (childStat.isFile()) {
      if (!tightenFiles) continue;
      assertOwned(childStat, child, operation);
      if ((childStat.mode & 0o777) !== PRIVATE_FILE_MODE) {
        await chmodPath(child, PRIVATE_FILE_MODE, operation);
      }
      continue;
    }
    throw new PrivateFsError({
      operation,
      path: child,
      code: "EINVAL",
      message: `cannot secure local state ${child}: expected directory or regular file, found ${describeType(childStat)}`,
    });
  }
}

export async function writePrivateFile(
  filePath: string,
  data: string | Uint8Array,
  options: Readonly<{ flag?: "w" | "wx" }> = {},
): Promise<void> {
  const target = path.resolve(filePath);
  const operation = "writePrivateFile";
  await ensurePrivateDir(path.dirname(target));
  const flag = options.flag ?? "w";
  let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT;
  if (flag === "wx") {
    flags |= fsConstants.O_EXCL;
  } else {
    flags |= fsConstants.O_TRUNC;
  }
  flags = withNofollow(flags);
  let handle: FileHandle;
  try {
    handle = await open(target, flags, PRIVATE_FILE_MODE);
  } catch (error) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot write private file ${target}: open failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }
  try {
    const st = await handle.stat();
    assertRegularFile(st, target, operation);
    await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
    await handle.chmod(PRIVATE_FILE_MODE);
  } finally {
    await handle.close();
  }
}

export async function appendPrivateFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const target = path.resolve(filePath);
  const operation = "appendPrivateFile";
  await ensurePrivateDir(path.dirname(target));
  const flags = withNofollow(
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
  );
  let handle: FileHandle;
  try {
    handle = await open(target, flags, PRIVATE_FILE_MODE);
  } catch (error) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot append private file ${target}: open failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }
  try {
    const st = await handle.stat();
    assertRegularFile(st, target, operation);
    await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
    await handle.chmod(PRIVATE_FILE_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Open an existing-or-create private file for append (WAL), or truncate write.
 * Caller owns sync/close. Handle is already chmod'd to 0600 when possible.
 */
export async function openPrivateFile(
  filePath: string,
  mode: "a" | "w" | "r+",
): Promise<FileHandle> {
  const target = path.resolve(filePath);
  const operation = "openPrivateFile";
  await ensurePrivateDir(path.dirname(target));
  let flags: number;
  if (mode === "a") {
    flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY;
  } else if (mode === "w") {
    flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;
  } else {
    flags = fsConstants.O_RDWR;
  }
  flags = withNofollow(flags);
  let handle: FileHandle;
  try {
    handle = mode === "r+"
      ? await open(target, flags)
      : await open(target, flags, PRIVATE_FILE_MODE);
  } catch (error) {
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot open private file ${target}: open failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }
  try {
    const st = await handle.stat();
    assertRegularFile(st, target, operation);
    if ((st.mode & 0o777) !== PRIVATE_FILE_MODE) {
      await handle.chmod(PRIVATE_FILE_MODE);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function writePrivateFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: Readonly<{ durable?: boolean }> = {},
): Promise<void> {
  const target = path.resolve(filePath);
  const operation = "writePrivateFileAtomic";
  const parent = path.dirname(target);
  await ensurePrivateDir(parent);
  const tempPath = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    // Reject replacing a symlink destination.
    try {
      const existing = await lstat(target);
      assertRegularFile(existing, target, operation);
    } catch (error) {
      if (error instanceof PrivateFsError) throw error;
      if (errorCode(error) !== "ENOENT") {
        throw new PrivateFsError({
          operation,
          path: target,
          code: errorCode(error),
          message: `cannot write private file ${target}: lstat failed (${errorCode(error) ?? "unknown"})`,
          cause: error,
        });
      }
    }

    const flags = withNofollow(
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    );
    const handle = await open(tempPath, flags, PRIVATE_FILE_MODE);
    try {
      const st = await handle.stat();
      assertRegularFile(st, tempPath, operation);
      await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
      if (options.durable !== false) {
        await handle.sync();
      }
      await handle.chmod(PRIVATE_FILE_MODE);
    } finally {
      await handle.close();
    }

    await rename(tempPath, target);
    await ensurePrivateFile(target);

    if (options.durable !== false) {
      await fsyncDirectoryBestEffort(parent);
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof PrivateFsError) throw error;
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot write private file ${target}: ${errorCode(error) ?? "write failed"}`,
      cause: error,
    });
  }
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = errorCode(error);
    // Platform / FS may not support directory fsync.
    if (code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" || code === "EPERM") {
      return;
    }
    // Best-effort only for durability metadata — do not fail the write.
  }
}

export type SensitiveLocalStatePaths = Readonly<{
  xioHome: string;
  configPath?: string;
  credentialsPath?: string;
  trustPath?: string;
  runtimeConfigPath?: string;
  updateCachePath?: string;
  sessionsRoot?: string;
  runRoot?: string;
  spillsRoot?: string;
  worktreesRoot?: string;
}>;

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Resolve default sensitive roots from env (accepts already-expanded overrides). */
export function resolveSensitiveLocalStatePaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SensitiveLocalStatePaths> = {},
): SensitiveLocalStatePaths {
  const rawHome = overrides.xioHome ?? env.XIO_HOME?.trim() ?? path.join(os.homedir(), ".xiocode");
  const xioHome = path.resolve(expandHomePath(rawHome.length > 0 ? rawHome : path.join(os.homedir(), ".xiocode")));
  const defaultXiocode = path.join(os.homedir(), ".xiocode");
  return {
    xioHome,
    configPath: overrides.configPath
      ?? (env.XIO_CONFIG ? expandHomePath(env.XIO_CONFIG) : path.join(defaultXiocode, "config.toml")),
    credentialsPath: overrides.credentialsPath
      ?? (env.XIO_CREDENTIALS
        ? expandHomePath(env.XIO_CREDENTIALS)
        : path.join(xioHome, "credentials.json")),
    trustPath: overrides.trustPath ?? path.join(defaultXiocode, "trust.json"),
    runtimeConfigPath: overrides.runtimeConfigPath ?? path.join(xioHome, "runtime-config.json"),
    updateCachePath: overrides.updateCachePath ?? path.join(xioHome, "update-check.json"),
    sessionsRoot: overrides.sessionsRoot ?? path.join(xioHome, "sessions"),
    // Align with config-parser DEFAULT_RUN_ROOT (~/.xiocode/runs), not custom XIO_HOME.
    runRoot: overrides.runRoot ?? path.join(defaultXiocode, "runs"),
    spillsRoot: overrides.spillsRoot ?? path.join(xioHome, "spills"),
    worktreesRoot: overrides.worktreesRoot ?? path.join(xioHome, "worktrees"),
  };
}

async function tightenExistingPrivateFile(filePath: string): Promise<void> {
  const target = path.resolve(filePath);
  const operation = "migrateSensitiveLocalState";
  let st: Stats;
  try {
    st = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new PrivateFsError({
      operation,
      path: target,
      code: errorCode(error),
      message: `cannot secure local state ${target}: lstat failed (${errorCode(error) ?? "unknown"})`,
      cause: error,
    });
  }
  assertRegularFile(st, target, operation);
  // Parent may be wide; tighten leaf file only (parent hardened via xioHome / writers).
  if ((st.mode & 0o777) !== PRIVATE_FILE_MODE) {
    await chmodPath(target, PRIVATE_FILE_MODE, operation);
  }
}

/**
 * Idempotent startup migration: tighten known Xio-owned sensitive roots.
 * Does not recurse into Git worktree checkouts (dirs only under worktrees/).
 */
export async function migrateSensitiveLocalState(
  paths: SensitiveLocalStatePaths,
): Promise<void> {
  await ensurePrivateDir(paths.xioHome);

  for (const file of [
    paths.configPath,
    paths.credentialsPath,
    paths.trustPath,
    paths.runtimeConfigPath,
    paths.updateCachePath,
  ]) {
    if (file) await tightenExistingPrivateFile(file);
  }

  const trees = new Set<string>();
  for (const tree of [paths.sessionsRoot, paths.runRoot, paths.spillsRoot]) {
    if (tree) trees.add(path.resolve(tree));
  }
  // Cover both config-default ~/.xiocode/{runs,spills} and XIO_HOME mirrors when they diverge.
  trees.add(path.resolve(path.join(os.homedir(), ".xiocode", "runs")));
  trees.add(path.resolve(path.join(paths.xioHome, "runs")));
  trees.add(path.resolve(path.join(os.homedir(), ".xiocode", "spills")));
  trees.add(path.resolve(path.join(paths.xioHome, "spills")));
  for (const tree of trees) {
    await tightenOwnedTree(tree);
  }

  if (paths.worktreesRoot) {
    // Management dirs only: worktrees/<repo>/<session>. Do not readdir into the
    // Git checkout (symlinks / executable bits must stay untouched).
    await tightenOwnedTree(paths.worktreesRoot, { tightenFiles: false, maxDepth: 2 });
  }
}
