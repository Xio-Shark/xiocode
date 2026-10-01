/**
 * Interface copy for the TUI and the web console, in Chinese (default) and English.
 *
 * `zh.ts` defines the keys; `en.ts` is typed as `Messages`, so a key added on one side
 * only fails type checking until the other side has it too. Both front ends use
 * the same keys: the TUI calls `t()`, the web page receives `webMessages()` at page
 * assembly. Model output, tool output and messages addressed to the model are not
 * interface copy and are never translated.
 */

import { en } from "./en.ts";
import { zh } from "./zh.ts";

export type MessageKey = keyof typeof zh;
export type Messages = Readonly<Record<MessageKey, string>>;

export const LANGUAGES = ["zh", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

const TABLES: Readonly<Record<Language, Messages>> = { zh, en };

let active: Language = "zh";

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Pick the interface language from config.toml `[ui] language`. Returns a warning
 * (in the default language) when the value is not one of {@link LANGUAGES}.
 */
export function applyConfiguredLanguage(saved: string | undefined): string | undefined {
  if (saved === undefined) {
    active = "zh";
    return undefined;
  }
  const value = saved.trim().toLowerCase();
  if (!isLanguage(value)) {
    active = "zh";
    return format(zh["config.unknownLanguage"], { value: saved, known: LANGUAGES.join(", ") });
  }
  active = value;
  return undefined;
}

/** For keys built at run time (`slash.<name>`); narrows to a known key. */
export function hasMessage(key: string): key is MessageKey {
  return key in zh;
}

export function getLanguage(): Language {
  return active;
}

export function setLanguage(language: Language): void {
  active = language;
}

export type MessageVars = Readonly<Record<string, string | number>>;

/** `{name}` placeholders are filled from `vars`; a missing var is left visible, not blanked. */
function format(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function t(key: MessageKey, vars?: MessageVars, language: Language = active): string {
  return format(TABLES[language][key], vars);
}

/** The `web.*` and `common.*` keys of one language, for the web page's `t()`. */
export function webMessages(language: Language): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(TABLES[language]).filter(([key]) => key.startsWith("web.") || key.startsWith("common.")),
  );
}
