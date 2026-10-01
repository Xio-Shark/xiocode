import { readFile, writeFile } from "node:fs/promises";
import { upsertUiTheme } from "../cli/config-mutate.ts";
import { t } from "../i18n/messages.ts";
import { resolveConfigPath } from "../cli/ensure-config.ts";
import type { ExtensionHost } from "../runtime/extension-host.ts";
import type { SessionUiSink } from "../runtime/session-ui.ts";
import {
  checkThemeBackgroundMismatch,
  getActiveThemeName,
  queryTerminalBackground,
  setTheme,
  THEME_NAMES,
  type TerminalBackground,
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
          t("theme.current", { current, names: THEME_NAMES.join(", ") }),
          t("theme.tip"),
          ...(options.env?.XIO_THEME ? [t("theme.envOverrides", { value: options.env.XIO_THEME })] : []),
        ].join("\n");
      }

      if (!THEME_NAMES.includes(raw as ThemeName)) {
        throw new Error(t("theme.unknown", { name: raw, names: THEME_NAMES.join(", ") }));
      }

      const nextTheme = raw as ThemeName;
      setTheme(nextTheme);
      options.onThemeChanged?.(nextTheme);
      options.sink?.notify?.(t("theme.changed", { name: nextTheme }), "info");

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
        saved = t("theme.saved", { name: nextTheme });
      } catch (error) {
        saved = t("theme.notSaved", { error: error instanceof Error ? error.message : String(error) });
      }

      const env = options.env?.XIO_THEME ? t("theme.envNote", { value: options.env.XIO_THEME }) : "";
      return t("theme.switched", { name: nextTheme, saved, env });
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
    return t("theme.unknownSaved", { value: saved, names: THEME_NAMES.join(", ") });
  }
  setTheme(name as ThemeName);
  return undefined;
}

export type StartupTheme = Readonly<{
  warnings: readonly string[];
  /** Keys typed while the background query held stdin. */
  typed: string;
}>;

/**
 * Pick the theme before the first paint: XIO_THEME, else the saved [ui] theme,
 * else `light` when the terminal reports a light background (dark otherwise).
 * A saved or env theme that does not suit the detected background is kept, with one warning.
 */
export async function applyStartupTheme(
  saved: string | undefined,
  env: NodeJS.ProcessEnv,
  query: () => Promise<TerminalBackground> = () => queryTerminalBackground({ env }),
): Promise<StartupTheme> {
  const warnings: string[] = [];
  const savedWarning = applyConfiguredTheme(saved, env);
  if (savedWarning) warnings.push(savedWarning);
  const chosen = Boolean(env.XIO_THEME) || (saved !== undefined && !savedWarning);

  const { background, typed } = await query();
  if (background === undefined) return { warnings, typed };
  if (!chosen) {
    if (background === "light") setTheme("light");
    return { warnings, typed };
  }
  const mismatch = checkThemeBackgroundMismatch(getActiveThemeName(), background === "light");
  if (mismatch) warnings.push(mismatch);
  return { warnings, typed };
}
