import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type WriteBackResult = Readonly<{
  ok: boolean;
  path: string;
  expectedHash: string;
  actualHash?: string;
  message: string;
}>;

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Read file back and compare to expected content (exact bytes as utf8). */
export async function verifyWriteBack(filePath: string, expectedContent: string): Promise<WriteBackResult> {
  const expectedHash = hashContent(expectedContent);
  try {
    const actual = await readFile(filePath, "utf8");
    const actualHash = hashContent(actual);
    if (actual === expectedContent) {
      return {
        ok: true,
        path: filePath,
        expectedHash,
        actualHash,
        message: `write-back ok sha256=${actualHash.slice(0, 12)}`,
      };
    }
    return {
      ok: false,
      path: filePath,
      expectedHash,
      actualHash,
      message:
        `write-back mismatch for ${filePath}: expected sha256=${expectedHash.slice(0, 12)} actual=${actualHash.slice(0, 12)}. `
        + "Disk content differs from what was written — re-read before claiming success.",
    };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      expectedHash,
      message:
        `write-back failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}. `
        + "Confirm path and permissions under the workspace.",
    };
  }
}
