import { execFile } from "node:child_process";

import { refreshPriceCatalog } from "../runtime/pricing-catalog.ts";
import { startWebServer } from "../web/server.ts";
import { CliUsageError, findClosestOption } from "./cli-args.ts";

/** First port tried when --port is omitted. */
const DEFAULT_PORT = 3080;
/** Consecutive ports scanned from DEFAULT_PORT before giving up; only for the implicit default. */
const DEFAULT_PORT_ATTEMPTS = 10;

const WEB_FLAGS = ["--port", "--host", "--no-open", "--strict-port"] as const;

export const WEB_USAGE = "Usage: xio web [--port <n>] [--host <addr>] [--no-open] [--strict-port]";

export type WebCliOptions = Readonly<{
  port?: number;
  host?: string;
  open?: boolean;
  /** Refuse to fall back to another port when the default one is taken. */
  strictPort?: boolean;
}>;

/** How the CLI should bind, decided once from flags (kept pure so it is testable). */
export type WebBinding = Readonly<{
  port: number;
  portAttempts: number;
  source: "default" | "strict" | "explicit";
}>;

function parsePort(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535 || String(parsed) !== value.trim()) {
    throw new CliUsageError(
      `Invalid ${flag}: "${value}". Port must be an integer between 0 and 65535 (0 lets the OS pick a free port).\n${WEB_USAGE}`,
    );
  }
  return parsed;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`Option '${flag}' requires a value.\n${WEB_USAGE}`);
  }
  return value;
}

export function parseWebCliArgs(args: readonly string[]): WebCliOptions {
  let port: number | undefined;
  let host: string | undefined;
  let open = true;
  let strictPort = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--strict-port") {
      strictPort = true;
      continue;
    }
    if (arg === "--port") {
      port = parsePort(requireValue(args, i, "--port"), "--port");
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length), "--port");
      continue;
    }
    if (arg === "--host") {
      host = requireValue(args, i, "--host");
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    const closest = findClosestOption(arg, WEB_FLAGS);
    const suggestion = closest ? ` Did you mean "${closest}"?` : "";
    throw new CliUsageError(`Unknown option for 'xio web': '${arg}'.${suggestion}\n${WEB_USAGE}`);
  }

  return { port, host, open, strictPort };
}

/**
 * Default port falls back to the next free one (Vite/Next behaviour); an explicit
 * `--port` or `--strict-port` is a contract and fails instead of drifting.
 */
export function planWebBinding(options: WebCliOptions): WebBinding {
  if (options.port !== undefined) {
    return { port: options.port, portAttempts: 1, source: "explicit" };
  }
  if (options.strictPort) {
    return { port: DEFAULT_PORT, portAttempts: 1, source: "strict" };
  }
  return { port: DEFAULT_PORT, portAttempts: DEFAULT_PORT_ATTEMPTS, source: "default" };
}

export function describePortFallback(requested: number, actual: number): string {
  return `Port ${requested} is in use, using ${actual}.`;
}

/** One-line diagnosis for a failed bind, with the flag that unblocks the user. */
export function describeStartFailure(error: unknown, binding: WebBinding): string {
  const detail = error instanceof Error ? error.message : String(error);
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE") {
    return `Failed to start Web Console: ${detail}`;
  }
  const lastPort = Math.min(binding.port + binding.portAttempts - 1, 65535);
  const reason =
    binding.portAttempts > 1
      ? `no free port between ${binding.port} and ${lastPort} (all in use)`
      : `port ${binding.port} is already in use`;
  const hint =
    binding.source === "strict"
      ? "Drop --strict-port to fall back automatically, or pass --port 0 / --port <n>."
      : binding.source === "explicit"
        ? "Use --port 0 to let the OS pick one, or choose another --port."
        : "Use --port 0 to let the OS pick one.";
  return `Failed to start Web Console: ${reason}. ${hint}`;
}

export async function runWebCli(rawArgs: readonly string[]): Promise<number> {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(`${WEB_USAGE}\n`);
    return 0;
  }

  let options: WebCliOptions;
  try {
    options = parseWebCliArgs(rawArgs);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }

  const binding = planWebBinding(options);
  const cwd = process.cwd();

  // Usage-view prices: cache-first, so an offline start still shows the last catalog.
  void refreshPriceCatalog({ env: process.env });

  try {
    const handle = await startWebServer({
      port: binding.port,
      portAttempts: binding.portAttempts,
      host: options.host ?? "127.0.0.1",
      cwd,
      env: process.env,
    });

    process.stdout.write("\n");
    process.stdout.write("  \x1b[36m🦈 XioCode Web Console\x1b[0m\n");
    if (binding.port !== 0 && handle.port !== binding.port) {
      process.stdout.write(`  \x1b[33m➜\x1b[0m  Note:    \x1b[33m${describePortFallback(binding.port, handle.port)}\x1b[0m\n`);
    }
    // The token in this link is the only way in; keep it out of shared screenshots.
    process.stdout.write(`  \x1b[32m➜\x1b[0m  Open:    \x1b[1m\x1b[36m${handle.launchUrl}\x1b[0m\n`);
    process.stdout.write(`  \x1b[32m➜\x1b[0m  Root:    \x1b[90m${cwd}\x1b[0m\n`);
    process.stdout.write("  \x1b[90mReady for interactive pairing. Press Ctrl+C to stop.\x1b[0m\n\n");

    if (options.open) {
      openBrowser(handle.launchUrl);
    }

    // Keep running until SIGINT
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        process.stdout.write("\nStopping Web Console...\n");
        handle.close().then(() => resolve());
      });
      process.on("SIGTERM", () => {
        handle.close().then(() => resolve());
      });
    });

    return 0;
  } catch (err) {
    process.stderr.write(`${describeStartFailure(err, binding)}\n`);
    return 1;
  }
}

export function getOpenBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === "darwin") {
    return { file: "open", args: [url] };
  }
  if (platform === "win32") {
    return { file: "cmd.exe", args: ["/c", "start", "", url] };
  }
  return { file: "xdg-open", args: [url] };
}

export function openBrowser(url: string): void {
  const { file, args } = getOpenBrowserCommand(url);
  execFile(file, args, () => {
    // ignore open errors in headless / CI environments
  });
}
