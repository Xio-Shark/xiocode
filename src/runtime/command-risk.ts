/**
 * Command-level risk for `bash`, layered *under* the G7 tool risk classes.
 *
 * The tool gate answers "may this session run shell commands at all"; it is
 * approved once and then stays approved. That is the right granularity for
 * `npm test`, and the wrong granularity for `rm -rf ~`. This layer re-asks for
 * the specific commands that destroy data, execute remote code, or rewrite
 * shared history — every time, with the matched command shown.
 *
 * Deliberately a pattern layer, not a shell parser: it is a speed bump on the
 * known-catastrophic set, not a sandbox. Host isolation stays `unsupported`.
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
 * Classify one shell command. Returns the first matching rule, or undefined
 * when nothing matched — undefined means "not on the known-dangerous list",
 * never "proven safe".
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

/** Extract the shell command from a `bash` tool_call payload, if present. */
export function commandFromToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** Confirm-prompt detail block; shows the real command, never a paraphrase. */
export function describeCommandRisk(risk: CommandRisk, command: string): string {
  return [
    `command: ${truncate(command, 400)}`,
    `matched: ${risk.match}`,
    `risk: ${risk.severity} (${risk.id})`,
    `why: ${risk.reason}`,
  ].join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
