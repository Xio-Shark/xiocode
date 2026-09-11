#!/usr/bin/env node
/**
 * One-shot probe for the extension bridge (--extension).
 *
 * Unlike scripts/mcp-browser-smoke.mjs this connects to the *running* Chrome via
 * the Playwright Extension, so it uses the real logged-in profile. It only lists
 * tabs — it never navigates, clicks, or types, and it leaves no tab behind.
 *
 * Usage: node scripts/mcp-extension-probe.mjs [--action tabs|snapshot]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const actionIndex = process.argv.indexOf("--action");
const action = actionIndex === -1 ? "tabs" : process.argv[actionIndex + 1];

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--extension", "--browser", "chrome"],
  stderr: "ignore",
});
const client = new Client({ name: "xiocode-extension-probe", version: "0.0.0" });

const textOf = (result) =>
  (result?.content ?? []).map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join("\n");

let exitCode = 0;
try {
  const t0 = Date.now();
  await client.connect(transport);
  const { tools } = await client.listTools();
  const connectMs = Date.now() - t0;

  const callStart = Date.now();
  const result =
    action === "snapshot"
      ? await client.callTool({ name: "browser_snapshot", arguments: {} })
      : await client.callTool({ name: "browser_tabs", arguments: { action: "list" } });
  const callMs = Date.now() - callStart;

  console.log(
    JSON.stringify(
      {
        bridge: "--extension --browser chrome",
        connectMs,
        toolCount: tools.length,
        action,
        callMs,
        isError: result.isError === true,
        text: textOf(result).slice(0, 1200),
      },
      null,
      2,
    ),
  );
} catch (error) {
  exitCode = 1;
  console.error(`extension probe failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
