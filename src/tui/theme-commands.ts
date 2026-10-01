import { readFile, writeFile } from "node:fs/promises";
import { upsertUiTheme } from "../cli/config-mutate.ts";
import { resolveConfigPath } from "../cli/ensure-config.ts";
import type { ExtensionHost } from "../runtime/extension-host.ts";
import type { SessionUiSink } from "../runtime/session-ui.ts";
import {
  getActiveThemeName,
  setTheme,
  THEME_NAMES,
  type ThemeName,
} from "./theme.ts";

export type ThemeCommandOptions = Readonly<{
  host: ExtensionHost;
  sink?: SessionUiSink;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  onThemeChanged?: (theme: ThemeName) => void;
}>;

export function registerThemeCommands(options: ThemeCommandOptions): void {
  options.host.registerCommand("theme", {
    description: `View or switch TUI color theme (/theme [${THEME_NAMES.join("|")}]).`,
    group: "session",
    weight: 65,
    handler: async (args) => {
      const raw = typeof args === "string" ? args.trim().toLowerCase() : "";
      const current = getActiveThemeName();
      if (!raw) {
        return [
          `Current theme: ${current} (available: ${THEME_NAMES.join(", ")})`,
          `Tip: /theme <name> to switch and persist in config.toml [ui] theme.`,
          ...(options.env?.XIO_THEME ? [`Notice: XIO_THEME=${options.env.XIO_THEME} overrides config.`] : []),
        ].join("\n");
      }

      if (!THEME_NAMES.includes(raw as ThemeName)) {
        throw new Error(`unknown theme: "${raw}". Available themes: ${THEME_NAMES.join(", ")}`);
      }

      const nextTheme = raw as ThemeName;
      setTheme(nextTheme);
      options.onThemeChanged?.(nextTheme);
      options.sink?.notify?.(`Theme changed to "${nextTheme}"`, "info");

      // The switch already happened; a failed save is reported, not hidden, because the theme
      // would silently revert at the next start.
      let saved: string;
      try {
        const configPath = options.configPath ?? (await resolveConfigPath(options.env ?? process.env));
        let content = "";
        try {
          content = await readFile(configPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await writeFile(configPath, upsertUiTheme(content, nextTheme), "utf8");
        saved = `Saved [ui] theme = "${nextTheme}" in config.toml.`;
      } catch (error) {
        saved = `Not saved: could not write config.toml (${error instanceof Error ? error.message : String(error)}); `
          + "the theme applies to this session only.";
      }

      const envNotice = options.env?.XIO_THEME ? ` (Note: active XIO_THEME=${options.env.XIO_THEME} overrides config until unset)` : "";
      return `Switched theme to "${nextTheme}". ${saved}${envNotice}`;
    },
  });
}

/**
 * The theme saved with /theme ([ui] theme in config.toml), applied before the first TUI paint.
 * XIO_THEME still wins. Returns a warning when the saved name is not a known theme.
 */
export function applyConfiguredTheme(saved: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (env.XIO_THEME || saved === undefined) return undefined;
  const name = saved.trim().toLowerCase();
  if (!THEME_NAMES.includes(name as ThemeName)) {
    return `config.toml [ui] theme = "${saved}" is not a known theme (${THEME_NAMES.join(", ")}); using the default.`;
  }
  setTheme(name as ThemeName);
  return undefined;
}
