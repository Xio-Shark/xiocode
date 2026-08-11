import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export type WorkspacePathOperation =
  | "read-file"
  | "search"
  | "write-file"
  | "edit-file"
  | "project-resource";

export type WorkspacePathKind = "regular-file" | "directory" | "missing";

export type WorkspacePathErrorCode =
  | "OUTSIDE_WORKSPACE"
  | "SYMLINK_COMPONENT"
  | "BROKEN_SYMLINK"
  | "WRONG_TYPE"
  | "PATH_CHANGED"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PATH_IO";

export type CheckedWorkspacePath = Readonly<{
  requestedPath: string;
  absolutePath: string;
  canonicalPath: string;
  canonicalParent: string;
  kind: WorkspacePathKind;
  rootId: string;
  external: boolean;
}>;

export type ExternalPathRequest = Readonly<{
  operation: "read-file" | "search";
  requestedPath: string;
  absolutePath: string;
  canonicalPath: string;
  kind: "regular-file" | "directory";
}>;

export type PathDecision =
  | Readonly<{ decision: "allow"; checked: CheckedWorkspacePath }>
  | Readonly<{ decision: "external"; request: ExternalPathRequest }>;

export type WorkspacePathPolicyHooks = Readonly<{
  /** Deterministic race/failure seam used by security regression tests. */
  beforeReadOpen?: (checked: CheckedWorkspacePath) => Promise<void> | void;
  /** Runs after staging is durable but before target identity is revalidated. */
  beforeWritePublish?: (checked: CheckedWorkspacePath, stagingPath: string) => Promise<void> | void;
  /** Runs after rename and before post-publish validation. */
  afterWritePublish?: (checked: CheckedWorkspacePath) => Promise<void> | void;
}>;

export type WorkspacePathPolicyOptions = Readonly<{
  workspaceRoot: string;
  cwd?: string;
  additionalRoots?: readonly Readonly<{
    id: string;
    path: string;
    /** Missing optional roots are skipped; defaults to true for additional roots. */
    optional?: boolean;
  }>[];
  hooks?: WorkspacePathPolicyHooks;
}>;

export type StagedWorkspaceWrite = Readonly<{
  target: CheckedWorkspacePath;
  stagingPath: string;
  existed: boolean;
  createdDirectories: readonly string[];
  publish: () => Promise<CheckedWorkspacePath>;
  discard: () => Promise<void>;
  cleanupCreatedDirectories: () => Promise<void>;
}>;

type RootEntry = Readonly<{
  id: string;
  aliasPath: string;
  canonicalPath: string;
}>;

type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  rdev: number;
  birthtimeMs: number;
}>;

type OneShotGrant = Readonly<{
  operation: "read-file" | "search";
  requestedPath: string;
  absolutePath: string;
  canonicalPath: string;
  kind: "regular-file" | "directory";
}>;

export class WorkspacePathError extends Error {
  readonly code: WorkspacePathErrorCode;
  readonly targetPath?: string;

  constructor(code: WorkspacePathErrorCode, message: string, targetPath?: string) {
    super(`${code}: ${message}`);
    this.name = "WorkspacePathError";
    this.code = code;
    this.targetPath = targetPath;
  }
}

/**
 * Converts user-controlled paths into checked workspace capabilities.
 *
 * The configured root alias itself may be a symlink (for example a workspace
 * opened through a Finder alias), but every component below an authorized root
 * is inspected with lstat and symlinks are rejected.
 */
export class WorkspacePathPolicy {
  readonly #roots: readonly RootEntry[];
  readonly #hooks: WorkspacePathPolicyHooks;
  readonly #grants = new Map<string, OneShotGrant>();
  #cwd = "";

  private constructor(roots: readonly RootEntry[], hooks: WorkspacePathPolicyHooks) {
    this.#roots = roots;
    this.#hooks = hooks;
  }

  static async create(options: WorkspacePathPolicyOptions): Promise<WorkspacePathPolicy> {
    const primary = await canonicalizeRoot("workspace", options.workspaceRoot);
    const roots: RootEntry[] = [primary];
    for (const root of options.additionalRoots ?? []) {
      try {
        roots.push(await canonicalizeRoot(root.id, root.path));
      } catch (error) {
        if ((root.optional ?? true) && isMissingOptionalRoot(error)) {
          continue;
        }
        throw error;
      }
    }
    const policy = new WorkspacePathPolicy(roots, options.hooks ?? {});
    await policy.#setCwd(options.cwd ?? options.workspaceRoot);
    return policy;
  }

