import { exec } from "node:child_process";
import { startWebServer } from "../web/server.ts";

export type WebCliOptions = Readonly<{
  port?: number;
  host?: string;
  open?: boolean;
}>;

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
      port = Number.parseInt(args[i + 1]!, 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = Number.parseInt(arg.slice("--port=".length), 10);
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
    process.stdout.write(`  \x1b[32m➜\x1b[0m  Local:   \x1b[1m\x1b[36m${handle.url}\x1b[0m\n`);
    process.stdout.write(`  \x1b[32m➜\x1b[0m  Root:    \x1b[90m${cwd}\x1b[0m\n`);
    process.stdout.write("  \x1b[90mReady for interactive pairing. Press Ctrl+C to stop.\x1b[0m\n\n");

    if (options.open) {
      openBrowser(handle.url);
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

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin"
    ? `open "${url}"`
    : process.platform === "win32"
      ? `start "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {
    // ignore open errors in headless / CI environments
  });
}
