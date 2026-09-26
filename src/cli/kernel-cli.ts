import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ExecutionDomain } from "@xioflow/kernel";

export type KernelCliOptions = Readonly<{
  write?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
}>;

export async function runKernelCli(
  args: readonly string[],
  options: KernelCliOptions = {},
): Promise<number> {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = options.writeErr ?? ((chunk: string) => process.stderr.write(chunk));

  const subCommand = args[0];

  if (!subCommand || args.includes("--help") || args.includes("-h") || subCommand === "help") {
    write(kernelHelp());
    return 0;
  }

  if (subCommand === "adjudicate") {
    return handleAdjudicate(args.slice(1), write, writeErr);
  }

  writeErr(`Unknown kernel subcommand: "${subCommand}"\n\n${kernelHelp()}`);
  return 1;
}

async function handleAdjudicate(
  args: readonly string[],
  write: (chunk: string) => void,
  writeErr: (chunk: string) => void,
): Promise<number> {
  const parsed = parseAdjudicateArgs(args);
  if (!parsed.opId) {
    writeErr("Error: Missing required <opId> for adjudication.\n\nUsage: xio kernel adjudicate <opId> [--domain <path>] [--verdict <confirmed_stopped|abandon_with_residuals>] [--note <note>]\n");
    return 1;
  }

  const domainPath = parsed.domainPath ?? findDomainForOperation(parsed.opId);
  if (!domainPath) {
    writeErr(`Error: Could not locate execution domain containing operation "${parsed.opId}". Please specify --domain <path>.\n`);
    return 1;
  }

  const actor = os.userInfo?.().username || process.env.USER || process.env.USERNAME || "operator";
  const verdict = parsed.verdict ?? "confirmed_stopped";

  const dbPath = path.join(domainPath, "domain.db");
  let opDomainId = "default";
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT domain_id FROM operations WHERE id = ?").get(parsed.opId) as { domain_id: string } | undefined;
      if (row && row.domain_id) {
        opDomainId = row.domain_id;
      }
    } finally {
      db.close();
    }
  } catch {}

  let domain: ExecutionDomain | undefined;
  try {
    domain = ExecutionDomain.acquire(domainPath, opDomainId);
    const record = await domain.adjudicate(parsed.opId, verdict, actor, parsed.note);

    write(`\x1b[32m✔ Adjudication recorded successfully\x1b[0m\n`);
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
  } catch (err: any) {
    writeErr(`\x1b[31m✖ Adjudication failed:\x1b[0m ${err.message ?? String(err)}\n`);
    return 1;
  } finally {
    domain?.close();
  }
}

function parseAdjudicateArgs(args: readonly string[]): {
  opId?: string;
  domainPath?: string;
  verdict?: "confirmed_stopped" | "abandon_with_residuals";
  note?: string;
} {
  let opId: string | undefined;
  let domainPath: string | undefined;
  let verdict: "confirmed_stopped" | "abandon_with_residuals" | undefined;
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

function findDomainForOperation(opId: string): string | undefined {
  const candidateRoots = [
    path.join(process.cwd(), ".xioflow", "kernel"),
    path.join(process.cwd(), ".xiocode", "kernel"),
    path.join(os.homedir(), ".xiocode", "kernel"),
  ];

  for (const root of candidateRoots) {
    if (!fs.existsSync(root)) continue;

    // Check if root itself is a domain
    if (fs.existsSync(path.join(root, "domain.db"))) {
      if (checkDbForOp(path.join(root, "domain.db"), opId)) {
        return root;
      }
    }

    // Check subdirectories
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDomain = path.join(root, entry.name);
          const dbPath = path.join(subDomain, "domain.db");
          if (fs.existsSync(dbPath) && checkDbForOp(dbPath, opId)) {
            return subDomain;
          }
        }
      }
    } catch {}
  }

  return undefined;
}

function checkDbForOp(dbPath: string, opId: string): boolean {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT id FROM operations WHERE id = ?").get(opId);
      return Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function kernelHelp(): string {
  return `xio kernel — Supervised execution kernel management

Commands:
  xio kernel adjudicate <opId> [options]
    Resolve an indeterminate operation, releasing its retained resource leases
    under audited journal recording.

Options:
  --domain <path>     Path to the execution domain directory (defaults to auto-detect)
  --verdict <type>    Verdict type: confirmed_stopped (default) or abandon_with_residuals
  --note <text>       Optional audit note for this adjudication

Examples:
  xio kernel adjudicate op-12345
  xio kernel adjudicate op-12345 --verdict confirmed_stopped --note "Manually verified stopped"
`;
}
