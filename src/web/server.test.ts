import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { startWebServer } from "./server.ts";
import { parseWebCliArgs } from "../cli/web-cli.ts";
import { SessionStore } from "../runtime/session-store.ts";

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
    return new SessionStore({ root: path.join(root, "sessions") });
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

  it("serves the SPA UI and API endpoints", async () => {
    const store = await createTempStore();
    const handle = await startWebServer({
      port: 0, // dynamic port for tests
      host: "127.0.0.1",
      store,
    });
    openServers.push(handle);

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toContain(`http://127.0.0.1:${handle.port}`);

    // 1. Test GET /
    const rootRes = await fetch(`${handle.url}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    const html = await rootRes.text();
    expect(html).toContain("XioCode Web");
    expect(html).toContain("chat-messages");

    // 2. Test GET /api/status
    const statusRes = await fetch(`${handle.url}/api/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.status).toBe("ok");
    expect(statusData.version).toBeDefined();

    // 3. Test POST & GET /api/sessions
    const postRes = await fetch(`${handle.url}/api/sessions`, { method: "POST" });
    expect(postRes.status).toBe(201);
    const postData = await postRes.json();
    expect(postData.id).toBeDefined();

    const listRes = await fetch(`${handle.url}/api/sessions`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.some((s: { id: string }) => s.id === postData.id)).toBe(true);

    // 4. Test GET /api/sessions/:id
    const detailRes = await fetch(`${handle.url}/api/sessions/${postData.id}`);
    expect(detailRes.status).toBe(200);
    const detailData = await detailRes.json();
    expect(detailData.metadata.id).toBe(postData.id);

    // 5. Test POST /api/sessions/:id/prompt
    const promptRes = await fetch(`${handle.url}/api/sessions/${postData.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello from web client" }),
    });
    expect(promptRes.status).toBe(202);

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
    expect(rulesData.path).toBeDefined();

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
    expect(Array.isArray(extData.extensions)).toBe(true);
    expect(extData.extensions.some((e: { id: string }) => e.id === "xio-eval")).toBe(true);
  });
});