  get workspaceRoot(): string {
    return this.#roots[0]!.canonicalPath;
  }

  get cwd(): string {
    return this.#cwd;
  }

  async inspect(
    operation: WorkspacePathOperation,
    inputPath: string,
  ): Promise<PathDecision> {
    const absolute = this.#absoluteInput(inputPath);
    const match = this.#matchRoot(absolute);
    if (match) {
      return {
        decision: "allow",
        checked: await this.#inspectInsideRoot(
          match.root,
          match.canonicalCandidate,
          operation,
          inputPath,
          absolute,
        ),
      };
    }

    if (operation !== "read-file" && operation !== "search") {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `path escapes workspace root: ${absolute}`,
        absolute,
      );
    }
    return {
      decision: "external",
      request: await this.#inspectExternal(operation, inputPath, absolute),
    };
  }

  grantOnce(callId: string, request: ExternalPathRequest): void {
    if (!callId) {
      throw new WorkspacePathError("INVALID_PATH", "external grant requires a tool call id");
    }
    this.#grants.set(callId, { ...request });
  }

  clearGrants(): void {
    this.#grants.clear();
  }

  async resolve(
    operation: WorkspacePathOperation,
    inputPath: string,
    callId?: string,
  ): Promise<CheckedWorkspacePath> {
    const decision = await this.inspect(operation, inputPath);
    if (decision.decision === "allow") {
      return decision.checked;
    }

    const grant = callId ? this.#grants.get(callId) : undefined;
    if (callId) {
      // One attempt consumes the call-scoped capability, including mismatches.
      this.#grants.delete(callId);
    }
    if (!grant || !sameGrant(grant, decision.request)) {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `outside path requires an exact one-tool-call grant: ${decision.request.canonicalPath}`,
        decision.request.canonicalPath,
      );
    }
    return {
      requestedPath: decision.request.requestedPath,
      absolutePath: decision.request.absolutePath,
      canonicalPath: decision.request.canonicalPath,
      canonicalParent: path.dirname(decision.request.canonicalPath),
      kind: decision.request.kind,
      rootId: "external",
      external: true,
    };
  }

  async resolveWithin(
    base: CheckedWorkspacePath,
    operation: WorkspacePathOperation,
    inputPath: string,
  ): Promise<CheckedWorkspacePath> {
    const absolute = path.resolve(inputPath);
    if (base.kind === "regular-file") {
      if (absolute !== base.canonicalPath) {
        throw new WorkspacePathError(
          "OUTSIDE_WORKSPACE",
          `search result is outside the authorized file: ${absolute}`,
          absolute,
        );
      }
      return this.#recheckChecked(base, operation);
    }
    if (base.kind !== "directory") {
      throw new WorkspacePathError("WRONG_TYPE", `authorized search base is not a directory`, base.canonicalPath);
    }
    if (!isContained(base.canonicalPath, absolute)) {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `search result escapes authorized root: ${absolute}`,
        absolute,
      );
    }
    const temporaryRoot: RootEntry = {
      id: base.rootId,
      aliasPath: base.canonicalPath,
      canonicalPath: base.canonicalPath,
    };
    const checked = await this.#inspectInsideRoot(
      temporaryRoot,
      absolute,
      operation,
      inputPath,
      absolute,
      base.external,
    );
    return { ...checked, rootId: base.rootId, external: base.external };
  }

  async readFile(inputPath: string, callId?: string): Promise<Buffer> {
    const checked = await this.resolve("read-file", inputPath, callId);
    return this.#readChecked(checked);
  }

  /** Project resource loaders: no external grants; same safe open/post-check path. */
  async readProjectResource(inputPath: string): Promise<Buffer> {
    const checked = await this.resolve("project-resource", inputPath);
    return this.#readChecked(checked);
  }

  async readFileWithin(base: CheckedWorkspacePath, inputPath: string): Promise<Buffer> {
    const checked = await this.resolveWithin(base, "read-file", inputPath);
    return this.#readChecked(checked);
  }

  async stageWrite(
    inputPath: string,
    data: string | Uint8Array,
    callId?: string,
    operation: "write-file" | "edit-file" = "write-file",
  ): Promise<StagedWorkspaceWrite> {
    const initial = await this.resolve(operation, inputPath, callId);
    if (initial.external) {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `outside writes are never authorized: ${initial.canonicalPath}`,
        initial.canonicalPath,
      );
    }
    const root = this.#rootFor(initial);
    const createdDirectories = await this.#ensureParentDirectories(root, initial.canonicalParent);
    let stagingPath = "";
    let stagingHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const target = await this.#inspectInsideRoot(
        root,
        initial.canonicalPath,
        operation,
        inputPath,
        initial.absolutePath,
      );
      const parentStat = await checkedLstat(target.canonicalParent);
      if (!parentStat.isDirectory()) {
        throw new WorkspacePathError(
          "WRONG_TYPE",
          `target parent is not a directory: ${target.canonicalParent}`,
          target.canonicalParent,
        );
      }
      const parentIdentity = identityOf(parentStat);
      const targetStat = target.kind === "regular-file"
        ? await checkedLstat(target.canonicalPath)
        : undefined;
      const targetIdentity = targetStat ? identityOf(targetStat) : undefined;
      const mode = targetStat ? targetStat.mode & 0o7777 : 0o666;
      // Capture prior bytes before rename so post-publish validation failures can restore.
      const priorBytes = target.kind === "regular-file"
        ? await this.#readChecked(target)
        : undefined;
      stagingPath = path.join(
        target.canonicalParent,
        `.${path.basename(target.canonicalPath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      stagingHandle = await open(
        stagingPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        mode,
      );
      await stagingHandle.writeFile(data);
      await stagingHandle.sync();
      await stagingHandle.close();
      stagingHandle = undefined;

      let published = false;
      let settled = false;
      const cleanupCreatedDirectories = async (): Promise<void> => {
        for (const dir of [...createdDirectories].reverse()) {
          try {
            await rmdir(dir);
          } catch (error) {
            const code = errorCode(error);
            if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
              throw error;
            }
          }
        }
      };
      const discard = async (): Promise<void> => {
        if (!published) {
          try {
            await unlink(stagingPath);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }
        await cleanupCreatedDirectories();
        settled = true;
      };
      const restoreAfterFailedPublish = async (): Promise<void> => {
        if (priorBytes !== undefined) {
          const restorePath = path.join(
            target.canonicalParent,
            `.${path.basename(target.canonicalPath)}.${process.pid}.${randomUUID()}.restore.tmp`,
          );
          let restoreHandle: Awaited<ReturnType<typeof open>> | undefined;
          try {
            restoreHandle = await open(
              restorePath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
              mode,
            );
            await restoreHandle.writeFile(priorBytes);
            await restoreHandle.sync();
            await restoreHandle.close();
            restoreHandle = undefined;
            await rename(restorePath, target.canonicalPath);
          } catch (restoreError) {
            try {
              await restoreHandle?.close();
            } catch {
              // Preserve the restore failure.
            }
            try {
              await unlink(restorePath);
            } catch {
              // Best-effort cleanup of the restore staging file.
            }
            throw restoreError;
          }
        } else {
          try {
            await unlink(target.canonicalPath);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }
        published = false;
      };
      const publish = async (): Promise<CheckedWorkspacePath> => {
        if (settled) {
          throw new WorkspacePathError("PATH_CHANGED", `staged write is already settled: ${target.canonicalPath}`);
        }
        await this.#hooks.beforeWritePublish?.(target, stagingPath);
        const current = await this.#inspectInsideRoot(
          root,
          target.canonicalPath,
          operation,
          target.requestedPath,
          target.absolutePath,
        );
        const currentParent = await checkedLstat(current.canonicalParent);
        if (!sameIdentity(parentIdentity, identityOf(currentParent))) {
          throw new WorkspacePathError(
            "PATH_CHANGED",
            `target parent identity changed before publish: ${current.canonicalParent}`,
            current.canonicalParent,
          );
        }
        if (targetIdentity) {
          if (current.kind !== "regular-file") {
            throw new WorkspacePathError("PATH_CHANGED", `target disappeared before publish`, current.canonicalPath);
          }
          const currentTarget = await checkedLstat(current.canonicalPath);
          if (!sameIdentity(targetIdentity, identityOf(currentTarget))) {
            throw new WorkspacePathError(
              "PATH_CHANGED",
              `target identity changed before publish: ${current.canonicalPath}`,
              current.canonicalPath,
            );
          }
        } else if (current.kind !== "missing") {
          throw new WorkspacePathError(
            "PATH_CHANGED",
            `missing target appeared before publish: ${current.canonicalPath}`,
            current.canonicalPath,
          );
        }

        await rename(stagingPath, target.canonicalPath);
        published = true;
        try {
          await this.#hooks.afterWritePublish?.(target);
          const post = await this.#inspectInsideRoot(
            root,
            target.canonicalPath,
            "write-file",
            target.requestedPath,
            target.absolutePath,
          );
          if (post.kind !== "regular-file") {
            throw new WorkspacePathError("PATH_CHANGED", `published target is not a regular file`, post.canonicalPath);
          }
          const expected = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const actual = await this.#readChecked(post);
          if (!actual.equals(expected)) {
            throw new WorkspacePathError(
              "PATH_CHANGED",
              `published content verification mismatch: ${post.canonicalPath}`,
              post.canonicalPath,
            );
          }
          await syncDirectoryBestEffort(post.canonicalParent);
          settled = true;
          return post;
        } catch (error) {
          try {
            await restoreAfterFailedPublish();
          } catch (restoreError) {
            const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new WorkspacePathError(
              "PATH_CHANGED",
              `publish validation failed and restore failed for ${target.canonicalPath}: ${detail}`,
              target.canonicalPath,
            );
          }
          throw error;
        }
      };

      return {
        target,
        stagingPath,
        existed: target.kind === "regular-file",
        createdDirectories,
        publish,
        discard,
        cleanupCreatedDirectories,
      };
    } catch (error) {
      try {
        await stagingHandle?.close();
      } catch {
        // Preserve the original failure.
      }
      if (stagingPath) {
        try {
          await unlink(stagingPath);
        } catch (cleanupError) {
          if (errorCode(cleanupError) !== "ENOENT") {
            throw cleanupError;
          }
        }
      }
      await cleanupDirectoriesBestEffort(createdDirectories);
      throw error;
    }
  }

  async writeFileAtomic(
    inputPath: string,
    data: string | Uint8Array,
    callId?: string,
    operation: "write-file" | "edit-file" = "write-file",
  ): Promise<CheckedWorkspacePath> {
    const staged = await this.stageWrite(inputPath, data, callId, operation);
    try {
      return await staged.publish();
    } catch (error) {
      await staged.discard();
      throw error;
    }
  }

  async removeFile(inputPath: string): Promise<void> {
    const checked = await this.resolve("write-file", inputPath);
    if (checked.external) {
      throw new WorkspacePathError("OUTSIDE_WORKSPACE", `outside remove denied`, checked.canonicalPath);
    }
    if (checked.kind === "missing") return;
    const current = await this.#recheckChecked(checked, "write-file");
    await unlink(current.canonicalPath);
    await syncDirectoryBestEffort(current.canonicalParent);
  }

  async #setCwd(configuredCwd: string): Promise<void> {
    const absolute = path.resolve(configuredCwd);
    const match = this.#matchRoot(absolute);
    if (!match) {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `cwd is outside the configured workspace root: ${absolute}`,
        absolute,
      );
    }
    const checked = await this.#inspectInsideRoot(
      match.root,
      match.canonicalCandidate,
      "search",
      configuredCwd,
      absolute,
    );
    if (checked.kind !== "directory") {
      throw new WorkspacePathError("WRONG_TYPE", `cwd is not a directory: ${absolute}`, absolute);
    }
    this.#cwd = checked.canonicalPath;
  }

  #absoluteInput(inputPath: string): string {
    if (inputPath.includes("\0")) {
      throw new WorkspacePathError("INVALID_PATH", "path contains NUL", inputPath);
    }
    return path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(this.#cwd, inputPath);
  }

  #matchRoot(absolute: string): Readonly<{
    root: RootEntry;
    canonicalCandidate: string;
  }> | undefined {
    const candidates: Array<{ root: RootEntry; base: string }> = [];
    for (const root of this.#roots) {
      candidates.push({ root, base: root.aliasPath });
      if (root.canonicalPath !== root.aliasPath) {
        candidates.push({ root, base: root.canonicalPath });
      }
    }
    candidates.sort((left, right) => right.base.length - left.base.length);
    for (const candidate of candidates) {
      const relative = containedRelative(candidate.base, absolute);
      if (relative === undefined) continue;
      return {
        root: candidate.root,
        canonicalCandidate: relative === ""
          ? candidate.root.canonicalPath
          : path.join(candidate.root.canonicalPath, relative),
      };
    }
    return undefined;
  }

  async #inspectInsideRoot(
    root: RootEntry,
    canonicalCandidate: string,
    operation: WorkspacePathOperation,
    requestedPath: string,
    absolutePath: string,
    external = false,
  ): Promise<CheckedWorkspacePath> {
    const relative = containedRelative(root.canonicalPath, canonicalCandidate);
    if (relative === undefined) {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `canonical path escapes authorized root: ${canonicalCandidate}`,
        canonicalCandidate,
      );
    }
    const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
    if (segments.length === 0) {
      assertKindAllowed(operation, "directory", canonicalCandidate);
      return {
        requestedPath,
        absolutePath,
        canonicalPath: root.canonicalPath,
        canonicalParent: path.dirname(root.canonicalPath),
        kind: "directory",
        rootId: root.id,
        external,
      };
    }

    let ancestor = root.canonicalPath;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const current = path.join(ancestor, segment);
      let currentStat: Stats;
      try {
        currentStat = await lstat(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw ioPathError(current, error);
        }
        if (operation !== "write-file") {
          throw new WorkspacePathError("NOT_FOUND", `path does not exist: ${current}`, current);
        }
        const canonicalAncestor = await realpath(ancestor);
        const canonicalPath = path.join(canonicalAncestor, ...segments.slice(index));
        return {
          requestedPath,
          absolutePath,
          canonicalPath,
          canonicalParent: path.dirname(canonicalPath),
          kind: "missing",
          rootId: root.id,
          external,
        };
      }
      if (currentStat.isSymbolicLink()) {
        throw new WorkspacePathError(
          "SYMLINK_COMPONENT",
          `symlink component is not allowed below an authorized root: ${current}`,
          current,
        );
      }
      const last = index === segments.length - 1;
      if (!last) {
        if (!currentStat.isDirectory()) {
          throw new WorkspacePathError(
            "WRONG_TYPE",
            `non-directory path component: ${current}`,
            current,
          );
        }
        ancestor = current;
        continue;
      }
      const kind = classifyStat(currentStat, current);
      assertKindAllowed(operation, kind, current);
      const canonicalPath = await realpath(current);
      if (!isContained(root.canonicalPath, canonicalPath)) {
        throw new WorkspacePathError(
          "OUTSIDE_WORKSPACE",
          `realpath escapes authorized root: ${canonicalPath}`,
          canonicalPath,
        );
      }
      return {
        requestedPath,
        absolutePath,
        canonicalPath,
        canonicalParent: await realpath(path.dirname(current)),
        kind,
        rootId: root.id,
        external,
      };
    }
    throw new WorkspacePathError("PATH_IO", `failed to classify path: ${canonicalCandidate}`);
  }

  async #inspectExternal(
    operation: "read-file" | "search",
    requestedPath: string,
    absolutePath: string,
  ): Promise<ExternalPathRequest> {
    let before: Stats;
    try {
      before = await lstat(absolutePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new WorkspacePathError(
          "OUTSIDE_WORKSPACE",
          `outside path does not exist and cannot be granted: ${absolutePath}`,
          absolutePath,
        );
      }
      throw ioPathError(absolutePath, error);
    }
    if (before.isSymbolicLink()) {
      throw new WorkspacePathError(
        "SYMLINK_COMPONENT",
        `outside symlink target cannot be granted: ${absolutePath}`,
        absolutePath,
      );
    }
    const kind = classifyStat(before, absolutePath);
    assertKindAllowed(operation, kind, absolutePath);
    const canonicalPath = await realpath(absolutePath);
    const after = await checkedLstat(absolutePath);
    if (after.isSymbolicLink() || !sameIdentity(identityOf(before), identityOf(after))) {
      throw new WorkspacePathError(
        "PATH_CHANGED",
        `outside path changed during authorization: ${absolutePath}`,
        absolutePath,
      );
    }
    return {
      operation,
      requestedPath,
      absolutePath,
      canonicalPath,
      kind: kind as "regular-file" | "directory",
    };
  }

  async #readChecked(checked: CheckedWorkspacePath): Promise<Buffer> {
    await this.#hooks.beforeReadOpen?.(checked);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await openReadNoFollow(checked.canonicalPath);
      const handleStat = await handle.stat();
      if (!handleStat.isFile()) {
        throw new WorkspacePathError(
          "WRONG_TYPE",
          `opened target is not a regular file: ${checked.canonicalPath}`,
          checked.canonicalPath,
        );
      }
      const current = await this.#recheckChecked(checked, "read-file");
      const currentStat = await checkedLstat(current.canonicalPath);
      if (!sameIdentity(identityOf(handleStat), identityOf(currentStat))) {
        throw new WorkspacePathError(
          "PATH_CHANGED",
          `target identity changed while opening: ${checked.canonicalPath}`,
          checked.canonicalPath,
        );
      }
      const data = await handle.readFile();
      const post = await this.#recheckChecked(current, "read-file");
      const postStat = await checkedLstat(post.canonicalPath);
      if (!sameIdentity(identityOf(handleStat), identityOf(postStat))) {
        throw new WorkspacePathError(
          "PATH_CHANGED",
          `target identity changed before read completed: ${checked.canonicalPath}`,
          checked.canonicalPath,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      const code = errorCode(error);
      if (code === "ELOOP") {
        throw new WorkspacePathError(
          "SYMLINK_COMPONENT",
          `target became a symlink while opening: ${checked.canonicalPath}`,
          checked.canonicalPath,
        );
      }
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new WorkspacePathError(
          "PATH_CHANGED",
          `target changed while opening: ${checked.canonicalPath}`,
          checked.canonicalPath,
        );
      }
      throw ioPathError(checked.canonicalPath, error);
    } finally {
      await handle?.close();
    }
  }

  async #recheckChecked(
    checked: CheckedWorkspacePath,
    operation: WorkspacePathOperation,
  ): Promise<CheckedWorkspacePath> {
    let current: CheckedWorkspacePath;
    if (checked.external) {
      if (operation !== "read-file" && operation !== "search") {
        throw new WorkspacePathError("OUTSIDE_WORKSPACE", `outside mutation denied`, checked.canonicalPath);
      }
      const request = await this.#inspectExternal(operation, checked.requestedPath, checked.canonicalPath);
      current = {
        requestedPath: checked.requestedPath,
        absolutePath: checked.absolutePath,
        canonicalPath: request.canonicalPath,
        canonicalParent: path.dirname(request.canonicalPath),
        kind: request.kind,
        rootId: checked.rootId,
        external: true,
      };
    } else {
      const root = this.#rootFor(checked);
      current = await this.#inspectInsideRoot(
        root,
        checked.canonicalPath,
        operation,
        checked.requestedPath,
        checked.absolutePath,
      );
    }
    if (current.canonicalPath !== checked.canonicalPath || current.kind !== checked.kind) {
      throw new WorkspacePathError(
        "PATH_CHANGED",
        `path identity changed: ${checked.canonicalPath}`,
        checked.canonicalPath,
      );
    }
    return current;
  }

  #rootFor(checked: CheckedWorkspacePath): RootEntry {
    const root = this.#roots.find((entry) => entry.id === checked.rootId);
    if (!root) {
      throw new WorkspacePathError(
        "OUTSIDE_WORKSPACE",
        `no authorized root for ${checked.canonicalPath}`,
        checked.canonicalPath,
      );
    }
    return root;
  }

  async #ensureParentDirectories(root: RootEntry, parent: string): Promise<string[]> {
    const relative = containedRelative(root.canonicalPath, parent);
    if (relative === undefined) {
      throw new WorkspacePathError("OUTSIDE_WORKSPACE", `target parent escapes root: ${parent}`, parent);
    }
    const created: string[] = [];
    let current = root.canonicalPath;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let currentStat: Stats | undefined;
      try {
        currentStat = await lstat(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw ioPathError(current, error);
        try {
          await mkdir(current);
          created.push(current);
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== "EEXIST") throw ioPathError(current, mkdirError);
        }
        currentStat = await checkedLstat(current);
      }
      if (currentStat.isSymbolicLink()) {
        throw new WorkspacePathError("SYMLINK_COMPONENT", `symlink parent is not allowed: ${current}`, current);
      }
      if (!currentStat.isDirectory()) {
        throw new WorkspacePathError("WRONG_TYPE", `target parent component is not a directory: ${current}`, current);
      }
      const canonical = await realpath(current);
      if (!isContained(root.canonicalPath, canonical)) {
        throw new WorkspacePathError("OUTSIDE_WORKSPACE", `created parent escapes root: ${canonical}`, canonical);
      }
    }
    return created;
  }
}

async function canonicalizeRoot(id: string, configuredPath: string): Promise<RootEntry> {
  if (configuredPath.includes("\0")) {
    throw new WorkspacePathError("INVALID_PATH", `root contains NUL: ${configuredPath}`, configuredPath);
  }
  const aliasPath = path.resolve(configuredPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(aliasPath);
  } catch (error) {
    throw ioPathError(aliasPath, error);
  }
  const rootStat = await checkedLstat(canonicalPath);
  if (!rootStat.isDirectory()) {
    throw new WorkspacePathError("WRONG_TYPE", `authorized root is not a directory: ${aliasPath}`, aliasPath);
  }
  return { id, aliasPath, canonicalPath };
}

function containedRelative(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  if (
    relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    return relative;
  }
  return undefined;
}

function isContained(root: string, candidate: string): boolean {
  return containedRelative(root, candidate) !== undefined;
}

function classifyStat(stats: Stats, target: string): "regular-file" | "directory" {
  if (stats.isFile()) return "regular-file";
  if (stats.isDirectory()) return "directory";
  throw new WorkspacePathError("WRONG_TYPE", `special filesystem object is not allowed: ${target}`, target);
}

function assertKindAllowed(
  operation: WorkspacePathOperation,
  kind: WorkspacePathKind,
  target: string,
): void {
  const allowed =
    operation === "search"
      ? kind === "regular-file" || kind === "directory"
      : operation === "write-file"
        ? kind === "regular-file" || kind === "missing"
        : kind === "regular-file";
  if (!allowed) {
    throw new WorkspacePathError(
      kind === "missing" ? "NOT_FOUND" : "WRONG_TYPE",
      `${operation} does not allow ${kind}: ${target}`,
      target,
    );
  }
}

function identityOf(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    rdev: stats.rdev,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.ino !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.dev === right.dev
    && left.rdev === right.rdev
    && left.birthtimeMs === right.birthtimeMs;
}

function sameGrant(left: OneShotGrant, right: ExternalPathRequest): boolean {
  return left.operation === right.operation
    && left.requestedPath === right.requestedPath
    && left.absolutePath === right.absolutePath
    && left.canonicalPath === right.canonicalPath
    && left.kind === right.kind;
}

async function checkedLstat(target: string): Promise<Stats> {
  try {
    return await lstat(target);
  } catch (error) {
    throw ioPathError(target, error);
  }
}

async function openReadNoFollow(target: string): Promise<Awaited<ReturnType<typeof open>>> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    return await open(target, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = errorCode(error);
    if (noFollow !== 0 && (code === "EINVAL" || code === "ENOTSUP")) {
      // Platforms without O_NOFOLLOW still get pre/open/post identity checks.
      return open(target, "r");
    }
    throw error;
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not portable (notably Windows); file sync already succeeded.
  } finally {
    await handle?.close();
  }
}

async function cleanupDirectoriesBestEffort(directories: readonly string[]): Promise<void> {
  for (const dir of [...directories].reverse()) {
    try {
      await rmdir(dir);
    } catch {
      // Only newly-created empty directories can be removed; retain non-empty paths.
    }
  }
}

function ioPathError(target: string, error: unknown): WorkspacePathError {
  if (error instanceof WorkspacePathError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new WorkspacePathError("PATH_IO", `filesystem check failed for ${target}: ${detail}`, target);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingOptionalRoot(error: unknown): boolean {
  if (errorCode(error) === "ENOENT") return true;
  if (error instanceof WorkspacePathError) {
    return error.code === "NOT_FOUND" || (error.code === "PATH_IO" && /ENOENT/.test(error.message));
  }
  return false;
}
