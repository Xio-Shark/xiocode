import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MCP_CONFIG,
  forceKillPid,
  loadMcpConfigs,
  mcpToolName,
  parseServerSpec,
  readTransportPid,
  registerMcpBridge,
  sanitizeMcpSegment,
  type McpConfig,
} from "../src/mcp.ts";
import { registerXioHygiene } from "../src/index.ts";
import { ExtensionHost } from "../../../src/runtime/extension-host.ts";
import { startHttpMcpFixture, startSseMcpFixture } from "./fixtures/mcp-local-servers.ts";

const tempDirs: string[] = [];
const fixtureServers: Array<{ close: () => Promise<void> }> = [];

const STDIO_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mcp-stdio-echo.mjs",
);

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(fixtureServers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function config(partial: Partial<McpConfig> = {}): McpConfig {
  return { ...DEFAULT_MCP_CONFIG, ...partial };
}

describe("mcp naming", () => {
  it("builds mcp__server__tool names", () => {
    expect(sanitizeMcpSegment("my server!")).toBe("my_server");
    expect(mcpToolName("demo", "echo")).toBe("mcp__demo__echo");
  });
});

describe("mcp force-kill helpers", () => {
  it("reads transport pid when present", () => {
    expect(readTransportPid({ pid: 12345 })).toBe(12345);
    expect(readTransportPid({ pid: null })).toBeNull();
    expect(readTransportPid({})).toBeNull();
    expect(readTransportPid(null)).toBeNull();
  });

  it("forceKillPid ignores invalid pids and missing processes", () => {
    expect(() => forceKillPid(null)).not.toThrow();
    expect(() => forceKillPid(-1)).not.toThrow();
    // Extremely unlikely to exist; ESRCH must not throw.
    expect(() => forceKillPid(2_147_483_646)).not.toThrow();
  });

  it("session_end returns quickly after stdio connect", async () => {
    const root = await tempRoot("xio-mcp-close-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: process.execPath,
            args: [STDIO_FIXTURE],
          },
        },
      }),
      "utf8",
    );

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({ readClaude: false, readCursor: false }),
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    expect(bridge.getToolNames().length).toBeGreaterThan(0);

    const started = Date.now();
    await host.emit("session_end", {});
    const elapsed = Date.now() - started;
    // Graceful close + force-kill must not approach multi-minute hangs.
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("parseServerSpec", () => {
  it("parses stdio and url transports", () => {
    const warnings: string[] = [];
    expect(parseServerSpec("a", { command: "node", args: ["x.mjs"] }, warnings)).toEqual({
      transport: "stdio",
      command: "node",
      args: ["x.mjs"],
      env: undefined,
      cwd: undefined,
    });
    expect(parseServerSpec("b", { url: "http://127.0.0.1/mcp", type: "sse" }, warnings)).toEqual({
      transport: "sse",
      url: "http://127.0.0.1/mcp",
      headers: undefined,
    });
    expect(parseServerSpec("c", { url: "http://127.0.0.1/mcp", type: "http" }, warnings)?.transport).toBe("http");
    expect(parseServerSpec("d", { nope: true }, warnings)).toBeUndefined();
    expect(warnings.some((w) => w.includes("needs command"))).toBe(true);
  });

  it("skips disabled Cursor/Claude server entries", () => {
    const warnings: string[] = [];
    expect(parseServerSpec("x", { command: "/missing/python", disable: true }, warnings)).toBeUndefined();
    expect(parseServerSpec("y", { command: "/missing/python", disabled: true }, warnings)).toBeUndefined();
    expect(parseServerSpec("z", { command: "/missing/python", enabled: false }, warnings)).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("loadMcpConfigs", () => {
  it("merges project over user and config.toml last", async () => {
    const root = await tempRoot("xio-mcp-merge-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "claude-cmd" },
          onlyClaude: { command: "claude-only" },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "cursor-cmd" },
          onlyCursor: { command: "cursor-only" },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "project-cmd" },
          onlyProject: { command: "project-only" },
        },
      }),
      "utf8",
    );

    const loaded = await loadMcpConfigs({
      cwd,
      home,
      config: config({
        servers: {
          shared: { transport: "stdio", command: "config-cmd" },
          fromConfig: { transport: "stdio", command: "cfg" },
        },
      }),
    });

    const byName = Object.fromEntries(loaded.servers.map((s) => [s.name, s]));
    expect(byName.shared?.spec).toMatchObject({ transport: "stdio", command: "config-cmd" });
    expect(byName.shared?.source).toBe("config");
    expect(byName.onlyClaude?.source).toBe("claude-user");
    expect(byName.onlyCursor?.source).toBe("cursor-user");
    expect(byName.onlyProject?.source).toBe("project");
    expect(byName.fromConfig?.source).toBe("config");
  });

  it("skips Claude/Cursor user import when unknown_source_fail_closed", async () => {
    const root = await tempRoot("xio-mcp-unknown-closed-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { onlyClaude: { command: "claude-only" } } }),
      "utf8",
    );
    await writeFile(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { onlyCursor: { command: "cursor-only" } } }),
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { onlyProject: { command: "project-only" } } }),
      "utf8",
    );

    const loaded = await loadMcpConfigs({
      cwd,
      home,
      config: config({
        unknownSourceFailClosed: true,
        servers: { fromConfig: { transport: "stdio", command: "cfg" } },
      }),
    });

    const names = loaded.servers.map((s) => s.name).sort();
    expect(names).toEqual(["fromConfig", "onlyProject"]);
    expect(loaded.warnings.some((w) => w.includes("unknown_source_fail_closed"))).toBe(true);
  });

  it("returns empty when disabled", async () => {
    const loaded = await loadMcpConfigs({
      cwd: await tempRoot("xio-mcp-off-"),
      config: config({ enabled: false }),
    });
    expect(loaded.servers).toEqual([]);
  });
});

