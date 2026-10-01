import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../runtime/session-store.ts";
import { closeKernelSession } from "../runtime/process/index.ts";
import { TIMELINE_FILE } from "../runtime/session-timeline.ts";
import { AgentHostBusyError, WebAgentHost, type WebEvent } from "./agent-host.ts";
import { buildSessionTrajectory } from "./trajectory.ts";
import { parseTimelineRecords } from "./trajectory-timing.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeKernelSession();
});

/** OpenAI-compatible stub: first request asks for one bash call, later ones answer "done". */
async function startFakeProvider(command: string): Promise<{ baseUrl: string; requests: number; headers: http.IncomingHttpHeaders[] }> {
  const state = { requests: 0, headers: [] as http.IncomingHttpHeaders[] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      state.requests += 1;
      state.headers.push(req.headers);
      const request = JSON.parse(body || "{}") as { stream?: boolean; messages?: { role: string }[] };
      const answered = (request.messages ?? []).some((m) => m.role === "tool");
      const call = { index: 0, id: "call_0", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } };
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (delta: object, finish: string | null) =>
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        if (answered) send({ role: "assistant", content: "done" }, null);
        else send({ role: "assistant", tool_calls: [call] }, null);
        send({}, answered ? "stop" : "tool_calls");
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const message = answered
        ? { role: "assistant", content: "done" }
        : { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: call.function }] };
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: answered ? "stop" : "tool_calls" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  return Object.defineProperty({ baseUrl: `http://127.0.0.1:${port}/v1`, headers: state.headers }, "requests", { get: () => state.requests }) as {
    baseUrl: string;
    requests: number;
    headers: http.IncomingHttpHeaders[];
  };
}

function setup(baseUrl: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "xio-agent-host-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "ws");
  mkdirSync(path.join(home, ".xiocode"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(path.join(home, ".xiocode", "config.toml"), [
    "[general]", 'default_provider = "local"', 'default_model = "stub"', "",
    "[providers.local]", 'kind = "openai"', `base_url = "${baseUrl}"`, 'model = "stub"', 'api_key_env = "XIO_TEST_KEY"', 'session_header = "x-conversation"', "",
    "[trust]", 'mode = "trust"', "",
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: workspace });
  // Never reach a real provider: drop every inherited API key and pin the config file
  // (the config path follows XIO_CONFIG / os.homedir(), not XIO_HOME).
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_API_KEY$|_TOKEN$/.test(key)));
  const env = {
    ...inherited,
    HOME: home,
    XIO_HOME: path.join(home, ".xiocode"),
    XIO_CONFIG: path.join(home, ".xiocode", "config.toml"),
    XIO_TEST_KEY: "x",
  };
  const store = new SessionStore({ root: path.join(home, ".xiocode", "sessions") });
  return { workspace, env, store };
}

function waitFor(events: WebEvent[], name: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (events.some((event) => event.event === name)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`no ${name}; saw ${events.map((e) => e.event).join(",")}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe.skipIf(process.platform === "win32")("WebAgentHost", () => {
  it("runs a real turn, routes permission questions through the browser and persists the session", async () => {
    const provider = await startFakeProvider("touch web-made.txt && echo made");
    const { workspace, env, store } = setup(provider.baseUrl);
    const events: WebEvent[] = [];
    const questions: string[] = [];
    let host: WebAgentHost;
    host = new WebAgentHost({
      cwd: workspace,
      env,
      store,
      broadcast: (_sessionId, event) => {
        events.push(event as WebEvent);
        if (event.event === "web.approval") {
          const payload = event.payload as { id: string; question: string; detail?: string };
          questions.push(`${payload.question}\n${payload.detail ?? ""}`);
          setImmediate(() => host.answerApproval("web-1", payload.id, { approve: true }));
        }
        return 1;
      },
    });
    cleanups.push(() => host.close());

    await host.prompt("web-1", "make a file");
    await expect(host.prompt("web-1", "again")).rejects.toBeInstanceOf(AgentHostBusyError);
    await waitFor(events, "web.idle");

    expect(provider.requests).toBeGreaterThan(0);
    // Every provider call says who is calling and which conversation it belongs to.
    expect(provider.headers.every((h) => /^xiocode\//.test(String(h["user-agent"])))).toBe(true);
    expect(new Set(provider.headers.map((h) => h["x-conversation"]))).toEqual(new Set(["web-1"]));
    expect(existsSync(path.join(workspace, "web-made.txt"))).toBe(true);
    const names = events.map((event) => event.event);
    expect(names).toEqual(expect.arrayContaining(["turn.start", "tool.call", "tool.result", "text.delta", "run.end", "web.turn_end"]));
    expect(events.find((e) => e.event === "web.turn_end")?.payload).toMatchObject({ success: true, cancelled: false });
    // One question, and it shows the exact command — no blind "allow bash for this session".
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("touch web-made.txt && echo made");

    await host.close();
    const saved = await store.load("web-1");
    expect(saved.messages.some((m) => m.role === "user" && m.content === "make a file")).toBe(true);
    expect(saved.messages.some((m) => m.role === "assistant" && m.content === "done")).toBe(true);

    // The run left a timeline, and every step of the transcript lands on it.
    const timeline = parseTimelineRecords(await store.readSideRecords("web-1", TIMELINE_FILE));
    expect(timeline.map((r) => r.event)).toEqual(expect.arrayContaining(
      ["turn.start", "provider.request", "provider.done", "tool.call", "tool.result", "turn.end"],
    ));
    const trajectory = buildSessionTrajectory(saved, timeline);
    expect(trajectory.steps.filter((step) => !step.startedAt)).toEqual([]);
    expect(trajectory.stats.timedSteps).toBe(trajectory.steps.length);
    expect(trajectory.stats.activeMs).toBeGreaterThan(0);
    const tool = trajectory.steps.find((step) => step.type === "tool")!;
    expect(Date.parse(tool.endedAt!)).toBeGreaterThanOrEqual(Date.parse(tool.startedAt!));
  }, 40_000);

  it("denies permission questions nobody can see instead of hanging", async () => {
    const provider = await startFakeProvider("touch should-not-exist.txt");
    const { workspace, env, store } = setup(provider.baseUrl);
    const events: WebEvent[] = [];
    const host = new WebAgentHost({
      cwd: workspace,
      env,
      store,
      broadcast: (_sessionId, event) => {
        events.push(event as WebEvent);
        return event.event === "web.approval" ? 0 : 1;
      },
    });
    cleanups.push(() => host.close());

    await host.prompt("web-2", "make a file");
    await waitFor(events, "web.idle");
    expect(existsSync(path.join(workspace, "should-not-exist.txt"))).toBe(false);
    expect(events.some((e) => e.event === "web.notice" && String(e.payload.message).includes("no browser is connected"))).toBe(true);
  }, 40_000);
});
