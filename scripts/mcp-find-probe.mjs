#!/usr/bin/env node
/**
 * Verify whether `browser_find` alone yields actionable element refs.
 *
 * Runs headless with a throwaway profile against a public page, so it proves the
 * capability without touching the user's logged-in browser.
 *
 * Usage: node scripts/mcp-find-probe.mjs [url] [query]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.argv[2] ?? "https://example.com";
const query = process.argv[3] ?? "Learn more";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
  stderr: "ignore",
});
const client = new Client({ name: "xiocode-find-probe", version: "0.0.0" });

const textOf = (result) =>
  (result?.content ?? []).map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join("\n");

let exitCode = 0;
try {
  await client.connect(transport);
  await client.callTool({
    name: "browser_navigate",
    arguments: { url },
  });

  const findStart = Date.now();
  const found = await client.callTool({
    name: "browser_find",
    arguments: { text: query },
  });
  const findMs = Date.now() - findStart;
  const findText = textOf(found);

  // Does the find result carry a usable ref?
  const ref = /\[ref=([a-z0-9]+)\]/i.exec(findText)?.[1];
  let clickResult = null;
  if (ref) {
    const clicked = await client.callTool({
      name: "browser_click",
      arguments: { element: `Learn more link`, ref },
    });
    clickResult = { isError: clicked.isError === true, text: textOf(clicked).slice(0, 300) };
  }

  console.log(
    JSON.stringify(
      {
        url,
        query,
        findMs,
        findIsError: found.isError === true,
        findChars: findText.length,
        refFromFind: ref ?? null,
        clickResult,
        findHead: findText.slice(0, 500),
      },
      null,
      2,
    ),
  );
} catch (error) {
  exitCode = 1;
  console.error(`find probe failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
