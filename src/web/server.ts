import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import os from "node:os";
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
import { applyConfiguredLanguage, getLanguage, type Language } from "../i18n/messages.ts";
import { buildSessionTrajectory, isToolResultError } from "./trajectory.ts";
import { parseTimelineRecords } from "./trajectory-timing.ts";
import { TIMELINE_FILE } from "../runtime/session-timeline.ts";
import { AgentHostBusyError, WebAgentHost, type WebEvent } from "./agent-host.ts";
import { DEFAULT_MCP_CONFIG, loadMcpConfigs, type McpServerState, type McpStatusPayload } from "../../extensions/xio-hygiene/src/mcp.ts";
import { toHygieneMcp } from "../cli/xio-extension.ts";
import { parsePermissionMode } from "../runtime/permission-mode.ts";
import type { SessionStore, StoredSession } from "../runtime/session-store.ts";
import type { RuntimeEventV1 } from "../runtime/events/types.ts";
import { formatSessionCost } from "../runtime/pricing.ts";
import { THINKING_LEVELS } from "../runtime/thinking.ts";
import { PROVIDER_PRESETS, findProviderPreset } from "../cli/provider-catalog.ts";

const execAsync = promisify(exec);
/** git diff output above this is refused with an error instead of being cut short. */
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;

export type WebServerOptions = Readonly<{
  port?: number;
  host?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  store?: SessionStore;
  /** Access token; a random one is generated per start when omitted (tests pass their own). */
  token?: string;
  /** Test seam: the agent runner behind /prompt. */
  agentHost?: Pick<
    WebAgentHost,
    "prompt" | "abort" | "answerApproval" | "close" | "isRunning" | "activeSessionId" | "permissionMode" | "setPermissionMode"
  > & {
    getCostSummary?: (sessionId: string) => import("../runtime/pricing.ts").SessionCostSummary | undefined;
    getMcpStatus?: WebAgentHost["getMcpStatus"];
  };
}>;

export type WebServerHandle = Readonly<{
  server: http.Server;
  port: number;
  host: string;
  /** Plain origin, e.g. http://127.0.0.1:3080 */
  url: string;
  /** URL to open: carries the access token, exchanged for a cookie on first load. */
  launchUrl: string;
  token: string;
  close: () => Promise<void>;
}>;

