import http from "node:http";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { XIO_VERSION } from "../cli/version.ts";
import { createSessionStore } from "../cli/session-resume.ts";
import { ensureConfigFile } from "../cli/ensure-config.ts";
import { parseXioConfig } from "../cli/config-parser.ts";
import { upsertSectionValue, upsertProviderBlock } from "../cli/config-mutate.ts";
import { loadCredentials, saveProviderCredential } from "../cli/credentials.ts";
import { writePrivateFileAtomic } from "../runtime/private-fs.ts";
import { renderWebUiHtml } from "./ui-template.ts";
import type { SessionStore } from "../runtime/session-store.ts";
import type { RuntimeEventV1 } from "../runtime/events/types.ts";

const execAsync = promisify(exec);

export type WebServerOptions = Readonly<{
  port?: number;
  host?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  store?: SessionStore;
}>;

export type WebServerHandle = Readonly<{
  server: http.Server;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}>;

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const store = options.store ?? createSessionStore(env);
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3080;

  // SSE client connections by sessionId
  const sseClients = new Map<string, Set<http.ServerResponse>>();

  function broadcastEvent(sessionId: string, event: RuntimeEventV1 | Record<string, unknown>): void {
    const clients = sseClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers for local dev convenience
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    try {
      // 1. Root SPA page
      if (pathname === "/" || pathname === "/index.html") {
        const latestSession = await store.latest(cwd);
        const html = renderWebUiHtml({
          version: XIO_VERSION,
          defaultSessionId: latestSession?.metadata.id,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // 2. Status API
      if (pathname === "/api/status" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          version: XIO_VERSION,
          cwd,
          mainRoot: cwd,
        }));
        return;
      }

      // 3. Sessions List & Create
      if (pathname === "/api/sessions") {
        if (req.method === "GET") {
          const sessions = await store.list();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sessions));
          return;
        }
        if (req.method === "POST") {
          const newId = store.createId();
          await store.save({
            id: newId,
            model: { provider: "anthropic", id: "claude-3-7-sonnet" },
            cwd,
            mainRoot: cwd,
            messages: [],
          });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: newId }));
          return;
        }
      }

      // 4. Session Detail & Delete (/api/sessions/:id)
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const id = sessionMatch[1]!;
        if (req.method === "GET") {
          try {
            const session = await store.load(id);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(session));
          } catch {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
          }
          return;
        }
        if (req.method === "DELETE") {
          const release = await store.acquireLease(id);
          try {
            await store.remove(id);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ deleted: id }));
          } finally {
            await release();
          }
          return;
        }
      }

      // 5. SSE Events Stream (/api/sessions/:id/events)
      const sseMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (sseMatch && req.method === "GET") {
        const id = sseMatch[1]!;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`: connected to session ${id}\n\n`);

        if (!sseClients.has(id)) {
          sseClients.set(id, new Set());
        }
        const clientSet = sseClients.get(id)!;
        clientSet.add(res);

        req.on("close", () => {
          clientSet.delete(res);
          if (clientSet.size === 0) sseClients.delete(id);
        });
        return;
      }

      // 6. Send Prompt (/api/sessions/:id/prompt)
      const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
      if (promptMatch && req.method === "POST") {
        const id = promptMatch[1]!;
        const body = await readJsonBody<{ prompt: string }>(req);
        if (!body.prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing prompt in body" }));
          return;
        }

        // Acknowledge request immediately
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", sessionId: id }));

        // Emit simulated & runtime events to connected SSE clients
        const runId = "run-" + Date.now();
        broadcastEvent(id, {
          schema_version: "xio-runtime-event.v1",
          seq: 0,
          timestamp: new Date().toISOString(),
          session_id: id,
          run_id: runId,
          turn_id: "turn-1",
          event: "run.start",
          payload: { prompt: body.prompt },
        });

        // Save user message to store
        try {
          const current = await store.load(id);
          const updatedMessages = [
            ...current.messages,
            { role: "user" as const, content: body.prompt },
          ];
          await store.save({
            id: current.metadata.id,
            model: current.metadata.model,
            cwd: current.metadata.cwd,
            mainRoot: current.metadata.main_root,
            messages: updatedMessages,
            execution: current.execution,
            workspace: current.workspace,
          });
        } catch {
          // ignore if new session
        }

        return;
      }

      // 7. Abort Run (/api/sessions/:id/abort)
      const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
      if (abortMatch && req.method === "POST") {
        const id = abortMatch[1]!;
        broadcastEvent(id, {
          schema_version: "xio-runtime-event.v1",
          seq: 999,
          timestamp: new Date().toISOString(),
          session_id: id,
          run_id: "abort",
          turn_id: null,
          event: "cancel",
          payload: { reason: "User abort via Web Console" },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "aborted", sessionId: id }));
        return;
      }

      // 8. Workspace Diff (/api/workspace/diff)
      if (pathname === "/api/workspace/diff" && req.method === "GET") {
        try {
          const { stdout } = await execAsync("git diff", { cwd });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ diff: stdout }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ diff: "", error: String(err) }));
        }
        return;
      }

      // 9. Settings API (/api/settings)
      if (pathname === "/api/settings") {
        if (req.method === "GET") {
          const configRes = await ensureConfigFile(env);
          const parsed = parseXioConfig(configRes.content, { cwd });
          const creds = await loadCredentials(env);

          const providersList = Object.entries(parsed.xio.providers).map(([name, p]) => {
            const envKey = p.apiKeyEnv ? env[p.apiKeyEnv] : undefined;
            const credKey = creds.providers[name]?.apiKey;
            const hasKey = Boolean(envKey || credKey);
            return {
              name,
              kind: p.kind,
              baseUrl: p.baseUrl ?? (p.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com"),
              model: p.model ?? (name === "deepseek" ? "deepseek-chat" : "gpt-4.1"),
              apiKeyEnv: p.apiKeyEnv ?? (name === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY"),
              hasKey,
            };
          });

          if (providersList.length === 0) {
            providersList.push({
              name: "deepseek",
              kind: "openai",
              baseUrl: "https://api.deepseek.com",
              model: "deepseek-chat",
              apiKeyEnv: "DEEPSEEK_API_KEY",
              hasKey: Boolean(env.DEEPSEEK_API_KEY || creds.providers["deepseek"]?.apiKey),
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            configPath: configRes.path,
            general: {
              defaultProvider: parsed.xio.general.defaultProvider ?? "deepseek",
              defaultModel: parsed.xio.general.defaultModel ?? "deepseek-chat",
              defaultThinkingLevel: parsed.xio.general.defaultThinkingLevel ?? "off",
              maxTurns: parsed.xio.general.maxTurns ?? 24,
              maxSessionTokens: parsed.xio.general.maxSessionTokens ?? 48000,
              repeatToolLimit: parsed.xio.general.repeatToolLimit ?? 3,
            },
            providers: providersList,
            permissions: {
              allowHighRisk: parsed.xio.permissions.allowHighRisk ?? false,
            },
          }));
          return;
        }

        if (req.method === "POST") {
          const body = await readJsonBody<{
            general?: {
              defaultProvider?: string;
              defaultModel?: string;
              defaultThinkingLevel?: string;
              maxTurns?: number;
              maxSessionTokens?: number;
              repeatToolLimit?: number;
            };
            provider?: {
              name: string;
              kind?: string;
              baseUrl?: string;
              model?: string;
              apiKeyEnv?: string;
              apiKey?: string;
            };
            permissions?: {
              allowHighRisk?: boolean;
            };
          }>(req);

          const configRes = await ensureConfigFile(env);
          let content = configRes.content;

          if (body.general) {
            if (body.general.defaultProvider !== undefined) {
              content = upsertSectionValue(content, "general", "default_provider", body.general.defaultProvider);
            }
            if (body.general.defaultModel !== undefined) {
              content = upsertSectionValue(content, "general", "default_model", body.general.defaultModel);
            }
            if (body.general.defaultThinkingLevel !== undefined) {
              content = upsertSectionValue(content, "general", "default_thinking_level", body.general.defaultThinkingLevel);
            }
            if (body.general.maxTurns !== undefined) {
              content = upsertSectionValue(content, "general", "max_turns", body.general.maxTurns);
            }
            if (body.general.maxSessionTokens !== undefined) {
              content = upsertSectionValue(content, "general", "max_session_tokens", body.general.maxSessionTokens);
            }
            if (body.general.repeatToolLimit !== undefined) {
              content = upsertSectionValue(content, "general", "repeat_tool_limit", body.general.repeatToolLimit);
            }
          }

          if (body.provider && body.provider.name) {
            content = upsertProviderBlock(content, {
              name: body.provider.name,
              kind: body.provider.kind ?? "openai",
              baseUrl: body.provider.baseUrl,
              model: body.provider.model ?? "deepseek-chat",
              apiKeyEnv: body.provider.apiKeyEnv ?? `${body.provider.name.toUpperCase()}_API_KEY`,
            });
            if (body.provider.apiKey && body.provider.apiKey.trim()) {
              await saveProviderCredential(
                body.provider.name,
                {
                  apiKey: body.provider.apiKey.trim(),
                  baseUrl: body.provider.baseUrl,
                  models: body.provider.model ? [body.provider.model] : undefined,
                },
                env,
              );
            }
          }

          if (body.permissions && body.permissions.allowHighRisk !== undefined) {
            content = upsertSectionValue(content, "permissions", "allow_high_risk", body.permissions.allowHighRisk);
          }

          await writePrivateFileAtomic(configRes.path, content);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", updated: true }));
          return;
        }
      }

      // 10. Rules API (/api/rules)
      if (pathname === "/api/rules") {
        const rulesPath = path.join(cwd, "AGENTS.md");
        if (req.method === "GET") {
          try {
            const content = await readFile(rulesPath, "utf8");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ path: rulesPath, filename: "AGENTS.md", content, exists: true }));
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ path: rulesPath, filename: "AGENTS.md", content: "", exists: false }));
          }
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody<{ content: string }>(req);
          await writeFile(rulesPath, body.content ?? "", "utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", path: rulesPath, saved: true }));
          return;
        }
      }

      // 11. Extensions & MCP API (/api/extensions)
      if (pathname === "/api/extensions" && req.method === "GET") {
        const extensions = [
          { id: "xio-setup", name: "环境配置诊断 (Setup & Doctor)", description: "检测系统环境、依赖工具与 API Key 凭据状态", enabled: true, category: "core" },
          { id: "xio-hygiene", name: "代码异味扫描 (Hygiene & Audit)", description: "自动化静态扫描代码异味、坏味道与死代码", enabled: true, category: "audit" },
          { id: "xio-improve", name: "自进化循环 (Self-Improve Agent)", description: "基于反馈日志和题库自动演进提示词与工作流", enabled: true, category: "evolution" },
          { id: "xio-regress", name: "失败用例回归 (Regression Runner)", description: "私有题库可复跑的行为对照回归套件", enabled: true, category: "testing" },
          { id: "xio-eval", name: "行为基准评估 (Behavior Eval)", description: "最小 diff (T6)、危险操作门闩 (T7)、发布约束 (T9) 评测", enabled: true, category: "evaluation" },
          { id: "xio-sandbox", name: "安全隔离沙箱 (Worktree Sandbox)", description: "基于 Git Worktree 和容器的只读/隔离执行环境", enabled: true, category: "security" },
          { id: "xio-evolve", name: "规则演进器 (Rules Evolver)", description: "自动化更新与维护 AGENTS.md 约束守卫", enabled: true, category: "rules" },
        ];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ extensions, mcpServers: [] }));
        return;
      }

      // 404 Fallback
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  const actualPort = await new Promise<number>((resolve, reject) => {
    server.listen(requestedPort, host, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        resolve(requestedPort);
      }
    });
    server.on("error", reject);
  });

  const url = `http://${host}:${actualPort}`;

  return {
    server,
    port: actualPort,
    host,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
