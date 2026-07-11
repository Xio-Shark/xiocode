import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ExtensionContext } from "../../xio-evolve/src/types.ts";
import type { JsonSchema, ToolDefinition, ToolExecuteResult } from "../../../src/runtime/types.ts";

export type McpConfig = Readonly<{
  enabled: boolean;
  readClaude: boolean;
  readCursor: boolean;
  /** When true, a failed server connection throws from session_start. Default false = skip + warn. */
  failClosed: boolean;
  timeoutMs: number;
  /** Xio-native servers from config.toml; override same-name entries from disk. */
  servers?: Readonly<Record<string, McpServerSpec>>;
}>;

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: true,
  readClaude: true,
  readCursor: true,
  failClosed: false,
  timeoutMs: 30_000,
};

export type McpTransportKind = "stdio" | "sse" | "http";

export type McpStdioServerSpec = Readonly<{
  transport: "stdio";
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}>;

export type McpUrlServerSpec = Readonly<{
  transport: "sse" | "http";
  url: string;
  headers?: Readonly<Record<string, string>>;
}>;

export type McpServerSpec = McpStdioServerSpec | McpUrlServerSpec;

export type McpServerSource =
  | "claude-user"
  | "cursor-user"
  | "project"
  | "config";

export type ResolvedMcpServer = Readonly<{
  name: string;
  spec: McpServerSpec;
  source: McpServerSource;
  sourcePath?: string;
}>;

export type LoadedMcpConfigs = Readonly<{
  servers: readonly ResolvedMcpServer[];
  warnings: readonly string[];
  sources: readonly string[];
}>;

export type McpConnectionStatus = Readonly<{
  name: string;
  ok: boolean;
  toolNames: readonly string[];
  error?: string;
  source: McpServerSource;
}>;

export type McpBridgeRegistration = Readonly<{
  getLoaded: () => LoadedMcpConfigs | undefined;
  getStatuses: () => readonly McpConnectionStatus[];
  getToolNames: () => readonly string[];
  close: () => Promise<void>;
}>;

export type LoadMcpConfigsOptions = Readonly<{
  cwd: string;
  home?: string;
  config: McpConfig;
  warn?: (message: string) => void;
}>;

export type RegisterMcpBridgeOptions = Readonly<{
  cwd: string;
  home?: string;
  config: McpConfig;
  registerTool: (tool: ToolDefinition) => void;
  warn?: (message: string) => void;
  /** Injectable connect for tests. */
  connectServer?: typeof connectMcpServer;
}>;

type LiveConnection = {
  name: string;
  client: Client;
  close: () => Promise<void>;
  toolNames: string[];
};

/**
 * Sanitize a segment for `mcp__<server>__<tool>` names.
 */