/** Hostnames a loopback console answers to; anything else is a rebinding attempt. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const store = options.store ?? createSessionStore(env);
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3080;
  const token = options.token ?? randomBytes(24).toString("base64url");
  let listeningPort = requestedPort;

  // SSE client connections by sessionId
  const sseClients = new Map<string, Set<http.ServerResponse>>();

  function broadcastEvent(sessionId: string, event: RuntimeEventV1 | WebEvent): number {
    const clients = sseClients.get(sessionId);
    if (!clients || clients.size === 0) return 0;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    let delivered = 0;
    for (const client of clients) {
      try {
        client.write(payload);
        delivered += 1;
      } catch {
        clients.delete(client);
      }
    }
    return delivered;
  }

  const agentHost = options.agentHost ?? new WebAgentHost({ cwd, env, store, broadcast: broadcastEvent });
  const cookieName = () => `xio_web_${listeningPort}`;

  const server = http.createServer(async (req, res) => {
    // No CORS: the console is same-origin only. Framing and sniffing are off.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");

    const guard = checkRequest(req, {
      port: listeningPort,
      extraHost: host,
      token,
      cookieName: cookieName(),
    });
    if (guard.kind === "reject") {
      res.writeHead(guard.status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(guard.message);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // 1. Root SPA page. A valid ?token= is exchanged for a same-site cookie.
      if (pathname === "/" || pathname === "/index.html") {
        if (url.searchParams.has("token")) {
          if (!sameSecret(url.searchParams.get("token") ?? "", token)) {
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            res.end(unauthorizedPage());
            return;
          }
          res.writeHead(303, {
            "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
            Location: "/",
          });
          res.end();
          return;
        }
        if (guard.kind !== "authorized") {
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(unauthorizedPage());
          return;
        }
        const latestSession = await store.latest(cwd);
        const html = renderWebUiHtml({
          version: XIO_VERSION,
          defaultSessionId: latestSession?.metadata.id,
          language: await readUiLanguage(env, cwd),
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Everything below is API: it needs the cookie (browser) or a bearer token.
      if (guard.kind !== "authorized") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized: open the URL printed by `xio web`" }));
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
          defaultModel: await readDefaultModel(env, cwd),
          activeSessionId: agentHost.activeSessionId,
          permissionMode: agentHost.permissionMode ?? "auto",
        }));
        return;
      }

      // 2b. SSE Real-time Events Stream
      if (pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "init", version: XIO_VERSION, timestamp: Date.now() })}\n\n`);
        const heartbeat = setInterval(() => {
          res.write(`data: ${JSON.stringify({ type: "ping", timestamp: Date.now() })}\n\n`);
        }, 15000);
        req.on("close", () => {
          clearInterval(heartbeat);
        });
        return;
      }

      // 3. Sessions List & Create
      if (pathname === "/api/sessions") {
        if (req.method === "GET") {
          const sessions = await store.list();
          const enhanced = await Promise.all(
            sessions.map(async (s) => {
              try {
                const full = await store.load(s.id);
                const firstUser = full.messages.find((m) => m.role === "user");
                // Never prompted (a TUI opened and closed, or left by an older version): nothing to show.
                if (!firstUser) return undefined;
                return {
                  ...s,
                  firstPrompt: firstUser ? firstUser.content.slice(0, 120) : undefined,
                  messageCount: full.messages.length,
                };
              } catch {
                return { ...s, messageCount: 0 };
              }
            })
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(enhanced.filter((s) => s !== undefined)));
          return;
        }
        if (req.method === "POST") {
          // Nothing is persisted until the first prompt: an unused "new session"
          // must not litter the list. The model is whatever the config selects.
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: store.createId(), model: await readDefaultModel(env, cwd) }));
          return;
        }
      }

      // 4. Session Trajectory & Export Log (/api/sessions/:id/trajectory and /api/sessions/:id/log)
      const trajectoryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/trajectory$/);
      if (trajectoryMatch && req.method === "GET") {
        const id = trajectoryMatch[1]!;
        try {
          const session = await store.load(id);
          const traj = await loadTrajectory(store, session);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(traj));
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
        }
        return;
      }

      const logMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/log$/);
      if (logMatch && req.method === "GET") {
        const id = logMatch[1]!;
        try {
          const session = await store.load(id);
          const traj = await loadTrajectory(store, session);
          const exportPayload = {
            schema_version: "xio-session-log.v1",
            id: session.metadata.id,
            metadata: session.metadata,
            workspace: session.workspace,
            execution: session.execution,
            stats: traj.stats,
            trajectory: traj.steps,
            messages: session.messages,
            exported_at: new Date().toISOString(),
          };
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="session-${id}-log.json"`,
          });
          res.end(JSON.stringify(exportPayload, null, 2));
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
        }
        return;
      }

      // 5. Session Detail & Delete (/api/sessions/:id)
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const id = sessionMatch[1]!;
        if (req.method === "GET") {
          try {
            const session = await store.load(id);
            const traj = await loadTrajectory(store, session);
            const messages = (session.messages || []).map((msg) => {
              if (msg.role === "tool") {
                let isError: boolean | "unknown";
                if ((msg as { isError?: boolean }).isError !== undefined) {
                  isError = Boolean((msg as { isError?: boolean }).isError);
                } else if (typeof msg.content === "string") {
                  if (isToolResultError(msg.content)) {
                    isError = true;
                  } else if (msg.content.trim().length > 0) {
                    isError = false;
                  } else {
                    isError = "unknown";
                  }
                } else {
                  isError = "unknown";
                }
                return { ...msg, isError };
              }
              return msg;
            });
            const liveCost = agentHost.getCostSummary?.(id);
            // null when unpriced; the page words that in its own language.
            const cost = liveCost && liveCost.costUsd !== null ? formatSessionCost(liveCost) : null;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ...session,
              messages,
              trajectory: traj.steps,
              stats: traj.stats,
              ...("timelineError" in traj ? { timelineError: traj.timelineError } : {}),
              cost,
              running: agentHost.isRunning(id),
            }));
          } catch {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
          }
          return;
        }
        if (req.method === "DELETE") {
          if (agentHost.isRunning(id)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "session is running a turn; abort it first" }));
            return;
          }
          if (agentHost.activeSessionId === id) await agentHost.close();
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

      // 6. Send Prompt (/api/sessions/:id/prompt): runs a real agent turn.
      const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
      if (promptMatch && req.method === "POST") {
        const id = promptMatch[1]!;
        const body = await readJsonBody<{ prompt?: string }>(req);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing prompt in body" }));
          return;
        }
        try {
          await agentHost.prompt(id, prompt);
        } catch (error) {
          const busy = error instanceof AgentHostBusyError;
          res.writeHead(busy ? 409 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          return;
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", sessionId: id }));
        return;
      }

      // 7. Abort Run (/api/sessions/:id/abort)
      const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
      if (abortMatch && req.method === "POST") {
        const id = abortMatch[1]!;
        const aborted = agentHost.abort(id);
        res.writeHead(aborted ? 200 : 409, { "Content-Type": "application/json" });
        res.end(JSON.stringify(aborted ? { status: "aborting", sessionId: id } : { error: "no running turn in this session" }));
        return;
      }

      // 7b. Answer a permission question (/api/sessions/:id/approval)
      const approvalMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/approval$/);
      if (approvalMatch && req.method === "POST") {
        const id = approvalMatch[1]!;
        const body = await readJsonBody<{ id?: string; approve?: boolean; value?: string; text?: string }>(req);
        const answered = typeof body.id === "string"
          && agentHost.answerApproval(id, body.id, {
            approve: body.approve === true,
            ...(typeof body.value === "string" ? { value: body.value } : {}),
            ...(typeof body.text === "string" ? { text: body.text } : {}),
          });
        res.writeHead(answered ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answered ? { status: "answered" } : { error: "no such pending question" }));
        return;
      }

      // 7c. Permission mode of the console's session (/api/permission)
      if (pathname === "/api/permission" && req.method === "POST") {
        const body = await readJsonBody<{ mode?: string }>(req);
        const mode = parsePermissionMode(String(body.mode ?? ""));
        if (!mode) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "mode must be auto, strict or full" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ mode: agentHost.setPermissionMode(mode) }));
        return;
      }

      // 8. Workspace Diff (/api/workspace/diff)
      if (pathname === "/api/workspace/diff" && req.method === "GET") {
        // A failed git call is an error the page shows, not an empty diff ("no changes").
        try {
          const [{ stdout: diff }, { stdout: others }] = await Promise.all([
            execAsync("git diff", { cwd, maxBuffer: DIFF_MAX_BUFFER }),
            execAsync("git ls-files --others --exclude-standard", { cwd, maxBuffer: DIFF_MAX_BUFFER }),
          ]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ diff, untracked: others.split("\n").filter(Boolean) }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `git diff failed: ${err instanceof Error ? err.message : String(err)}` }));
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
            configPath: displayPath(configRes.path),
            general: {
              defaultProvider: parsed.xio.general.defaultProvider ?? "deepseek",
              defaultModel: parsed.xio.general.defaultModel ?? "deepseek-chat",
              defaultThinkingLevel: parsed.xio.general.defaultThinkingLevel ?? "off",
              maxTurns: parsed.xio.general.maxTurns ?? 24,
              maxSessionTokens: parsed.xio.general.maxSessionTokens ?? 48000,
              repeatToolLimit: parsed.xio.general.repeatToolLimit ?? 3,
            },
            providers: providersList,
            // The page renders these; it keeps no provider or level list of its own.
            catalog: PROVIDER_PRESETS.filter((preset) => !preset.custom).map((preset) => ({
              id: preset.id,
              label: preset.label,
              apiKeyEnv: preset.apiKeyEnv,
              defaultModel: preset.defaultModel,
              sampleModels: preset.sampleModels,
              hasKey: Boolean(env[preset.apiKeyEnv] || creds.providers[preset.id]?.apiKey),
            })),
            thinkingLevels: THINKING_LEVELS,
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
            // The block is rewritten whole, so keep what the config already says, then fall back to the
            // provider's preset (Anthropic's wire kind is not "openai"), then to generic defaults.
            const existing = parseXioConfig(content, { cwd }).xio.providers[body.provider.name];
            const preset = findProviderPreset(body.provider.name);
            content = upsertProviderBlock(content, {
              name: body.provider.name,
              kind: body.provider.kind ?? existing?.kind ?? preset?.kind ?? "openai",
              baseUrl: body.provider.baseUrl ?? existing?.baseUrl ?? preset?.baseUrl,
              model: body.provider.model ?? existing?.model ?? preset?.defaultModel ?? "deepseek-chat",
              apiKeyEnv: body.provider.apiKeyEnv ?? existing?.apiKeyEnv ?? preset?.apiKeyEnv ?? `${body.provider.name.toUpperCase()}_API_KEY`,
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

      // 11. Extensions & MCP API (/api/extensions): what actually ships and what is configured.
      if (pathname === "/api/extensions" && req.method === "GET") {
        const extensions = [
          { id: "xio-hygiene", name: "Hygiene", description: "Loads AGENTS.md / CLAUDE.md, skills, user hooks (SessionStart / PreToolUse / PostToolUse / Stop) and MCP servers.", enabled: true, category: "context" },
          { id: "xio-sandbox", name: "Sandbox", description: "Optional git worktree per session with merge-on-approval; /rollback for turns and sessions.", enabled: true, category: "isolation" },
          { id: "xio-evolve", name: "Evolve", description: "Records run trajectories, trims noisy tool output and injects relevant context each turn.", enabled: true, category: "runtime" },
          { id: "xio-setup", name: "Setup", description: "xio-setup CLI: provider setup and optional config sections.", enabled: true, category: "setup" },
        ];
        const live = agentHost.getMcpStatus?.();
        const mcpServers = withMcpStates(await listMcpServers(env, cwd), live?.status);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ extensions, mcpServers, mcpSessionId: live?.sessionId ?? null }));
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

  listeningPort = actualPort;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    port: actualPort,
    host,
    url,
    launchUrl: `${url}/?token=${encodeURIComponent(token)}`,
    token,
    close: async () => {
      await agentHost.close();
      for (const clients of sseClients.values()) {
        for (const client of clients) client.end();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

type RequestGuard =
  | Readonly<{ kind: "authorized" }>
  | Readonly<{ kind: "anonymous" }>
  | Readonly<{ kind: "reject"; status: number; message: string }>;

/**
 * Loopback-only access control:
 * - Host must be a loopback name on our port (blocks DNS rebinding).
 * - A cross-site Origin is refused (blocks CSRF from any page the user visits).
 * - Authorized = same-site cookie (browser) or bearer token (scripts, tests).
 */
