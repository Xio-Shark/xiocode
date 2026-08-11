/**
 * Command-level policy for `bash`, layered *under* the G7 tool risk classes.
 *
 * The tool gate answers "may this session run shell tools at all". That is not
 * the same as approving every shell string. Auto-execution is reserved for a
 * conservative proven-safe subset (no quotes/operators/expansions + fixed
 * argv allowlist). The denylist only explains *why* a command looks dangerous;
 * unknown, complex, and known-risk commands always confirm (or deny under `-p`).
 *
 * Host isolation stays `unsupported`.
 */
export type CommandRiskSeverity =
  | "destructive"
  | "remote-exec"
  | "history-rewrite"
  | "credential"
  | "agent-dispatch";

export type CommandRisk = Readonly<{
  severity: CommandRiskSeverity;
  /** Rule id, for logs and tests. */
  id: string;
  /** One line the user can act on: what this does and why we stopped. */
  reason: string;
  /** The substring that matched, so the prompt shows the real command. */
  match: string;
}>;

type Rule = Readonly<{
  id: string;
  severity: CommandRiskSeverity;
  pattern: RegExp;
  reason: string;
}>;

/**
 * Rules run against the raw command string. Patterns are intentionally narrow:
 * a false "safe" verdict costs a prompt we did not show, a false "dangerous"
 * verdict trains users to mash `y` — which is worse.
 */
