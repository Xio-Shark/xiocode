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
    passthrough.push(arg);
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
