/**
 * XioCode Web Console - Modern Minimalist Warm Light UI.
 * Backed by modular frontend sources in src/web/frontend/ and compiled bundle.
 */

import { getWebUiHtml, getClientScript } from "./ui-bundle.ts";

export function renderWebUiHtml(options: { version: string; defaultSessionId?: string }): string {
  return getWebUiHtml(options);
}

export function renderUiScript(options?: { defaultSessionId?: string }): string {
  const script = getClientScript();
  if (options?.defaultSessionId) {
    return script.replace(/const DEFAULT_SESSION_ID = "";/, `const DEFAULT_SESSION_ID = "${options.defaultSessionId}";`);
  }
  return script;
}
