/**
 * Turns the console's source files (src/web/frontend) into one self-contained
 * page: every `<link rel="stylesheet" href>` and `<script src>` in index.html
 * is replaced by the file's contents, so the console needs no network and no
 * static-file routes. index.html is the only place the document head lives.
 * The brand colour tokens (src/design/tokens.ts) replace the stylesheet's
 * `@design-tokens` marker comment, so the TUI and the page share one palette.
 */

import { cssTokenDeclarations } from "../design/tokens.ts";
import { webMessages, type Language } from "../i18n/messages.ts";

export type FrontendFiles = Readonly<Record<string, string>>;

const STYLESHEET = /<link rel="stylesheet" href="([^"]+)">/g;
const SCRIPT = /<script src="([^"]+)"><\/script>/g;
const TOKENS_MARKER = "  /* @design-tokens */";

/** Script files in load order, as index.html references them. */
export function scriptNames(markup: string): string[] {
  return [...markup.matchAll(SCRIPT)].map((m) => m[1]!);
}

export function inlinePage(files: FrontendFiles): string {
  const markup = need(files, "index.html");
  return markup
    .replace(STYLESHEET, (_, name: string) => `<style>\n${withTokens(need(files, name))}\n</style>`)
    .replace(SCRIPT, (_, name: string) => `<script>\n${need(files, name)}\n</script>`);
}

export function inlineScripts(files: FrontendFiles): string {
  return scriptNames(need(files, "index.html")).map((name) => need(files, name)).join("\n");
}

export type PageOptions = Readonly<{ version: string; defaultSessionId?: string; language?: Language }>;

/**
 * Values the server knows at request time: the version, the session to open, and the
 * interface copy (`{{t:web.key}}` in markup, `MESSAGES` for the scripts' `t()`).
 */
export function personalize(source: string, options: PageOptions): string {
  const language = options.language ?? "zh";
  const messages = webMessages(language);
  return source
    .replaceAll("__VERSION__", options.version)
    .replace('const DEFAULT_SESSION_ID = "";', `const DEFAULT_SESSION_ID = ${JSON.stringify(options.defaultSessionId ?? "")};`)
    // A function replacement: "$" in a message must not be read as a replacement pattern.
    .replace("const MESSAGES = {};", () => `const MESSAGES = ${scriptJson(messages)};`)
    .replaceAll("{{lang}}", language === "zh" ? "zh-CN" : "en")
    .replace(/\{\{t:([\w.]+)\}\}/g, (_, key: string) => {
      const text = messages[key];
      if (text === undefined) throw new Error(`web console: no message for ${key}`);
      // The rule/MCP descriptions carry <code>; everything else is plain text.
      return /<\/?code>/.test(text) ? escapeHtml(text).replace(/&lt;(\/?)code&gt;/g, "<$1code>") : escapeHtml(text);
    });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON that stays inert inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function withTokens(css: string): string {
  return css.includes(TOKENS_MARKER) ? css.replace(TOKENS_MARKER, cssTokenDeclarations()) : css;
}

function need(files: FrontendFiles, name: string): string {
  const content = files[name];
  if (content === undefined) throw new Error(`web console: index.html references ${name}, which is not in src/web/frontend`);
  return content;
}
