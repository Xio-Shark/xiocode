import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeCaseId } from "./case-identity.ts";
import { decodePrivateRegressionCase, decodePrivateRegressionCompare, decodePrivateRegressionPreflight } from "./decoder.ts";
import { InvalidRegressionCaseError, invalidRegressionCase } from "./errors.ts";

import type { PrivateRegressionCase, PrivateRegressionCompare, PrivateRegressionPreflight } from "./types.ts";

export type CaseWriteResult = Readonly<{
  case_path: string;
  existing: boolean;
}>;

export class RegressionCaseStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = expandHome(root ?? process.env.XIO_REGRESSION_ROOT ?? "~/.xiocode/regressions");
  }

  caseDirectory(caseId: string): string {
    assertCaseId(caseId);
    return path.join(this.root, caseId);
  }

  casePath(caseId: string): string {
    return path.join(this.caseDirectory(caseId), "case.json");
  }

  async readCase(caseId: string): Promise<PrivateRegressionCase> {
    try {
      const regression = decodePrivateRegressionCase(await readJson(this.casePath(caseId)));
      assertIdentity(regression);
      return regression;
    } catch (error) {
      throw invalidRegressionCase(error);
    }
  }

  async writeCase(value: PrivateRegressionCase): Promise<CaseWriteResult> {
    decodePrivateRegressionCase(value);
    assertIdentity(value);
    const casePath = this.casePath(value.case_id);
    const existing = await readExistingCase(casePath);
    if (existing) {
      assertIdentity(existing);
      return { case_path: casePath, existing: true };
    }
    await atomicWrite(casePath, value);
    return { case_path: casePath, existing: false };
  }

  async writePreflight(value: PrivateRegressionPreflight): Promise<string> {
    decodePrivateRegressionPreflight(value);
    const output = path.join(this.caseDirectory(value.case_id), "preflight.json");
    await atomicWrite(output, value);
    return output;
  }

  async writeCompare(value: PrivateRegressionCompare): Promise<string> {
    decodePrivateRegressionCompare(value);
    const output = path.join(this.caseDirectory(value.case_id), "compare.json");
    await atomicWrite(output, value);
    return output;
  }
}

async function readExistingCase(filePath: string): Promise<PrivateRegressionCase | null> {
  try {
    return decodePrivateRegressionCase(await readJson(filePath));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const value = await readFile(filePath, "utf8");
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new InvalidRegressionCaseError(`invalid JSON: ${filePath}`, { cause: error });
  }
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertCaseId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new InvalidRegressionCaseError("invalid case id");
  }
}

function assertIdentity(value: PrivateRegressionCase): void {
  const { case_id: caseId, created_at: _createdAt, ...identity } = value;
  if (computeCaseId(identity) !== caseId) {
    throw new InvalidRegressionCaseError(`case identity mismatch: ${caseId}`);
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
}
