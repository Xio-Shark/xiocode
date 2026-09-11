#!/usr/bin/env node
/**
 * Capability probe: can `browser_click` actually click on the target page?
 *
 * Navigates with the extension bridge (real logged-in Chrome), finds a match,
 * then clicks it and reports whether Playwright's actionability check passed and
 * whether a new tab appeared. Exists because a model-reported click timeout is
 * otherwise indistinguishable from a model usage mistake.
 *
 * Usage: node scripts/mcp-click-probe.mjs [default|15s] [url] [findText]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2] ?? "default";
const url = process.argv[3] ?? "https://github.com/notifications";
const findText = process.argv[4] ?? "CI workflow run failed for main branch";
const timeoutArgs = mode === "15s" ? ["--timeout-action", "15000"] : [];

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--extension", "--browser", "chrome", ...timeoutArgs],
  stderr: "ignore",
});
const client = new Client({ name: "xiocode-click-probe", version: "0.0.0" });

const textOf = (result) =>
  (result?.content ?? []).map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join("\n");

await (async () => {
  try {
    await client.connect(transport);
    const nav = await client.callTool({ name: "browser_navigate", arguments: { url } });
    if (nav.isError === true) {
      console.log(JSON.stringify({ step: "navigate", ok: false, text: textOf(nav).slice(0, 200) }));
      return;
    }

    const find = await client.callTool({ name: "browser_find", arguments: { text: findText } });
    const findText2 = textOf(find);
    const ref = /link \[ref=(f\d+e\d+)\]/.exec(findText2)?.[1]
      ?? /\[ref=(f\d+e\d+)\]/.exec(findText2)?.[1];
    console.log(JSON.stringify({ step: "find", ok: ref !== undefined, ref: ref ?? null, chars: findText2.length }));

    const clickStart = Date.now();
    const click = await client.callTool({
      name: "browser_click",
      arguments: { element: "first notification link", target: ref },
    });
    const clickMs = Date.now() - clickStart;
    console.log(JSON.stringify({
      step: "click",
      mode,
      ok: click.isError !== true,
      ms: clickMs,
      error: click.isError === true ? textOf(click).split("\n").slice(0, 4).join(" ").slice(0, 240) : undefined,
    }));

    const tabs = await client.callTool({ name: "browser_tabs", arguments: { action: "list" } });
    console.log(JSON.stringify({ step: "tabs", text: textOf(tabs).split("\n").slice(0, 6).join(" | ") }));
  } catch (error) {
    console.log(JSON.stringify({ step: "probe", ok: false, error: error instanceof Error ? error.message : String(error) }));
  } finally {
    await client.close().catch(() => undefined);
  }
})();
