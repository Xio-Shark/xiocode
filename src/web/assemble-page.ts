/**
 * Turns the console's source files (src/web/frontend) into one self-contained
 * page: every `<link rel="stylesheet" href>` and `<script src>` in index.html
 * is replaced by the file's contents, so the console needs no network and no
 * static-file routes. index.html is the only place the document head lives.
 */

export type FrontendFiles = Readonly<Record<string, string>>;

const STYLESHEET = /<link rel="stylesheet" href="([^"]+)">/g;
const SCRIPT = /<script src="([^"]+)"><\/script>/g;

/** Script files in load order, as index.html references them. */
export function scriptNames(markup: string): string[] {
  return [...markup.matchAll(SCRIPT)].map((m) => m[1]!);
}

export function inlinePage(files: FrontendFiles): string {
  const markup = need(files, "index.html");
  return markup
    .replace(STYLESHEET, (_, name: string) => `<style>\n${need(files, name)}\n</style>`)
    .replace(SCRIPT, (_, name: string) => `<script>\n${need(files, name)}\n</script>`);
}

export function inlineScripts(files: FrontendFiles): string {
  return scriptNames(need(files, "index.html")).map((name) => need(files, name)).join("\n");
}

/** Values the server knows at request time; the client reads them from these constants. */
export function personalize(source: string, options: Readonly<{ version: string; defaultSessionId?: string }>): string {
  return source
    .replaceAll("__VERSION__", options.version)
    .replace('const DEFAULT_SESSION_ID = "";', `const DEFAULT_SESSION_ID = ${JSON.stringify(options.defaultSessionId ?? "")};`);
}

function need(files: FrontendFiles, name: string): string {
  const content = files[name];
  if (content === undefined) throw new Error(`web console: index.html references ${name}, which is not in src/web/frontend`);
  return content;
}
