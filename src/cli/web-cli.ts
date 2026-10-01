import { execFile } from "node:child_process";
import { startWebServer } from "../web/server.ts";

export type WebCliOptions = Readonly<{
  port?: number;
  host?: string;
  open?: boolean;
}>;

function parsePort(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535 || String(parsed) !== value.trim()) {
    throw new Error(`Invalid ${flag}: "${value}". Port must be an integer between 1 and 65535.`);
  }
  return parsed;
}

export function parseWebCliArgs(args: readonly string[]): WebCliOptions {
  let port: number | undefined;
  let host: string | undefined;
  let open = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--port" && args[i + 1]) {
      port = parsePort(args[i + 1]!, "--port");
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length), "--port");
      continue;
    }
    if (arg === "--host" && args[i + 1]) {
      host = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
  }

  return { port, host, open };
}

export async function runWebCli(rawArgs: readonly string[]): Promise<number> {
  const options = parseWebCliArgs(rawArgs);
  const cwd = process.cwd();

  try {
    const handle = await startWebServer({
      port: options.port ?? 3080,
      host: options.host ?? "127.0.0.1",
      cwd,
      env: process.env,
    });

    process.stdout.write("\n");
    process.stdout.write("  \x1b[36m🦈 XioCode Web Console\x1b[0m\n");
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
    process.stderr.write(`Failed to start Web Console: ${err instanceof Error ? err.message : String(err)}\n`);
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
