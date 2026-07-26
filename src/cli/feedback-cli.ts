import { spawn } from "node:child_process";

import { XIO_VERSION } from "./version.ts";

/**
 * `xio feedback` — the manual replacement for telemetry.
 *
 * XioCode ships no telemetry (see the local-first promise in the README), so
 * the only signal is what users say out loud. This command removes the friction
 * from saying it: the right URL, what to attach, and an offer to open it.
 */
const REPO_URL = "https://github.com/Xio-Shark/xiocode";
const BUG_URL = `${REPO_URL}/issues/new?template=bug_report.yml`;
const FEATURE_URL = `${REPO_URL}/issues/new?template=feature_request.yml`;
const DISCUSSIONS_URL = `${REPO_URL}/discussions`;

export type FeedbackKind = "bug" | "feature" | "discussion";

export type FeedbackCliOptions = Readonly<{
  write?: (chunk: string) => void;
  /** Injected for tests; defaults to the platform's URL opener. */
  open?: (url: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}>;

export async function runFeedbackCli(
  args: readonly string[],
  options: FeedbackCliOptions = {},
): Promise<number> {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));

  if (args.includes("--help") || args.includes("-h")) {
    write(feedbackHelp());
    return 0;
  }

  const kind = resolveKind(args);
  const url = urlFor(kind);

  write(`XioCode ${XIO_VERSION} — feedback\n\n`);
  write("XioCode collects no telemetry, so user reports are the only signal.\n");
  write("Everything below is manual and public — nothing is sent from here.\n\n");
  write(`  Bug report      ${BUG_URL}\n`);
  write(`  Feature request ${FEATURE_URL}\n`);
  write(`  Question / chat ${DISCUSSIONS_URL}\n\n`);

  if (kind === "bug") {
    write("Before filing a bug, run `xio doctor` and paste the output — it covers\n");
    write("Node, config, keys and provider connectivity, and contains no API keys.\n\n");
  }

  if (args.includes("--no-open")) {
    write(`Open manually: ${url}\n`);
    return 0;
  }

  const opened = openUrl(url, options);
  write(opened
    ? `Opening ${url}\n`
    : `Open this in your browser: ${url}\n`);
  return 0;
}

function resolveKind(args: readonly string[]): FeedbackKind {
  if (args.includes("--bug")) return "bug";
  if (args.includes("--feature")) return "feature";
  return "discussion";
}

function urlFor(kind: FeedbackKind): string {
  if (kind === "bug") return BUG_URL;
  if (kind === "feature") return FEATURE_URL;
  return DISCUSSIONS_URL;
}

/**
 * Best-effort browser open. A headless box, SSH session or missing opener is
 * expected, not an error — the URL is always printed either way.
 */
function openUrl(url: string, options: FeedbackCliOptions): boolean {
  if (options.open) {
    options.open(url);
    return true;
  }
  const env = options.env ?? process.env;
  if (env.CI || env.XIO_NO_BROWSER === "1") return false;
  const platform = options.platform ?? process.platform;
  const command = platform === "darwin"
    ? "open"
    : platform === "win32"
      ? "explorer"
      : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function feedbackHelp(): string {
  return [
    "xio feedback — report a bug, request a feature, or ask a question",
    "",
    "Usage:",
    "  xio feedback              Show every channel and open Discussions",
    "  xio feedback --bug        Open the bug report form (attach `xio doctor`)",
    "  xio feedback --feature    Open the feature request form",
    "  xio feedback --no-open    Print URLs only; never launch a browser",
    "",
    "XioCode sends no telemetry. Nothing is transmitted by this command.",
    "",
  ].join("\n");
}