const RULES: readonly Rule[] = [
  {
    id: "rm-recursive-force",
    // Two lookaheads so `-rf`, `-fr` and `-r -f` all match: one asserts a
    // recursive flag exists among the flag tokens, the other a force flag.
    severity: "destructive",
    pattern: /(^|[\s;&|(])(?:sudo\s+)?rm\s+(?=(?:-[^\s]+\s+)*-[a-zA-Z]*[rR])(?=(?:-[^\s]+\s+)*-[a-zA-Z]*f)[^;&|]*/,
    reason: "Recursive force-delete removes files with no undo and no trash.",
  },
  {
    id: "rm-home-or-root",
    severity: "destructive",
    pattern: /(^|[\s;&|(])rm\s+[^;&|]*\s(~|\/|\$HOME|\.)(\s|$|\/\*)/,
    reason: "Deletes your home directory, filesystem root, or the whole working tree.",
  },
  {
    id: "disk-write",
    severity: "destructive",
    pattern: /(^|[\s;&|(])(mkfs(\.\w+)?|fdisk|dd)\s+[^;&|]*(\bof=|\/dev\/)/,
    reason: "Writes raw blocks to a device — this destroys a disk or partition.",
  },
  {
    id: "redirect-to-device",
    severity: "destructive",
    pattern: />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/,
    reason: "Redirects output onto a block device, corrupting the disk.",
  },
  {
    id: "chmod-chown-root",
    severity: "destructive",
    pattern: /(^|[\s;&|(])(chmod|chown)\s+(-[^\s]+\s+)*[^\s;&|]+\s+(\/|~)(\s|$)/,
    reason: "Recursively changes permissions on your home or filesystem root.",
  },
  {
    id: "curl-pipe-shell",
    severity: "remote-exec",
    pattern: /\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/,
    reason: "Pipes a downloaded script straight into a shell — arbitrary remote code.",
  },
  {
    id: "remote-eval",
    severity: "remote-exec",
    pattern: /\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/,
    reason: "Pipes downloaded code straight into an interpreter — arbitrary remote code.",
  },
  {
    id: "git-force-push",
    severity: "history-rewrite",
    pattern: /(^|[\s;&|(])git\s+push\b[^;&|]*(\s--force(?!-with-lease)\b|\s-f\b)/,
    reason: "Force-push overwrites remote history other people may have pulled.",
  },
  {
    id: "git-hard-reset",
    severity: "history-rewrite",
    pattern: /(^|[\s;&|(])git\s+reset\s+[^;&|]*--hard\b/,
    reason: "Hard reset discards uncommitted work with no undo.",
  },
  {
    id: "git-clean-force",
    severity: "history-rewrite",
    pattern: /(^|[\s;&|(])git\s+clean\b[^;&|]*-[a-zA-Z]*[fd]/,
    reason: "Deletes untracked files, including ones git never had a copy of.",
  },
  {
    id: "credential-read",
    severity: "credential",
    pattern: /(^|[\s;&|(])(cat|less|more|head|tail|strings|base64)\s+[^;&|]*(\.ssh\/id_|\.aws\/credentials|\.xiocode\/credentials|\.npmrc|\.netrc|\.env\b)/,
    reason: "Reads a secrets file; its contents would be sent to the model provider.",
  },
  {
    id: "trellis-dispatch-bypass",
    // The plan tool's parallel_dispatch action carries its own confirm gates;
    // running task.py plan-import/dispatch-ready/integrate --yes via bash
    // side-steps them (spawns agent fleets / merges branches unattended).
    severity: "agent-dispatch",
    pattern: /\btask\.py\s+(plan-import|dispatch-ready|integrate)\b[^;&|]*--yes\b/,
    reason: "Spawns parallel agents or merges their work without the plan tool's confirm gates — use plan action=parallel_dispatch.",
  },
];

/**
 * Classify one shell command against the denylist. Returns the first matching
 * rule, or undefined when nothing matched — undefined means "not on the
 * known-dangerous list", never "proven safe".
 */
export function classifyCommandRisk(command: string): CommandRisk | undefined {
  const text = command.trim();
  if (text.length === 0) return undefined;
  for (const rule of RULES) {
    const found = rule.pattern.exec(text);
    if (found) {
      return {
        severity: rule.severity,
        id: rule.id,
        reason: rule.reason,
        match: found[0].trim(),
      };
    }
  }
  return undefined;
}

/** Alias: denylist is explanation-only. */
export const explainDangerousCommand = classifyCommandRisk;

export type CommandExecutionDecision =
  | Readonly<{ kind: "safe"; argv: readonly string[]; allowRule: string }>
  | Readonly<{
    kind: "confirm";
    reason: "known-risk" | "unknown-command" | "complex-shell";
    risk?: CommandRisk;
    detail: string;
  }>;

/**
 * Characters that change shell tokenization/expansion. Presence of any one
 * disqualifies the command from the proven-safe auto path.
 */
const SHELL_METACHAR = /['"`\\;&|<>$(){}*!?#~\n\r\t]/;

/** Literal argv tokens allowed in the proven-safe grammar (no quotes/escapes). */
const SAFE_TOKEN = /^[A-Za-z0-9_./:@%=+,\[\]-]+$/;

const LS_FLAGS = new Set(["-l", "-a", "-1", "-la", "-al", "-lh", "-hl"]);

/**
 * Decide whether a raw bash command may auto-run or must confirm.
 * Only a tiny allowlist of simple commands returns `safe`.
 */
export function classifyCommandExecution(command: string): CommandExecutionDecision {
  const raw = command;
  const text = command.trim();
  if (text.length === 0) {
    return {
      kind: "confirm",
      reason: "unknown-command",
      detail: describeCommandConfirm("unknown-command", raw),
    };
  }

  const risk = classifyCommandRisk(text);
  const argv = tokenizeProvenSafe(text);
  if (!argv) {
    return {
      kind: "confirm",
      reason: risk ? "known-risk" : "complex-shell",
      ...(risk ? { risk } : {}),
      detail: describeCommandConfirm(risk ? "known-risk" : "complex-shell", raw, risk),
    };
  }

  const allowRule = matchAllowlist(argv);
  if (allowRule) {
    return { kind: "safe", argv, allowRule };
  }

  return {
    kind: "confirm",
    reason: risk ? "known-risk" : "unknown-command",
    ...(risk ? { risk } : {}),
    detail: describeCommandConfirm(risk ? "known-risk" : "unknown-command", raw, risk),
  };
}

/** True when the command is in the proven-safe allowlist. */
export function isProvenSafeCommand(command: string): boolean {
  return classifyCommandExecution(command).kind === "safe";
}

/**
 * Conservative tokenizer: exactly one simple command, whitespace-separated
 * literal tokens, no shell metacharacters.
 */
export function tokenizeProvenSafe(command: string): string[] | undefined {
  const text = command.trim();
  if (text.length === 0) return undefined;
  if (SHELL_METACHAR.test(text)) return undefined;
  // Reject empty-quote style splices that somehow lack the quote chars above
  // (defensive — the metachar class already covers quotes).
  if (/\s{2,}/.test(text.replace(/^\s+|\s+$/g, ""))) {
    // Multiple spaces are fine; keep splitting.
  }
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  if (tokens.some((token) => !SAFE_TOKEN.test(token))) return undefined;
  // Leading env assignments (FOO=bar cmd) are not proven-safe.
  if (tokens[0]?.includes("=")) return undefined;
  return tokens;
}

function matchAllowlist(argv: readonly string[]): string | undefined {
  const cmd = argv[0];
  if (!cmd) return undefined;
  if (cmd === "pwd" && argv.length === 1) return "pwd";
  if (cmd === "true" && argv.length === 1) return "true";
  if (cmd === "false" && argv.length === 1) return "false";
  if (cmd === "ls") {
    const rest = argv.slice(1);
    for (const arg of rest) {
      if (arg.startsWith("-")) {
        if (!LS_FLAGS.has(arg)) return undefined;
        continue;
      }
      // Relative path only; no parent traversal, no absolute paths.
      if (arg.startsWith("/") || arg === "~" || arg.startsWith("~/") || arg.split("/").includes("..")) {
        return undefined;
      }
    }
    return "ls";
  }
  return undefined;
}

/** Extract the shell command from a `bash` tool_call payload, if present. */
export function commandFromToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** Confirm-prompt detail block; shows the real command, never a paraphrase. */
export function describeCommandRisk(risk: CommandRisk, command: string): string {
  return describeCommandConfirm("known-risk", command, risk);
}

export function describeCommandConfirm(
  reason: "known-risk" | "unknown-command" | "complex-shell",
  command: string,
  risk?: CommandRisk,
): string {
  const lines = [`command: ${truncate(command, 400)}`, `policy: ${reason}`];
  if (risk) {
    lines.push(`matched: ${risk.match}`);
    lines.push(`risk: ${risk.severity} (${risk.id})`);
    lines.push(`why: ${risk.reason}`);
  } else if (reason === "complex-shell") {
    lines.push("why: quotes, operators, redirects, or expansions require one-time confirmation.");
  } else {
    lines.push("why: command is outside the proven-safe allowlist.");
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