export function checkRequest(
  req: http.IncomingMessage,
  context: Readonly<{ port: number; extraHost: string; token: string; cookieName: string }>,
): RequestGuard {
  const hostHeader = req.headers.host ?? "";
  const allowedHosts = new Set([...LOOPBACK_HOSTS, context.extraHost]);
  const portSuffix = `:${context.port}`;
  const hostName = hostHeader.endsWith(portSuffix) ? hostHeader.slice(0, -portSuffix.length) : "";
  if (!allowedHosts.has(hostName)) {
    return { kind: "reject", status: 421, message: "Misdirected request: unexpected Host header" };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${hostHeader}`) {
    return { kind: "reject", status: 403, message: "Cross-origin requests are not allowed" };
  }
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const cookie = readCookie(req.headers.cookie, context.cookieName);
  const presented = bearer ?? cookie;
  return presented !== undefined && sameSecret(presented, context.token)
    ? { kind: "authorized" }
    : { kind: "anonymous" };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * The trajectory with timeline times. An unreadable timeline still shows the session —
 * untimed, with the reason in `timelineError` for the page to display.
 */
async function loadTrajectory(store: SessionStore, session: StoredSession) {
  try {
    const records = parseTimelineRecords(await store.readSideRecords(session.metadata.id, TIMELINE_FILE));
    return buildSessionTrajectory(session, records);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...buildSessionTrajectory(session), timelineError: `timeline unreadable: ${reason}` };
  }
}

export type McpServerView = Readonly<{
  name: string;
  transport?: string;
  source: string;
  /** idle: no live session has connected this server (servers connect when a session starts). */
  state: McpServerState | "idle";
  tools?: number;
  error?: string;
}>;

/**
 * Configured servers with the live session's connection states. A server the live
 * session connected but the config no longer lists still appears: it is what the agent has.
 */
export function withMcpStates(
  configured: readonly Readonly<{ name: string; transport: string; source: string }>[],
  live: McpStatusPayload | undefined,
): McpServerView[] {
  const byName = new Map(live?.servers.map((s) => [s.name, s]));
  const rows: McpServerView[] = configured.map((server) => {
    const state = byName.get(server.name);
    byName.delete(server.name);
    return state
      ? { ...server, state: state.state, tools: state.tools, ...(state.error !== undefined ? { error: state.error } : {}) }
      : { ...server, state: "idle" };
  });
  for (const state of byName.values()) rows.push({ ...state });
  return rows;
}

/** Paths shown in the page start at ~ so screenshots and shares do not carry the account name. */
export function displayPath(absolute: string, home: string = os.homedir()): string {
  if (absolute === home) return "~";
  return absolute.startsWith(home + path.sep) ? "~" + absolute.slice(home.length) : absolute;
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function unauthorizedPage(): string {
  return "<!doctype html><meta charset=utf-8><title>XioCode</title>"
    + "<body style=\"font:15px system-ui;max-width:32rem;margin:15vh auto;padding:0 16px\">"
    + "<h1 style=\"font-size:18px\">Open the link printed by <code>xio web</code></h1>"
    + "<p>The console only accepts the address shown in your terminal, which carries a one-time access token. "
    + "This keeps other web pages from reading your sessions or changing your settings.</p></body>";
}

/**
 * `[ui] language`, re-read per page load so a changed config applies on refresh. It also
 * sets the process language, which words the approval questions the agent host forwards.
 */
async function readUiLanguage(env: NodeJS.ProcessEnv, cwd: string): Promise<Language> {
  const config = await ensureConfigFile(env);
  const warning = applyConfiguredLanguage(parseXioConfig(config.content, { cwd }).xio.ui?.language);
  if (warning) process.stderr.write(`${warning}\n`);
  return getLanguage();
}

async function readDefaultModel(env: NodeJS.ProcessEnv, cwd: string): Promise<{ provider: string; id: string } | undefined> {
  const config = await ensureConfigFile(env);
  const general = parseXioConfig(config.content, { cwd }).xio.general;
  return general.defaultProvider && general.defaultModel
    ? { provider: general.defaultProvider, id: general.defaultModel }
    : undefined;
}

async function listMcpServers(env: NodeJS.ProcessEnv, cwd: string): Promise<{ name: string; transport: string; source: string }[]> {
  const config = await ensureConfigFile(env);
  const parsed = parseXioConfig(config.content, { cwd });
  const loaded = await loadMcpConfigs({
    cwd,
    home: env.HOME,
    config: { ...DEFAULT_MCP_CONFIG, ...toHygieneMcp(parsed.xio.mcp) },
  });
  return loaded.servers.map((server) => ({ name: server.name, transport: server.spec.transport, source: server.source }));
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
