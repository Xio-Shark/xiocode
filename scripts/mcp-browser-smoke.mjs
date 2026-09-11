#!/usr/bin/env node
/**
 * End-to-end smoke for a browser MCP driver: spawn the server, navigate to a
 * public page, take an accessibility snapshot, print timing + snapshot size.
 *
 * Uses a throwaway headless profile, so it proves the tool surface works
 * without touching the user's real browser session or the extension bridge.
 *
 * Usage: node scripts/mcp-browser-smoke.mjs [url]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.argv[2] ?? "https://example.com";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated", "--caps", "core"],
  stderr: "ignore",
});
const client = new Client({ name: "xiocode-browser-smoke", version: "0.0.0" });

const textOf = (result) =>
  (result?.content ?? [])
    .map((part) => (part.type === "text" ? part.text : `<${part.type}>`))
    .join("\n");

let exitCode = 0;
try {
  const connectStart = Date.now();
  await client.connect(transport);
  const { tools } = await client.listTools();
  const connectMs = Date.now() - connectStart;
  const names = tools.map((tool) => tool.name);
  const navigateName = names.find((name) => name.endsWith("_navigate")) ?? names.find((name) => name.includes("navigate"));
  const snapshotName = names.find((name) => name.endsWith("_snapshot")) ?? names.find((name) => name.includes("snapshot"));
  if (!navigateName || !snapshotName) {
    throw new Error(`expected navigate+snapshot tools, got: ${names.join(",")}`);
  }

  const navStart = Date.now();
  const navResult = await client.callTool({ name: navigateName, arguments: { url } });
  const navigateMs = Date.now() - navStart;

  const snapStart = Date.now();
  const snapResult = await client.callTool({ name: snapshotName, arguments: {} });
  const snapshotMs = Date.now() - snapStart;

  const snapshotText = textOf(snapResult);
  console.log(
    JSON.stringify(
      {
        url,
        toolCount: tools.length,
        connectMs,
        navigate: { tool: navigateName, ms: navigateMs, isError: navResult.isError === true, text: textOf(navResult).slice(0, 300) },
        snapshot: { tool: snapshotName, ms: snapshotMs, isError: snapResult.isError === true, chars: snapshotText.length },
        snapshotHead: snapshotText.slice(0, 400),
      },
      null,
      2,
    ),
  );
} catch (error) {
  exitCode = 1;
  console.error(`browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
