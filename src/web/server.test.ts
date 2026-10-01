import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import http from "node:http";

import { displayPath, startWebServer, withMcpStates, type WebServerHandle } from "./server.ts";
import { parseWebCliArgs } from "../cli/web-cli.ts";
import { SessionStore } from "../runtime/session-store.ts";
import { THINKING_LEVELS } from "../runtime/thinking.ts";
import { PROVIDER_PRESETS } from "../cli/provider-catalog.ts";

describe("Web Console & Server", () => {
  const tempDirs: string[] = [];
  const openServers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const s of openServers) {
      await s.close().catch(() => {});
    }
    openServers.length = 0;
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  async function createTempStore() {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-web-test-"));
    tempDirs.push(root);
    // The server reads and writes `<cwd>/AGENTS.md`; without an explicit cwd the
    // rules test rewrote the repository's own AGENTS.md on every run.
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    return {
      store: new SessionStore({ root: path.join(root, "sessions") }),
      project,
    };
  }

  it("parses CLI args correctly", () => {
    expect(parseWebCliArgs([])).toEqual({ port: undefined, host: undefined, open: true });
    expect(parseWebCliArgs(["--no-open"])).toEqual({ port: undefined, host: undefined, open: false });
    expect(parseWebCliArgs(["--port", "4000", "--host", "0.0.0.0"])).toEqual({
      port: 4000,
      host: "0.0.0.0",
      open: true,
    });
    expect(parseWebCliArgs(["--port=5000", "--host=localhost", "--no-open"])).toEqual({
      port: 5000,
      host: "localhost",
      open: false,
    });
  });

  function fakeAgentHost() {
    const calls: string[] = [];
    return {
      calls,
      host: {
        activeSessionId: undefined as string | undefined,
        prompt: async (id: string, text: string) => { calls.push(`prompt:${id}:${text}`); },
        abort: (id: string) => { calls.push(`abort:${id}`); return false; },
        answerApproval: () => false,
        close: async () => undefined,
        isRunning: () => false,
        permissionMode: undefined,
        setPermissionMode: (mode: "auto" | "strict" | "full") => { calls.push(`mode:${mode}`); return mode; },
        getCostSummary: () => undefined,
      },
    };
  }

  /** Raw request so tests can forge Host / Origin headers that fetch() would not send. */
  function rawRequest(handle: WebServerHandle, options: http.RequestOptions & { body?: string }) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: handle.port, ...options }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  it("refuses anonymous, rebinding and cross-site requests; exchanges the launch token for a same-site cookie", async () => {
    const { store, project } = await createTempStore();
    const handle = await startWebServer({ port: 0, host: "127.0.0.1", store, cwd: project, agentHost: fakeAgentHost().host });
    openServers.push(handle);

    expect(handle.launchUrl).toBe(`${handle.url}/?token=${encodeURIComponent(handle.token)}`);

    const anonymousApi = await fetch(`${handle.url}/api/sessions`);
    expect(anonymousApi.status).toBe(401);
    expect(anonymousApi.headers.get("access-control-allow-origin")).toBeNull();
    const anonymousPage = await fetch(`${handle.url}/`);
    expect(anonymousPage.status).toBe(401);
    expect(await anonymousPage.text()).not.toContain("chat-messages");
    expect((await fetch(`${handle.url}/?token=wrong`)).status).toBe(401);

    const exchange = await fetch(handle.launchUrl, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`xio_web_${handle.port}=${handle.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const cookieHeader = cookie.split(";")[0]!;
    expect((await fetch(`${handle.url}/api/sessions`, { headers: { cookie: cookieHeader } })).status).toBe(200);

    // DNS rebinding: the browser sends the attacker's hostname as Host.
    const rebound = await rawRequest(handle, { path: "/api/sessions", headers: { host: `evil.example:${handle.port}`, cookie: cookieHeader } });
    expect(rebound.status).toBe(421);
    // CSRF: a page elsewhere posting with the user's cookie.
    const crossSite = await rawRequest(handle, {
      method: "POST",
      path: "/api/settings",
      headers: { host: `127.0.0.1:${handle.port}`, origin: "https://evil.example", cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ general: { defaultModel: "pwned" } }),
    });
    expect(crossSite.status).toBe(403);
  });

  it("serves the SPA UI and API endpoints", async () => {
    const { store, project } = await createTempStore();
    const agent = fakeAgentHost();
    const handle = await startWebServer({
      port: 0, // dynamic port for tests
      host: "127.0.0.1",
      store,
      cwd: project,
      agentHost: agent.host,
    });
    openServers.push(handle);
    const auth = { authorization: `Bearer ${handle.token}` };
    const fetch = (url: string, init: RequestInit = {}) =>
      globalThis.fetch(url, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toContain(`http://127.0.0.1:${handle.port}`);

    // 1. Test GET /
    const rootRes = await fetch(`${handle.url}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    const html = await rootRes.text();
    expect(html).toContain("<title>XioCode 控制台</title>");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).toContain("chat-messages");
    // Self-contained page: every stylesheet and script is inlined.
    expect(html).not.toMatch(/<script src=|<link rel="stylesheet"/);

    // 2. Test GET /api/status
    const statusRes = await fetch(`${handle.url}/api/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.status).toBe("ok");
    expect(statusData.version).toBeDefined();

    // 2b. Test GET /api/events (SSE)
    const eventsRes = await fetch(`${handle.url}/api/events`);
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");
    // close SSE stream
    await eventsRes.body?.cancel();

    // 3. POST /api/sessions hands out an id but persists nothing until the first prompt
    const postRes = await fetch(`${handle.url}/api/sessions`, { method: "POST" });
    expect(postRes.status).toBe(201);
    const draft = await postRes.json();
    expect(draft.id).toBeDefined();
    expect(draft.model?.id).not.toBe("claude-3-7-sonnet");
    const listRes = await fetch(`${handle.url}/api/sessions`);
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).some((s: { id: string }) => s.id === draft.id)).toBe(false);

    // A stored session (what the agent writes on its first turn)
    const postData = { id: draft.id as string };
    await store.save({ id: postData.id, model: { provider: "local", id: "stub" }, cwd: project, mainRoot: project, messages: [] });

    // 4. Test GET /api/sessions/:id
    const detailRes = await fetch(`${handle.url}/api/sessions/${postData.id}`);
    expect(detailRes.status).toBe(200);
    const detailData = await detailRes.json();
    expect(detailData.metadata.id).toBe(postData.id);
    expect(Array.isArray(detailData.trajectory)).toBe(true);
    expect(detailData.stats).toBeDefined();
    expect(detailData.cost).toBe("未计价");
    expect(detailData.running).toBe(false);

    // 4b. Test GET /api/sessions/:id/trajectory
    const trajRes = await fetch(`${handle.url}/api/sessions/${postData.id}/trajectory`);
    expect(trajRes.status).toBe(200);
    const trajData = await trajRes.json();
    expect(trajData.id).toBe(postData.id);
    expect(trajData.stats).toBeDefined();
    expect(Array.isArray(trajData.steps)).toBe(true);

    // 4c. Test GET /api/sessions/:id/log
    const logRes = await fetch(`${handle.url}/api/sessions/${postData.id}/log`);
    expect(logRes.status).toBe(200);
    expect(logRes.headers.get("content-disposition")).toContain("attachment");
    const logData = await logRes.json();
    expect(logData.id).toBe(postData.id);
    expect(logData.exported_at).toBeDefined();

    // 5. Test POST /api/sessions/:id/prompt
    const promptRes = await fetch(`${handle.url}/api/sessions/${postData.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello from web client" }),
    });
    expect(promptRes.status).toBe(202);
    expect(agent.calls).toContain(`prompt:${postData.id}:hello from web client`);
    const abortRes = await fetch(`${handle.url}/api/sessions/${postData.id}/abort`, { method: "POST" });
    expect(abortRes.status).toBe(409);
    const modeRes = await fetch(`${handle.url}/api/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "strict" }),
    });
    expect(await modeRes.json()).toEqual({ mode: "strict" });
    expect(agent.calls).toContain("mode:strict");
    expect((await fetch(`${handle.url}/api/permission`, { method: "POST", body: JSON.stringify({ mode: "yolo-ish" }) })).status).toBe(400);

    // 6. Test DELETE /api/sessions/:id
    const delRes = await fetch(`${handle.url}/api/sessions/${postData.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const listAfterDel = await fetch(`${handle.url}/api/sessions`);
    const remaining = await listAfterDel.json();
    expect(remaining.some((s: { id: string }) => s.id === postData.id)).toBe(false);

    // 7. Test GET /api/settings
    const settingsGetRes = await fetch(`${handle.url}/api/settings`);
    expect(settingsGetRes.status).toBe(200);
    const settingsData = await settingsGetRes.json();
    expect(settingsData.general).toBeDefined();
    expect(settingsData.general.defaultProvider).toBeDefined();
    expect(Array.isArray(settingsData.providers)).toBe(true);

    // 8. Test POST /api/settings
    const settingsPostRes = await fetch(`${handle.url}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        general: {
          defaultProvider: "openai",
          defaultModel: "gpt-4.1",
          defaultThinkingLevel: "high",
          maxTurns: 30,
        },
        permissions: {
          allowHighRisk: true,
        },
      }),
    });
    expect(settingsPostRes.status).toBe(200);
    const postSettingsResData = await settingsPostRes.json();
    expect(postSettingsResData.status).toBe("ok");

    // Verify settings updated
    const settingsGetRes2 = await fetch(`${handle.url}/api/settings`);
    const settingsData2 = await settingsGetRes2.json();
    expect(settingsData2.general.defaultProvider).toBe("openai");
    expect(settingsData2.general.defaultModel).toBe("gpt-4.1");
    expect(settingsData2.general.defaultThinkingLevel).toBe("high");
    expect(settingsData2.general.maxTurns).toBe(30);
    expect(settingsData2.permissions.allowHighRisk).toBe(true);

    // 9. Test GET & POST /api/rules
    const rulesGetRes = await fetch(`${handle.url}/api/rules`);
    expect(rulesGetRes.status).toBe(200);
    const rulesData = await rulesGetRes.json();
    expect(rulesData.path).toBe(path.join(project, "AGENTS.md"));

    const rulesPostRes = await fetch(`${handle.url}/api/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Custom AGENTS.md rules for test\n" }),
    });
    expect(rulesPostRes.status).toBe(200);

    const rulesGetRes2 = await fetch(`${handle.url}/api/rules`);
    const rulesData2 = await rulesGetRes2.json();
    expect(rulesData2.content).toContain("# Custom AGENTS.md rules for test");

    // 10. Test GET /api/extensions
    const extRes = await fetch(`${handle.url}/api/extensions`);
    expect(extRes.status).toBe(200);
    const extData = await extRes.json();
    expect(extData.extensions.map((e: { id: string }) => e.id).sort()).toEqual(["xio-evolve", "xio-hygiene", "xio-sandbox", "xio-setup"]);
    expect(JSON.stringify(extData)).not.toContain("deepseek-harness");
    expect(Array.isArray(extData.mcpServers)).toBe(true);
    expect(extData.mcpSessionId).toBeNull();
  });

  it("serves the provider catalog and thinking levels, and saves a preset provider with its own kind", async () => {
    const { store, project } = await createTempStore();
    const handle = await startWebServer({ port: 0, store, cwd: project, agentHost: fakeAgentHost().host });
    openServers.push(handle);
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    const settings = await (await globalThis.fetch(`${handle.url}/api/settings`, { headers })).json();
    expect(settings.thinkingLevels).toEqual([...THINKING_LEVELS]);
    expect(settings.catalog.map((p: { id: string }) => p.id)).toEqual(
      PROVIDER_PRESETS.filter((p) => !p.custom).map((p) => p.id),
    );

    const save = await globalThis.fetch(`${handle.url}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: { name: "anthropic", model: "claude-sonnet-4-20250514" } }),
    });
    expect(save.status).toBe(200);
    const config = await readFile(process.env.XIO_CONFIG ?? path.join(os.homedir(), ".xiocode", "config.toml"), "utf8");
    const block = /\[providers\.anthropic\][\s\S]*?(?=\n\[|$)/.exec(config)?.[0] ?? "";
    expect(block).toContain('kind = "anthropic"');
    expect(block).toContain('api_key_env = "ANTHROPIC_API_KEY"');
  });

  it("reports a failing git diff as an error, not as an empty diff", async () => {
    const { store, project } = await createTempStore();
    const handle = await startWebServer({ port: 0, store, cwd: project, agentHost: fakeAgentHost().host });
    openServers.push(handle);
    const res = await globalThis.fetch(`${handle.url}/api/workspace/diff`, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/git diff failed/);
  });

  it("lists untracked files next to the diff", async () => {
    const { store, project } = await createTempStore();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
    await writeFile(path.join(project, "new.txt"), "hello\n");
    const handle = await startWebServer({ port: 0, store, cwd: project, agentHost: fakeAgentHost().host });
    openServers.push(handle);
    const res = await globalThis.fetch(`${handle.url}/api/workspace/diff`, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ diff: "", untracked: ["new.txt"] });
  });

  it("puts the live session's MCP connection states on the configured servers", () => {
    const configured = [
      { name: "docs", transport: "http", source: "config" },
      { name: "browser", transport: "stdio", source: "claude-user" },
      { name: "later", transport: "stdio", source: "project" },
    ];
    const rows = withMcpStates(configured, {
      servers: [
        { name: "docs", source: "config", state: "ok", tools: 3 },
        { name: "browser", source: "claude-user", state: "failed", tools: 0, error: "spawn ENOENT" },
        { name: "gone", source: "config", state: "connecting", tools: 0 },
      ],
    });
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ["docs", "ok"], ["browser", "failed"], ["later", "idle"], ["gone", "connecting"],
    ]);
    expect(rows[0]).toMatchObject({ transport: "http", tools: 3 });
    expect(rows[1]?.error).toBe("spawn ENOENT");
    // Without a live session nothing has connected yet.
    expect(withMcpStates(configured, undefined).every((r) => r.state === "idle")).toBe(true);
  });

  it("shows home-directory paths from ~", () => {
    expect(displayPath("/home/me/.xiocode/config.toml", "/home/me")).toBe("~/.xiocode/config.toml");
    expect(displayPath("/home/me", "/home/me")).toBe("~");
    expect(displayPath("/home/meadow/x", "/home/me")).toBe("/home/meadow/x");
    expect(displayPath("/etc/xio.toml", "/home/me")).toBe("/etc/xio.toml");
  });

  it("renders valid client-side javascript without syntax errors", async () => {
    const { renderUiScript } = await import("./ui-template.ts");
    const script = renderUiScript({ defaultSessionId: "test-session" });
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
});
