import { describe, expect, it } from "vitest";
import { ExtensionHost } from "../runtime/extension-host.ts";
import { applyConfiguredTheme, registerThemeCommands } from "./theme-commands.ts";
import { getActiveThemeName, setTheme, theme } from "./theme.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("theme slash command", () => {
  it("shows current theme when called without arguments", async () => {
    setTheme("groknight");
    const host = new ExtensionHost();
    registerThemeCommands({ host });

    const cmd = host.getCommand("theme");
    expect(cmd).toBeDefined();
    const output = await cmd!.handler("", host.createContext());
    expect(output).toContain("Current theme: groknight");
    expect(output).toContain("groknight, claude, minimal, nord, light");
  });

  it("switches theme in-memory and persists into configPath", async () => {
    setTheme("groknight");
    const dir = await mkdtemp(join(tmpdir(), "xiocode-theme-test-"));
    const configPath = join(dir, "config.toml");

    const host = new ExtensionHost();
    let notified = "";
    let changed = "";

    registerThemeCommands({
      host,
      configPath,
      sink: {
        notify: (msg) => {
          notified = msg;
        },
      },
      onThemeChanged: (next) => {
        changed = next;
      },
    });

    try {
      const cmd = host.getCommand("theme");
      expect(cmd).toBeDefined();
      const output = await cmd!.handler("light", host.createContext());
      expect(output).toContain('Switched theme to "light"');
      expect(getActiveThemeName()).toBe("light");
      expect(theme.accent).toBe("#2563eb");
      expect(changed).toBe("light");
      expect(notified).toBe('Theme changed to "light"');

      const saved = await readFile(configPath, "utf8");
      expect(saved).toContain('theme = "light"');
    } finally {
      setTheme("groknight");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown theme names with a friendly error", async () => {
    const host = new ExtensionHost();
    registerThemeCommands({ host });

    const cmd = host.getCommand("theme");
    expect(cmd).toBeDefined();
    await expect(cmd!.handler("cyberpunk", host.createContext())).rejects.toThrow(
      'unknown theme: "cyberpunk". Available themes: groknight, claude, minimal, nord, light',
    );
  });

  it("says the theme was not saved when config.toml cannot be written", async () => {
    setTheme("groknight");
    const dir = await mkdtemp(join(tmpdir(), "xiocode-theme-test-"));
    const host = new ExtensionHost();
    // A directory where the file should be: the write fails.
    registerThemeCommands({ host, configPath: dir });
    try {
      const output = await host.getCommand("theme")!.handler("nord", host.createContext());
      expect(output).toContain('Switched theme to "nord"');
      expect(output).toContain("Not saved: could not write config.toml");
      expect(output).not.toContain("Saved [ui] theme");
      expect(getActiveThemeName()).toBe("nord");
    } finally {
      setTheme("groknight");
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("applyConfiguredTheme", () => {
  it("applies the saved theme unless XIO_THEME is set, and warns about unknown names", () => {
    try {
      setTheme("groknight");
      expect(applyConfiguredTheme("Light", {})).toBeUndefined();
      expect(getActiveThemeName()).toBe("light");

      setTheme("groknight");
      expect(applyConfiguredTheme("light", { XIO_THEME: "nord" })).toBeUndefined();
      expect(getActiveThemeName()).toBe("groknight");

      expect(applyConfiguredTheme("cyberpunk", {})).toContain('[ui] theme = "cyberpunk" is not a known theme');
      expect(getActiveThemeName()).toBe("groknight");
      expect(applyConfiguredTheme(undefined, {})).toBeUndefined();
    } finally {
      setTheme("groknight");
    }
  });
});
