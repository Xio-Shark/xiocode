/**
 * XioCode Web Console - Modern Minimalist Warm Light UI.
 * Modular entry combining styles, markup, and client script.
 */

import { UI_STYLES } from "./ui-styles.ts";
import { renderUiMarkup } from "./ui-markup.ts";
import { renderUiScript } from "./ui-script.ts";

export function renderWebUiHtml(options: { version: string; defaultSessionId?: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XioCode 控制台</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
${UI_STYLES}
  </style>
</head>
<body>
${renderUiMarkup()}
  <script>
${renderUiScript(options)}
  </script>
</body>
</html>`;
}
