import { parseResumeRequest } from "./session-resume.ts";

import type { ResumeRequest } from "./session-resume.ts";

export type XioArgs = Readonly<{
  passthrough: readonly string[];
  runtimeExtensionEnabled: boolean;
  promptOnce?: string;
  resume?: ResumeRequest;
}>;

export function parseXioArgs(args: readonly string[]): XioArgs {
  const runtimeExtensionEnabled = !args.includes("--xio-fast");
  const parsedResume = parseResumeRequest(args.filter((arg) => arg !== "--xio-fast"));
  const remaining = parsedResume.remaining;
  let promptOnce: string | undefined;
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
    passthrough.push(arg);
  }
  return {
    passthrough,
    runtimeExtensionEnabled,
    promptOnce,
    ...(parsedResume.request ? { resume: parsedResume.request } : {}),
  };
}

export function shouldUseInk(
  args: Pick<XioArgs, "promptOnce">,
  streams: Readonly<{ stdinIsTTY?: boolean; stdoutIsTTY?: boolean }> = {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  },
): boolean {
  return args.promptOnce === undefined && streams.stdinIsTTY === true && streams.stdoutIsTTY === true;
}
