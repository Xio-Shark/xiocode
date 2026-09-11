#!/usr/bin/env node
/**
 * Measure the resident tool-block cost of an MCP stdio server.
 *
 * Usage: node scripts/mcp-tool-inventory.mjs -- <command> [args...]
 * Example: node scripts/mcp-tool-inventory.mjs -- npx -y @playwright/mcp@latest
 *
 * Prints one line of JSON: tool count, aggregate description/schema characters
 * and per-tool name + description cost. Read-only: it never calls a tool.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const separator = process.argv.indexOf("--");
const argv = separator === -1 ? [] : process.argv.slice(separator + 1);
if (argv.length === 0) {
  console.error("usage: node scripts/mcp-tool-inventory.mjs -- <command> [args...]");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: argv[0],
  args: argv.slice(1),
  stderr: "ignore",
});
const client = new Client({ name: "xiocode-tool-inventory", version: "0.0.0" });

let exitCode = 0;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  let descriptionChars = 0;
  let schemaChars = 0;
  const rows = tools.map((tool) => {
    const description = tool.description ?? "";
    const schema = JSON.stringify(tool.inputSchema ?? {});
    descriptionChars += description.length;
    schemaChars += schema.length;
    return {
      name: tool.name,
      descriptionChars: description.length,
      schemaChars: schema.length,
    };
  });
  console.log(
    JSON.stringify(
      {
        command: argv.join(" "),
        toolCount: tools.length,
        descriptionChars,
        schemaChars,
        totalChars: descriptionChars + schemaChars,
        tools: rows.sort((a, b) => b.schemaChars - a.schemaChars),
      },
      null,
      2,
    ),
  );
} catch (error) {
  exitCode = 1;
  console.error(`mcp-tool-inventory failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
