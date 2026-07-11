#!/usr/bin/env node
/**
 * Offline stdio MCP fixture: exposes an `echo` tool.
 * Used by xio-hygiene MCP client tests (no public network).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture-stdio", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo text back with a fixture prefix",
    inputSchema: {
      text: z.string().describe("Text to echo"),
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `fixture-echo:${text}` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