describe("registerMcpBridge transports", () => {
  it("registers and executes stdio tools from .mcp.json", async () => {
    const root = await tempRoot("xio-mcp-stdio-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: process.execPath,
            args: [STDIO_FIXTURE],
          },
        },
      }),
      "utf8",
    );

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({ readClaude: false, readCursor: false }),
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    const toolName = "mcp__echo__echo";
    expect(bridge.getToolNames()).toContain(toolName);
    const tool = host.getTool(toolName);
    expect(tool).toBeDefined();
    const result = await tool!.execute("call-1", { text: "hi" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("fixture-echo:hi");

    await host.emit("session_end", {});
    const afterClose = await tool!.execute("call-2", { text: "bye" });
    expect(afterClose.isError).toBe(true);
    expect(afterClose.content[0]?.text).toMatch(/closed/i);
  });

  it("lists and calls tools over local HTTP fixture", async () => {
    const fixture = await startHttpMcpFixture();
    fixtureServers.push(fixture);
    const root = await tempRoot("xio-mcp-http-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          servers: {
            httpEcho: {
              transport: "http",
              url: fixture.url,
            },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    const toolName = "mcp__httpEcho__echo";
    expect(bridge.getToolNames()).toContain(toolName);
    const result = await host.getTool(toolName)!.execute("c1", { text: "http" });
    expect(result.content[0]?.text).toBe("fixture-http:http");
    await host.emit("session_end", {});
  });

  it("lists and calls tools over local SSE fixture", async () => {
    const fixture = await startSseMcpFixture();
    fixtureServers.push(fixture);
    const root = await tempRoot("xio-mcp-sse-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          servers: {
            sseEcho: {
              transport: "sse",
              url: fixture.url,
            },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    const toolName = "mcp__sseEcho__echo";
    expect(bridge.getToolNames()).toContain(toolName);
    const result = await host.getTool(toolName)!.execute("c1", { text: "sse" });
    expect(result.content[0]?.text).toBe("fixture-sse:sse");
    await host.emit("session_end", {});
  });

  it("fail-open skips bad servers and continues", async () => {
    const warnings: string[] = [];
    const root = await tempRoot("xio-mcp-failopen-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          failClosed: false,
          servers: {
            broken: {
              transport: "stdio",
              command: process.execPath,
              args: ["-e", "process.exit(1)"],
            },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
        warn: (message) => warnings.push(message),
      },
    );

    await expect(host.emit("session_start", {})).resolves.toBeDefined();
    await bridge.waitUntilSettled();
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
  });

  it("fail-closed closes peers after a failed server without blocking session_start", async () => {
    const root = await tempRoot("xio-mcp-failclosed-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          failClosed: true,
          servers: {
            ok: {
              transport: "stdio",
              command: process.execPath,
              args: [STDIO_FIXTURE],
            },
            broken: {
              transport: "stdio",
              command: process.execPath,
              args: ["-e", "process.exit(1)"],
            },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    await expect(host.emit("session_start", {})).resolves.toBeDefined();
    await bridge.waitUntilSettled();
    const tool = host.getTool("mcp__ok__echo");
    if (tool) {
      const afterAbort = await tool.execute("call-1", { text: "x" });
      expect(afterAbort.isError).toBe(true);
      expect(afterAbort.content[0]?.text).toMatch(/closed/i);
    }
    expect(bridge.getStatuses().some((s) => s.name === "broken" && !s.ok)).toBe(true);
  });

  it("session_start resolves before slow MCP connects finish", async () => {
    const root = await tempRoot("xio-mcp-defer-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowStarted = false;

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          timeoutMs: 5_000,
          servers: {
            slow: { transport: "stdio", command: "slow" },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
        connectServer: async (server) => {
          if (server.name === "slow") {
            slowStarted = true;
            await slowGate;
          }
          return {
            name: server.name,
            client: {
              listTools: async () => ({ tools: [{ name: "ping", description: "ping" }] }),
              callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
              close: async () => undefined,
            } as never,
            toolNames: [],
            pid: null,
            forceKill: () => undefined,
            close: async () => undefined,
          };
        },
      },
    );

    const start = host.emit("session_start", {});
    const results = await start;
    expect(slowStarted).toBe(true);
    expect(JSON.stringify(results)).toContain('"deferred":true');
    expect(bridge.getToolNames()).not.toContain("mcp__slow__ping");

    releaseSlow();
    await bridge.waitUntilSettled();
    expect(bridge.getToolNames()).toContain("mcp__slow__ping");
    expect(host.getTool("mcp__slow__ping")).toBeDefined();
  });

  it("connects two servers concurrently", async () => {
    const root = await tempRoot("xio-mcp-parallel-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    let active = 0;
    let maxActive = 0;
    const barriers: Array<() => void> = [];

    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          timeoutMs: 5_000,
          servers: {
            a: { transport: "stdio", command: "a" },
            b: { transport: "stdio", command: "b" },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
        connectServer: async (server) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => {
            barriers.push(resolve);
            if (barriers.length >= 2) {
              for (const release of barriers.splice(0)) {
                release();
              }
            }
          });
          active -= 1;
          return {
            name: server.name,
            client: {
              listTools: async () => ({ tools: [{ name: "echo", description: "echo" }] }),
              callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
              close: async () => undefined,
            } as never,
            toolNames: [],
            pid: null,
            forceKill: () => undefined,
            close: async () => undefined,
          };
        },
      },
    );

    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(bridge.getToolNames()).toEqual(expect.arrayContaining([
      "mcp__a__echo",
      "mcp__b__echo",
    ]));
  });


  it("listTools failure closes connection and removes it from live registry", async () => {
    const root = await tempRoot("xio-mcp-listfail-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    let closed = false;
    let forceKilled = false;
    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          timeoutMs: 2_000,
          servers: {
            bad: { transport: "stdio", command: "bad" },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
        connectServer: async (server) => ({
          name: server.name,
          client: {
            listTools: async () => {
              throw new Error("listTools boom");
            },
            callTool: async () => ({ content: [] }),
            close: async () => undefined,
          } as never,
          toolNames: [],
          pid: null,
          forceKill: () => {
            forceKilled = true;
          },
          close: async () => {
            closed = true;
          },
        }),
      },
    );

    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    expect(bridge.getToolNames()).toEqual([]);
    expect(bridge.getStatuses()[0]?.ok).toBe(false);
    expect(closed).toBe(true);
    expect(bridge.getToolNames().length).toBe(0);

    const started = Date.now();
    await host.emit("session_end", {});
    expect(Date.now() - started).toBeLessThan(3_000);
    void forceKilled;
  });

  it("connect timeout mock path closes connection within bound", async () => {
    const root = await tempRoot("xio-mcp-timeout-");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });

    let closed = 0;
    const host = new ExtensionHost();
    const bridge = registerMcpBridge(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home: path.join(root, "home"),
        config: config({
          readClaude: false,
          readCursor: false,
          timeoutMs: 50,
          servers: {
            hang: { transport: "stdio", command: "hang" },
          },
        }),
        registerTool: (tool) => host.registerTool(tool),
        connectServer: async () => {
          await new Promise((_, reject) => {
            setTimeout(() => reject(new Error("mcp timeout after 50ms: connect(hang)")), 50);
          });
          throw new Error("unreachable");
        },
      },
    );

    // Simulate connectMcpServer cleanup contract: injectors that throw after timeout
    // still leave no live tools; session_end is bounded.
    await host.emit("session_start", {});
    await bridge.waitUntilSettled();
    expect(bridge.getToolNames()).toEqual([]);
    const t0 = Date.now();
    await host.emit("session_end", {});
    expect(Date.now() - t0).toBeLessThan(3_000);
    void closed;
  });

  it("coexists with skill tool and is blockable via PreToolUse hooks", async () => {
    const root = await tempRoot("xio-mcp-hooks-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await mkdir(path.join(cwd, ".claude", "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\n\nbody\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: process.execPath,
            args: [STDIO_FIXTURE],
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "^mcp__",
              hooks: [{ type: "command", command: "printf 'blocked mcp' >&2; exit 2" }],
            },
          ],
        },
      }),
      "utf8",
    );

    const host = new ExtensionHost();
    const hygiene = registerXioHygiene(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home,
        agentsMd: { enabled: false },
        skills: { enabled: true, readClaude: true, readCursor: false, maxBodyBytes: 1024 },
        hooks: { enabled: true, readClaude: true, timeoutMs: 5_000 },
        mcp: { enabled: true, readClaude: false, readCursor: false, failClosed: false, timeoutMs: 15_000 },
        registerTool: (tool) => host.registerTool(tool),
      },
    );

    await host.emit("session_start", {});
    await hygiene.getMcp()?.waitUntilSettled();
    expect(host.getTool("skill")).toBeDefined();
    expect(host.getTool("mcp__echo__echo")).toBeDefined();

    const hookResult = await host.emit("tool_call", {
      toolName: "mcp__echo__echo",
      input: { text: "x" },
      call: { id: "t1", name: "mcp__echo__echo", args: { text: "x" } },
    });
    expect(JSON.stringify(hookResult)).toMatch(/block/i);

    const skillHook = await host.emit("tool_call", {
      toolName: "skill",
      input: { action: "list" },
      call: { id: "t2", name: "skill", args: { action: "list" } },
    });
    expect(JSON.stringify(skillHook)).not.toMatch(/"block":true/);

    await host.emit("session_end", {});
  });
});