export function sanitizeMcpSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpSegment(server)}__${sanitizeMcpSegment(tool)}`;
}

/**
 * Load and merge MCP server configs.
 * Order (later wins): Claude user → Cursor user → project `.mcp.json` → config.toml servers.
 */
export async function loadMcpConfigs(options: LoadMcpConfigsOptions): Promise<LoadedMcpConfigs> {
  const config = options.config;
  if (!config.enabled) {
    return { servers: [], warnings: [], sources: [] };
  }

  const home = options.home ?? homedir();
  const cwd = path.resolve(options.cwd);
  const warnings: string[] = [];
  const sources: string[] = [];
  const merged = new Map<string, ResolvedMcpServer>();

  const applyFile = async (
    filePath: string,
    source: McpServerSource,
    extract: (data: unknown) => Record<string, unknown> | undefined,
  ): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      const message = `mcp: failed to read ${filePath}: ${errorMessage(error)}`;
      warnings.push(message);
      options.warn?.(message);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      const message = `mcp: invalid JSON in ${filePath}: ${errorMessage(error)}`;
      warnings.push(message);
      options.warn?.(message);
      return;
    }

    const serversTable = extract(parsed);
    if (!serversTable) {
      return;
    }

    sources.push(filePath);
    for (const [name, value] of Object.entries(serversTable)) {
      const parsedSpec = parseServerSpec(name, value, warnings, options.warn);
      if (!parsedSpec) {
        continue;
      }
      merged.set(name, {
        name,
        spec: parsedSpec,
        source,
        sourcePath: filePath,
      });
    }
  };

  if (config.readClaude) {
    await applyFile(path.join(home, ".claude.json"), "claude-user", (data) => {
      const root = asRecord(data);
      return root ? asRecord(root.mcpServers) : undefined;
    });
  }

  if (config.readCursor) {
    await applyFile(path.join(home, ".cursor", "mcp.json"), "cursor-user", (data) => {
      const root = asRecord(data);
      if (!root) {
        return undefined;
      }
      return asRecord(root.mcpServers) ?? asRecord(root.servers);
    });
  }

  await applyFile(path.join(cwd, ".mcp.json"), "project", (data) => {
    const root = asRecord(data);
    if (!root) {
      return undefined;
    }
    return asRecord(root.mcpServers) ?? asRecord(root.servers);
  });

  if (config.servers) {
    for (const [name, spec] of Object.entries(config.servers)) {
      merged.set(name, { name, spec, source: "config" });
    }
  }

  return {
    servers: [...merged.values()],
    warnings,
    sources,
  };
}

/**
 * Register MCP bridge: connect on session_start, register `mcp__*` tools, close on session_end.
 */
export function registerMcpBridge(
  ctx: ExtensionContext,
  options: RegisterMcpBridgeOptions,
): McpBridgeRegistration {
  const config = options.config;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const connect = options.connectServer ?? connectMcpServer;

  let loaded: LoadedMcpConfigs | undefined;
  let statuses: McpConnectionStatus[] = [];
  const live: LiveConnection[] = [];
  let closed = false;

  const closeAll = async (): Promise<void> => {
    closed = true;
    const pending = live.splice(0);
    await Promise.all(pending.map(async (entry) => {
      try {
        await entry.close();
      } catch (error) {
        warn(`mcp: error closing server "${entry.name}": ${errorMessage(error)}`);
      }
    }));
  };

  if (!config.enabled) {
    return {
      getLoaded: () => loaded,
      getStatuses: () => statuses,
      getToolNames: () => [],
      close: closeAll,
    };
  }

  ctx.on?.("session_start", async () => {
    closed = false;
    loaded = await loadMcpConfigs({
      cwd: options.cwd,
      home: options.home,
      config,
      warn,
    });

    const nextStatuses: McpConnectionStatus[] = [];

    for (const server of loaded.servers) {
      try {
        const connection = await connect(server, {
          cwd: options.cwd,
          timeoutMs: config.timeoutMs,
        });
        live.push(connection);

        const listed = await withTimeout(
          connection.client.listTools(),
          config.timeoutMs,
          `listTools(${server.name})`,
        );
        const toolNames: string[] = [];

        for (const tool of listed.tools ?? []) {
          const name = mcpToolName(server.name, tool.name);
          toolNames.push(name);
          options.registerTool(createMcpToolDefinition({
            toolName: name,
            serverName: server.name,
            mcpToolName: tool.name,
            description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
            parameters: toJsonSchema(tool.inputSchema),
            client: connection.client,
            timeoutMs: config.timeoutMs,
            isClosed: () => closed,
          }));
        }

        connection.toolNames = toolNames;
        nextStatuses.push({
          name: server.name,
          ok: true,
          toolNames,
          source: server.source,
        });
      } catch (error) {
        const message = `mcp: failed to connect server "${server.name}": ${errorMessage(error)}`;
        warn(message);
        nextStatuses.push({
          name: server.name,
          ok: false,
          toolNames: [],
          error: errorMessage(error),
          source: server.source,
        });
        if (config.failClosed) {
          statuses = nextStatuses;
          // Close any servers already connected in this session_start before aborting.
          await closeAll();
          throw new Error(message);
        }
      }
    }

    statuses = nextStatuses;
    return {
      mcp: {
        enabled: true,
        servers: statuses.map((status) => ({
          name: status.name,
          ok: status.ok,
          tools: status.toolNames,
          error: status.error,
          source: status.source,
        })),
        warnings: loaded.warnings,
        sources: loaded.sources,
      },
    };
  });

  ctx.on?.("session_end", async () => {
    await closeAll();
    return { mcp: { closed: true } };
  });

  return {
    getLoaded: () => loaded,
    getStatuses: () => statuses,
    getToolNames: () => statuses.flatMap((status) => status.toolNames),
    close: closeAll,
  };
}

export async function connectMcpServer(
  server: ResolvedMcpServer,
  options: Readonly<{ cwd: string; timeoutMs: number }>,
): Promise<LiveConnection> {
  const client = new Client({ name: "xiocode", version: "1.1.0" });
  const transport = createTransport(server.spec, options.cwd);

  await withTimeout(
    client.connect(transport),
    options.timeoutMs,
    `connect(${server.name})`,
  );

  return {
    name: server.name,
    client,
    toolNames: [],
    close: async () => {
      try {
        await client.close();
      } finally {
        await transport.close().catch(() => undefined);
      }
    },
  };
}

function createTransport(spec: McpServerSpec, cwd: string) {
  if (spec.transport === "stdio") {
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ? [...spec.args] : undefined,
      env: mergeStdioEnv(spec.env),
      cwd: spec.cwd ? path.resolve(cwd, spec.cwd) : cwd,
      stderr: "pipe",
    });
  }

  const url = new URL(spec.url);
  const requestInit: RequestInit | undefined = spec.headers
    ? { headers: { ...spec.headers } }
    : undefined;

  if (spec.transport === "sse") {
    return new SSEClientTransport(url, { requestInit });
  }

  return new StreamableHTTPClientTransport(url, { requestInit });
}

function mergeStdioEnv(
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!extra) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function createMcpToolDefinition(options: Readonly<{
  toolName: string;
  serverName: string;
  mcpToolName: string;
  description: string;
  parameters: JsonSchema;
  client: Client;
  timeoutMs: number;
  isClosed: () => boolean;
}>): ToolDefinition {
  return {
    name: options.toolName,
    label: options.toolName,
    description: options.description,
    promptSnippet: `MCP tool from server "${options.serverName}"`,
    parameters: options.parameters,
    async execute(_toolCallId, params, ctx): Promise<ToolExecuteResult> {
      if (options.isClosed()) {
        return {
          content: [{ type: "text", text: `MCP server "${options.serverName}" is closed` }],
          isError: true,
        };
      }

      try {
        const result = await withTimeout(
          options.client.callTool(
            { name: options.mcpToolName, arguments: params },
            undefined,
            { signal: ctx?.signal, timeout: options.timeoutMs },
          ),
          options.timeoutMs,
          `callTool(${options.toolName})`,
        );

        const content = normalizeToolContent(result);
        const isError = Boolean((result as { isError?: boolean }).isError);
        return {
          content,
          details: {
            mcp_server: options.serverName,
            mcp_tool: options.mcpToolName,
            structured: (result as { structuredContent?: unknown }).structuredContent,
          },
          isError,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `MCP call failed: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  };
}

