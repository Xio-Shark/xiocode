import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DomainLockedError, ExecutionDomain } from "@xioflow/kernel";

import { kernelDomainRoot } from "../runtime/process/kernel-process.ts";

export type KernelCliOptions = Readonly<{
  write?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
}>;

type Verdict = "confirmed_stopped" | "abandon_with_residuals";

export async function runKernelCli(
  args: readonly string[],
  options: KernelCliOptions = {},
): Promise<number> {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = options.writeErr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = options.env ?? process.env;

  const subCommand = args[0];

  if (!subCommand || args.includes("--help") || args.includes("-h") || subCommand === "help") {
    write(kernelHelp(env));
    return 0;
  }

  if (subCommand === "adjudicate") {
    return handleAdjudicate(args.slice(1), env, write, writeErr);
  }
  if (subCommand === "status") {
    return handleStatus(args.slice(1), env, write);
  }

  writeErr(`Unknown kernel subcommand: "${subCommand}"\n\n${kernelHelp(env)}`);
  return 1;
}

async function handleAdjudicate(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
  writeErr: (chunk: string) => void,
): Promise<number> {
  const parsed = parseAdjudicateArgs(args);
  if (!parsed.opId) {
    writeErr("Error: Missing required <opId> for adjudication.\n\nUsage: xio kernel adjudicate <opId> [--domain <path>] [--verdict <confirmed_stopped|abandon_with_residuals>] [--note <note>]\n");
    return 1;
  }

  const domainPath = parsed.domainPath ?? findDomainForOperation(parsed.opId, env);
  if (!domainPath) {
    writeErr(
      `Error: no execution domain under ${kernelDomainRoot(env)} contains operation "${parsed.opId}". `
        + "Pass --domain <path> (the path is printed next to the operation id).\n",
    );
    return 1;
  }

  const opDomainId = readOperationDomainId(path.join(domainPath, "domain.db"), parsed.opId);
  if (!opDomainId) {
    writeErr(`Error: operation "${parsed.opId}" is not recorded in ${domainPath}.\n`);
    return 1;
  }

  const actor = actorName(env);
  const verdict = parsed.verdict ?? "confirmed_stopped";
  let domain: ExecutionDomain | undefined;
  try {
    domain = ExecutionDomain.acquire(domainPath, opDomainId);
    const record = await domain.adjudicate(parsed.opId, verdict, actor, parsed.note);

    write(`\x1b[32m✔ Adjudication recorded\x1b[0m\n`);
    write(`  Operation ID:       ${record.operationId}\n`);
    write(`  Verdict:            ${record.verdict}\n`);
    write(`  Actor:              ${record.actor}\n`);
    write(`  Decided At:         ${record.decidedAt}\n`);
    if (record.residualPids && record.residualPids.length > 0) {
      write(`  Residual PIDs:      ${record.residualPids.join(", ")}\n`);
    }
    if (record.note) {
      write(`  Note:               ${record.note}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof DomainLockedError) {
      writeErr(
        `\x1b[31m✖ The domain is owned by a running XioCode session (pid ${err.ownerPid}).\x1b[0m\n`
          + `  Adjudicate from inside that session: /kernel adjudicate ${parsed.opId}\n`,
      );
      return 1;
    }
    writeErr(`\x1b[31m✖ Adjudication failed:\x1b[0m ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    domain?.close();
  }
}

type DomainSummary = Readonly<{
  domainPath: string;
  owner: "none" | "live" | "crashed";
  ownerPid?: number;
  unfinished: number;
  indeterminate: readonly Readonly<{ id: string; name: string }>[];
}>;

/** `xio kernel status [--all]`: domains that need attention (or all of them). */
function handleStatus(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
): number {
  const root = kernelDomainRoot(env);
  const all = args.includes("--all");
  const summaries = listDomains(root).map(summarizeDomain);
  const shown = all
    ? summaries
    : summaries.filter((s) => s.owner === "crashed" || s.unfinished > 0 || s.indeterminate.length > 0);
  write(`kernel domains: ${root} (${summaries.length} total)\n`);
  if (shown.length === 0) {
    write(all ? "  (none)\n" : "  nothing needs attention — no crashed owners, unfinished or indeterminate operations\n");
    return 0;
  }
  for (const summary of shown) {
    const owner = summary.owner === "live"
      ? `live session pid ${summary.ownerPid}`
      : summary.owner === "crashed" ? `crashed owner pid ${summary.ownerPid} (recovered on next launch in this workspace)` : "closed";
    write(`\n  ${path.basename(summary.domainPath)}\n    owner: ${owner}\n    unfinished operations: ${summary.unfinished}\n`);
    for (const op of summary.indeterminate) {
      const how = summary.owner === "live"
        ? `/kernel adjudicate ${op.id}  (in that session)`
        : `xio kernel adjudicate ${op.id} --domain ${summary.domainPath}`;
      write(`    indeterminate: ${op.id} (${op.name}) → ${how}\n`);
    }
  }
  return 0;
}

function listDomains(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "domain.db")))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function summarizeDomain(domainPath: string): DomainSummary {
  const lock = readLock(domainPath);
  const owner = !lock ? "none" : isAlive(lock.ownerPid) ? "live" : "crashed";
  const base = { domainPath, owner, ...(lock ? { ownerPid: lock.ownerPid } : {}) } as const;
  try {
    const db = new DatabaseSync(path.join(domainPath, "domain.db"), { readOnly: true });
    try {
      const unfinished = db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status != 'done'").get() as { n: number };
      const rows = db.prepare("SELECT id, name, result FROM operations WHERE status = 'done' AND result IS NOT NULL")
        .all() as { id: string; name: string; result: string }[];
      const indeterminate = rows
        .filter((row) => parseStatus(row.result) === "indeterminate")
        .map(({ id, name }) => ({ id, name }));
      return { ...base, unfinished: Number(unfinished.n), indeterminate };
    } finally {
      db.close();
    }
  } catch {
    return { ...base, unfinished: 0, indeterminate: [] };
  }
}

function parseStatus(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function parseAdjudicateArgs(args: readonly string[]): {
  opId?: string;
  domainPath?: string;
  verdict?: Verdict;
  note?: string;
} {
  let opId: string | undefined;
  let domainPath: string | undefined;
  let verdict: Verdict | undefined;
  let note: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--domain" && i + 1 < args.length) {
      domainPath = args[++i];
    } else if (arg === "--verdict" && i + 1 < args.length) {
      const v = args[++i];
      if (v === "confirmed_stopped" || v === "abandon_with_residuals") {
        verdict = v;
      }
    } else if (arg === "--note" && i + 1 < args.length) {
      note = args[++i];
    } else if (!arg.startsWith("-") && !opId) {
      opId = arg;
    }
  }

  return { opId, domainPath, verdict, note };
}

/** Searches the configured domain root (XIOCODE_KERNEL_DOMAIN_ROOT, else <XIO_HOME>/kernel). */
function findDomainForOperation(opId: string, env: NodeJS.ProcessEnv): string | undefined {
  return listDomains(kernelDomainRoot(env))
    .find((domainPath) => readOperationDomainId(path.join(domainPath, "domain.db"), opId) !== undefined);
}

function readOperationDomainId(dbPath: string, opId: string): string | undefined {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT domain_id FROM operations WHERE id = ?").get(opId) as { domain_id?: string } | undefined;
      return row?.domain_id;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function readLock(domainPath: string): { ownerPid: number } | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(domainPath, "domain.lock"), "utf8")) as { ownerPid?: unknown };
    return typeof meta.ownerPid === "number" ? { ownerPid: meta.ownerPid } : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function actorName(env: NodeJS.ProcessEnv): string {
  try {
    return os.userInfo().username;
  } catch {
    return env.USER || env.USERNAME || "operator";
  }
}

function kernelHelp(env: NodeJS.ProcessEnv): string {
  return `xio kernel — supervised execution kernel management

Domains live under ${kernelDomainRoot(env)} (XIOCODE_KERNEL_DOMAIN_ROOT or <XIO_HOME>/kernel).

Commands:
  xio kernel status [--all]
    Domains that need attention: crashed owners, unfinished or indeterminate
    operations (--all lists every domain).

  xio kernel adjudicate <opId> [options]
    Resolve an indeterminate operation, releasing its retained leases under an
    audited journal record. Inside a running session use /kernel adjudicate.

Options (adjudicate):
  --domain <path>     Domain directory (default: search the domain root)
  --verdict <type>    confirmed_stopped (default) or abandon_with_residuals
  --note <text>       Audit note for this adjudication

Examples:
  xio kernel status
  xio kernel adjudicate op-abc-toolu_01 --note "verified the process is gone"
`;
}
