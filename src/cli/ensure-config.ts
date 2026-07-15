import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG_TOML } from "./default-config.ts";
import { expandHome } from "./config-parser.ts";
import { formatRecommendedCliToolsNotice } from "../runtime/tools/search-backend.ts";

export type EnsureConfigResult = Readonly<{
  path: string;
  created: boolean;
  content: string;
}>;

export async function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return expandHome(env.XIO_CONFIG ?? path.join(os.homedir(), ".xiocode", "config.toml"));
}

/** Read config.toml; create the default template once if missing. */
export async function ensureConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ write?: (chunk: string) => void }> = {},
): Promise<EnsureConfigResult> {
  const configPath = await resolveConfigPath(env);
  try {
    const content = await readFile(configPath, "utf8");
    return { path: configPath, created: false, content };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, DEFAULT_CONFIG_TOML, { encoding: "utf8", mode: 0o600 });
  const write = options.write ?? writeStderr;
  write(
    `Created ${configPath}\n`
      + "Set your provider API key env (default: DEEPSEEK_API_KEY), then re-run `xio` in a git repo.\n"
      + "\n"
      + await formatRecommendedCliToolsNotice(),
  );
  return { path: configPath, created: true, content: DEFAULT_CONFIG_TOML };
}

function writeStderr(chunk: string): void {
  process.stderr.write(chunk);
}
