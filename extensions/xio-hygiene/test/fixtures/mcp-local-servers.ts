/**
 * Local SSE / Streamable-HTTP MCP fixture servers for offline tests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import type { Server } from "node:http";
import type { Request, Response } from "express";

function createEchoServer(name: string): McpServer {
  const server = new McpServer({ name, version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: `Echo via ${name}`,
      inputSchema: {
        text: z.string().describe("Text to echo"),
      },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `${name}:${text}` }],
    }),
  );
  return server;
}

export type LocalMcpFixture = Readonly<{
  url: string;
  close: () => Promise<void>;
}>;

export async function startHttpMcpFixture(): Promise<LocalMcpFixture> {
  const app = createMcpExpressApp({ host: "127.0.0.1" });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createEchoServer("fixture-http");
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = await listen(app);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind http fixture");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => closeServer(httpServer),
  };
}

export async function startSseMcpFixture(): Promise<LocalMcpFixture> {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const transports = new Map<string, SSEServerTransport>();

  app.get("/mcp", async (_req: Request, res: Response) => {
    try {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      const server = createEchoServer("fixture-sse");
      await server.connect(transport);
    } catch {
      if (!res.headersSent) {
        res.status(500).send("SSE fixture error");
      }
    }
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    if (!sessionId) {
      res.status(400).send("Missing sessionId");
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).send("Error handling message");
      }
    }
  });

  const httpServer = await listen(app);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind sse fixture");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => closeServer(httpServer),
  };
}

function listen(app: ReturnType<typeof createMcpExpressApp>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
