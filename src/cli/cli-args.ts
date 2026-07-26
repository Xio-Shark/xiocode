import { parseResumeRequest } from "./session-resume.ts";

import type { ResumeRequest } from "./session-resume.ts";

export type OutputFormat = "text" | "stream-json";

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
      promptOnce = remaining[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      promptOnce = arg.slice("--prompt=".length);
      continue;
    }
    if (arg === "--output-format") {
      outputFormat = parseOutputFormat(remaining[index + 1], "--output-format");
      index += 1;
      continue;
    }
    if (arg.startsWith("--output-format=")) {
      outputFormat = parseOutputFormat(arg.slice("--output-format=".length), "--output-format");
      continue;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    passthrough.push(arg);
  }
  // `xio "do something"` is a one-shot task, same as -p (documented in README/help).
  const positionalPrompt = positionals.join(" ").trim();
  if (positionalPrompt.length > 0) {
    if (promptOnce !== undefined) {
      throw new Error(
        `cannot combine a positional prompt with -p/--prompt (got "${positionalPrompt}" and "${promptOnce}")`,
      );
    }
    // Leftover flags next to a positional prompt are either --help/--version
    // (ambiguous mix) or a typo — fail loudly instead of dropping either side.
    if (passthrough.length > 0) {
      throw new Error(
        `unexpected flag(s) alongside a positional prompt: ${passthrough.join(" ")} (see xio --help)`,
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
  throw new Error(`${flag} must be "text" or "stream-json" (got ${value ?? "missing"})`);
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
