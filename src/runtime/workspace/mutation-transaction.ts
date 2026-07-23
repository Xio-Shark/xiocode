import {
  lstat,
  mkdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { pathExists, resolveCanonicalTarget } from "./mutation-paths.ts";
import type { WorkspaceMutationWrite } from "./mutation.ts";

export type PreparedWorkspaceWrite = {
  relativePath: string;
  targetPath: string;
  content: string;
  existed: boolean;
  mode: number;
  backupPath?: string;
  stagePath: string;
  directoriesToCreate: string[];
  checkpointed: boolean;
  published: boolean;
};

export async function prepareWorkspaceWrites(input: Readonly<{
  lexicalRoot: string;
  canonicalRoot: string;
  writes: readonly WorkspaceMutationWrite[];
  stamp: number;
  transactionId: string;
}>): Promise<PreparedWorkspaceWrite[]> {
  const prepared: PreparedWorkspaceWrite[] = [];
  const canonicalTargets = new Set<string>();

  for (const [index, write] of input.writes.entries()) {
    const relativePath = write.relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const resolved = await resolveCanonicalTarget({
      lexicalRoot: input.lexicalRoot,
      canonicalRoot: input.canonicalRoot,
      relativePath,
    });
    if (canonicalTargets.has(resolved.targetPath)) {
      throw new Error(`duplicate canonical target: ${write.relativePath}`);
    }
    canonicalTargets.add(resolved.targetPath);

    const backupPath = resolved.existed ? `${resolved.targetPath}.bak-${input.stamp}` : undefined;
    if (backupPath && await pathExists(backupPath)) {
      throw new Error(`backup already exists: ${backupPath}`);
    }
    const stagePath = path.join(
      path.dirname(resolved.targetPath),
      `.${path.basename(resolved.targetPath)}.${input.transactionId}.${index}.tmp`,
    );
    if (await pathExists(stagePath)) {
      throw new Error(`staging path already exists: ${stagePath}`);
    }

    prepared.push({
      relativePath,
      targetPath: resolved.targetPath,
      content: write.content,
      existed: resolved.existed,
      mode: resolved.mode,
      ...(backupPath ? { backupPath } : {}),
      stagePath,
      directoriesToCreate: [...resolved.directoriesToCreate],
      checkpointed: false,
      published: false,
    });
  }
  return prepared;
}

async function createMissingDirectories(
  prepared: readonly PreparedWorkspaceWrite[],
  createdDirectories: string[],
): Promise<void> {
  const directories = [...new Set(prepared.flatMap((file) => file.directoriesToCreate))]
    .sort((left, right) => pathDepth(left) - pathDepth(right));
  for (const directory of directories) {
    try {
      await mkdir(directory);
      createdDirectories.push(directory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stat = await lstat(directory);
      if (!stat.isDirectory()) throw error;
    }
  }
}

export async function stagePreparedWrites(
  prepared: readonly PreparedWorkspaceWrite[],
  createdDirectories: string[],
): Promise<void> {
  await createMissingDirectories(prepared, createdDirectories);
  for (const file of prepared) {
    await writeFile(file.stagePath, file.content, {
      encoding: "utf8",
      flag: "wx",
      mode: file.mode,
    });
  }
}

export async function checkpointPreparedWrites(
  prepared: readonly PreparedWorkspaceWrite[],
): Promise<void> {
  for (const file of prepared) {
    if (!file.existed || !file.backupPath) continue;
    await rename(file.targetPath, file.backupPath);
    file.checkpointed = true;
  }
}

export async function publishPreparedWrites(
  prepared: readonly PreparedWorkspaceWrite[],
  beforePublish?: (input: Readonly<{
    index: number;
    relativePath: string;
    targetPath: string;
  }>) => Promise<void> | void,
): Promise<void> {
  for (const [index, file] of prepared.entries()) {
    await beforePublish?.({
      index,
      relativePath: file.relativePath,
      targetPath: file.targetPath,
    });
    await rename(file.stagePath, file.targetPath);
    file.published = true;
  }
}

export async function rollbackPreparedWrites(
  prepared: readonly PreparedWorkspaceWrite[],
  createdDirectories: readonly string[],
): Promise<string[]> {
  const errors: string[] = [];

  for (const file of [...prepared].reverse()) {
    if (!file.published) continue;
    await collectRollbackError(errors, `remove published ${file.relativePath}`, async () => {
      await rm(file.targetPath, { force: true });
    });
  }

  for (const file of [...prepared].reverse()) {
    if (!file.checkpointed || !file.backupPath) continue;
    await collectRollbackError(errors, `restore ${file.relativePath}`, async () => {
      await rename(file.backupPath!, file.targetPath);
    });
  }

  for (const file of prepared) {
    await collectRollbackError(errors, `remove staging ${file.relativePath}`, async () => {
      await rm(file.stagePath, { force: true });
    });
  }

  for (const directory of [...createdDirectories].reverse()) {
    await collectRollbackError(errors, `remove created directory ${directory}`, async () => {
      await rmdir(directory);
    });
  }

  return errors;
}

async function collectRollbackError(
  errors: string[],
  label: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    errors.push(`${label}: ${errorMessage(error)}`);
  }
}

function pathDepth(filePath: string): number {
  return filePath.split(path.sep).length;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
