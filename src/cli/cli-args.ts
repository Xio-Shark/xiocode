import { parseResumeRequest } from "./session-resume.ts";

import type { ResumeRequest } from "./session-resume.ts";

export type OutputFormat = "text" | "stream-json";

export class CliUsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = exitCode;
  }
}

export const KNOWN_FLAGS = [
  "--help",
  "-h",
  "--version",
  "-v",
  "--prompt",
  "-p",
  "--output-format",
  "--continue",
  "--allow-dirty",
  "--allow-high-risk",
  "--xio-fast",
] as const;

export const KNOWN_SUBCOMMANDS = [
  "init",
  "doctor",
  "feedback",
  "models",
  "web",
  "kernel",
  "resume",
] as const;

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    row[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    let prev = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[j]! + 1, prev + 1, row[j - 1]! + cost);
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }

  return row[b.length]!;
}

export function findClosestOption(target: string, candidates: readonly string[]): string | undefined {
  let closest: string | undefined;
  let minScore = Infinity;

  const targetClean = target.replace(/^-+/, "");

  for (const candidate of candidates) {
    const candClean = candidate.replace(/^-+/, "");
    let dist = levenshteinDistance(target, candidate);

    // Prioritize prefix, suffix, and substring containment over raw substitution distance
    if (candClean.length > 0 && targetClean.length > 0) {
      if (candClean === targetClean) {
        dist = 0;
      } else if (candClean.startsWith(targetClean) || candClean.endsWith(targetClean)) {
        dist = Math.min(dist, 1);
      } else if (candClean.includes(targetClean)) {
        dist = Math.min(dist, 2);
      }
    }

    if (dist < minScore) {
      minScore = dist;
      closest = candidate;
    }
  }

  const threshold = Math.max(5, Math.floor(target.length * 0.8));
  return minScore <= threshold ? closest : undefined;
}

export type XioArgs = Readonly<{
  passthrough: readonly string[];
  runtimeExtensionEnabled: boolean;
  allowDirty: boolean;
  allowHighRisk: boolean;
  promptOnce?: string;
  /** stdout shape for `-p` / non-interactive runs. Default text. */
  outputFormat: OutputFormat;
  resume?: ResumeRequest;
}>;

export function parseXioArgs(args: readonly string[]): XioArgs {
  const runtimeExtensionEnabled = !args.includes("--xio-fast");
  const allowDirty = args.includes("--allow-dirty");
  const allowHighRisk = args.includes("--allow-high-risk");
  const withoutFlags = args.filter(
    (arg) => arg !== "--xio-fast" && arg !== "--allow-dirty" && arg !== "--allow-high-risk",
  );
  const parsedResume = parseResumeRequest(withoutFlags);
  const remaining = parsedResume.remaining;
  let promptOnce: string | undefined;
  let outputFormat: OutputFormat = "text";
  const passthrough: string[] = [];
  const positionals: string[] = [];

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    if (arg === undefined) continue;
    if (arg === "-p" || arg === "--prompt") {
      const next = remaining[index + 1];
      if (next === undefined) {
        throw new CliUsageError(`Option '${arg}' requires an argument.\nUsage: xio -p "<prompt>"`, 2);
      }
      promptOnce = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      promptOnce = arg.slice("--prompt=".length);
      continue;
    }
    if (arg === "--output-format") {
      const next = remaining[index + 1];
      if (next === undefined) {
        throw new CliUsageError("Option '--output-format' requires an argument (\"text\" or \"stream-json\")", 2);
      }
      outputFormat = parseOutputFormat(next, "--output-format");
      index += 1;
      continue;
    }
    if (arg.startsWith("--output-format=")) {
      outputFormat = parseOutputFormat(arg.slice("--output-format=".length), "--output-format");
      continue;
    }
    if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") {
      passthrough.push(arg);
      continue;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    // Any other flag starting with - is an unknown option / unexpected flag
    const closest = findClosestOption(arg, KNOWN_FLAGS);
    const suggestion = closest ? ` Did you mean "${closest}"?` : "";
    throw new CliUsageError(
      `Unknown option / unexpected flag '${arg}'.${suggestion}\nSee 'xio --help' for available options.`,
      2,
    );
  }

  // `xio "do something"` is a one-shot task, same as -p (documented in README/help).
  const positionalPrompt = positionals.join(" ").trim();
  if (positionalPrompt.length > 0) {
    if (promptOnce !== undefined) {
      throw new CliUsageError(
        `cannot combine a positional prompt with -p/--prompt (got "${positionalPrompt}" and "${promptOnce}")`,
        2,
      );
    }
    // Leftover flags next to a positional prompt are either --help/--version
    // (ambiguous mix) or a typo — fail loudly instead of dropping either side.
    if (passthrough.length > 0) {
      throw new CliUsageError(
        `unexpected flag(s) alongside a positional prompt: ${passthrough.join(" ")} (see xio --help)`,
        2,
      );
    }
    promptOnce = positionalPrompt;
  }

  return {
    passthrough,
    runtimeExtensionEnabled,
    allowDirty,
    allowHighRisk,
    promptOnce,
    outputFormat,
    ...(parsedResume.request ? { resume: parsedResume.request } : {}),
  };
}

function parseOutputFormat(value: string | undefined, flag: string): OutputFormat {
  if (value === "text" || value === "stream-json") {
    return value;
  }
  throw new CliUsageError(`${flag} must be "text" or "stream-json" (got ${value ?? "missing"})`, 2);
}

/**
 * Prefer Ink for interactive sessions on a TTY.
 * Force Ink when measuring boot (`XIO_PERF_BOOT_EXIT` / `XIO_FORCE_INK`) so
 * headless benches still exercise the interactive boot shell path.
 */
export function shouldUseInk(
  args: Pick<XioArgs, "promptOnce">,
  streams: Readonly<{ stdinIsTTY?: boolean; stdoutIsTTY?: boolean }> = {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.promptOnce !== undefined) {
    return false;
  }
  if (env.XIO_PERF_BOOT_EXIT === "1" || env.XIO_FORCE_INK === "1") {
    return true;
  }
  return streams.stdinIsTTY === true && streams.stdoutIsTTY === true;
}
