import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

type CanonicalTarget = Readonly<{
  targetPath: string;
  existed: boolean;
  mode: number;
  directoriesToCreate: readonly string[];
}>;

export async function resolveCanonicalTarget(input: Readonly<{
  lexicalRoot: string;
  canonicalRoot: string;
  relativePath: string;
}>): Promise<CanonicalTarget> {
  const relativePath = normalizeRelativePath(input.relativePath);
  const lexicalTarget = path.resolve(input.lexicalRoot, relativePath);
  const parent = await resolveCanonicalParent(
    input.lexicalRoot,
    input.canonicalRoot,
    path.dirname(lexicalTarget),
  );
  let targetPath = path.join(parent.canonicalParent, path.basename(lexicalTarget));
  assertInsideRoot(input.canonicalRoot, targetPath, relativePath);

  const targetStat = await lstatOrUndefined(targetPath);
  if (targetStat?.isSymbolicLink()) {
    targetPath = await realpath(targetPath);
    assertInsideRoot(input.canonicalRoot, targetPath, relativePath);
  }

  const canonicalStat = await lstatOrUndefined(targetPath);
  if (canonicalStat && !canonicalStat.isFile()) {
    throw new Error(`target is not a regular file: ${relativePath}`);
  }

  return {
    targetPath,
    existed: canonicalStat !== undefined,
    mode: canonicalStat ? canonicalStat.mode & 0o777 : 0o666,
    directoriesToCreate: parent.directoriesToCreate,
  };
}

export async function pathExists(filePath: string): Promise<boolean> {
  return (await lstatOrUndefined(filePath)) !== undefined;
}

async function resolveCanonicalParent(
  lexicalRoot: string,
  canonicalRoot: string,
  lexicalParent: string,
): Promise<Readonly<{
  canonicalParent: string;
  directoriesToCreate: readonly string[];
}>> {
  let cursor = lexicalParent;
  const missingSegments: string[] = [];

  while (true) {
    const stat = await lstatOrUndefined(cursor);
    if (stat) {
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(`parent is not a directory: ${cursor}`);
      }
      const canonicalExisting = await realpath(cursor);
      assertInsideRoot(canonicalRoot, canonicalExisting, lexicalParent, true);
      const canonicalExistingStat = await lstat(canonicalExisting);
      if (!canonicalExistingStat.isDirectory()) {
        throw new Error(`canonical parent is not a directory: ${lexicalParent}`);
      }
      const directoriesToCreate: string[] = [];
      let canonicalParent = canonicalExisting;
      for (const segment of missingSegments.reverse()) {
        canonicalParent = path.join(canonicalParent, segment);
        assertInsideRoot(canonicalRoot, canonicalParent, lexicalParent);
        directoriesToCreate.push(canonicalParent);
      }
      return { canonicalParent, directoriesToCreate };
    }

    if (cursor === lexicalRoot) {
      throw new Error(`workspace root is unavailable: ${lexicalRoot}`);
    }
    const next = path.dirname(cursor);
    if (next === cursor || !isInsideOrEqual(lexicalRoot, next)) {
      throw new Error(`parent escapes workspace: ${lexicalParent}`);
    }
    missingSegments.push(path.basename(cursor));
    cursor = next;
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized)) {
    throw new Error(`invalid relative path: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..") || segments.includes("")) {
    throw new Error(`path escapes workspace: ${value}`);
  }
  return normalized;
}

function assertInsideRoot(
  root: string,
  target: string,
  label: string,
  allowRoot = false,
): void {
  if (!isInsideOrEqual(root, target) || (!allowRoot && target === root)) {
    throw new Error(`canonical path escapes workspace: ${label}`);
  }
}

function isInsideOrEqual(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function lstatOrUndefined(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