function normalizeToolContent(result: unknown): ToolExecuteResult["content"] {
  const record = asRecord(result);
  const content = record?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: "text", text: JSON.stringify(result ?? null) }];
  }

  const parts: Array<{ type: "text"; text: string }> = [];
  for (const item of content) {
    const part = asRecord(item);
    if (!part) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    parts.push({ type: "text", text: JSON.stringify(part) });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: JSON.stringify(result) }];
}

function toJsonSchema(inputSchema: unknown): JsonSchema {
  const schema = asRecord(inputSchema);
  if (!schema) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return {
    type: typeof schema.type === "string" ? schema.type : "object",
    ...schema,
    properties: asRecord(schema.properties) as JsonSchema["properties"] ?? {},
  } as JsonSchema;
}

/**
 * Parse a Claude/Cursor-style server entry into a transport spec.
 */
export function parseServerSpec(
  name: string,
  value: unknown,
  warnings: string[],
  warn?: (message: string) => void,
): McpServerSpec | undefined {
  const entry = asRecord(value);
  if (!entry) {
    const message = `mcp: server "${name}" must be an object`;
    warnings.push(message);
    warn?.(message);
    return undefined;
  }

  const transportHint = typeof entry.type === "string"
    ? entry.type
    : typeof entry.transport === "string"
      ? entry.transport
      : undefined;

  if (typeof entry.command === "string" && entry.command.length > 0) {
    if (transportHint && !["stdio", "Stdio", "STDIO"].includes(transportHint)) {
      const message = `mcp: server "${name}" has command but type=${transportHint}; treating as stdio`;
      warnings.push(message);
      warn?.(message);
    }
    const args = Array.isArray(entry.args)
      ? entry.args.filter((item): item is string => typeof item === "string")
      : undefined;
    const env = asStringRecord(entry.env);
    const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
    return {
      transport: "stdio",
      command: entry.command,
      args,
      env,
      cwd,
    };
  }

  if (typeof entry.url === "string" && entry.url.length > 0) {
    const kind = normalizeUrlTransport(transportHint);
    const headers = asStringRecord(entry.headers);
    return {
      transport: kind,
      url: entry.url,
      headers,
    };
  }

  const message = `mcp: server "${name}" needs command (stdio) or url (sse/http); skipped`;
  warnings.push(message);
  warn?.(message);
  return undefined;
}

function normalizeUrlTransport(hint: string | undefined): "sse" | "http" {
  if (!hint) {
    return "http";
  }
  const lower = hint.toLowerCase();
  if (lower === "sse" || lower === "http+sse") {
    return "sse";
  }
  if (
    lower === "http"
    || lower === "streamable-http"
    || lower === "streamablehttp"
    || lower === "streamable_http"
  ) {
    return "http";
  }
  // Unknown url type → streamable HTTP (current MCP default).
  return "http";
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`mcp timeout after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
