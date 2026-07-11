import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HOOKS_CONFIG,
  interpretHookOutput,
  loadHooks,
  matcherMatches,
  registerHooksBridge,
  type HooksConfig,
} from "../src/hooks.ts";
import { registerXioHygiene } from "../src/index.ts";
import { ExtensionHost } from "../../../src/runtime/extension-host.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function config(partial: Partial<HooksConfig> = {}): HooksConfig {
  return { ...DEFAULT_HOOKS_CONFIG, ...partial };
}

async function writeSettings(
  root: string,
  relative: string,
  hooks: Record<string, unknown>,
): Promise<string> {
  const filePath = path.join(root, relative);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ hooks }, null, 2)}\n`, "utf8");
  return filePath;
}

async function writeHookScript(root: string, name: string, body: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, name);
  await writeFile(filePath, body, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

describe("matcherMatches", () => {
  it("matches empty, star, exact, and regex", () => {
    expect(matcherMatches(undefined, "bash")).toBe(true);
    expect(matcherMatches("*", "bash")).toBe(true);
    expect(matcherMatches("bash", "bash")).toBe(true);
    expect(matcherMatches("bash|write", "write")).toBe(true);
    expect(matcherMatches("bash|write", "read")).toBe(false);
    expect(matcherMatches("^ba.*", "bash")).toBe(true);
    expect(matcherMatches("^ba.*", "read")).toBe(false);
  });
});

describe("interpretHookOutput", () => {
  it("blocks PreToolUse on exit 2 using stderr", () => {
    expect(interpretHookOutput("PreToolUse", {
      exitCode: 2,
      stdout: "",
      stderr: "nope",
      timedOut: false,
    })).toEqual({ block: true, reason: "nope" });
  });

  it("blocks PreToolUse on JSON deny", () => {
    expect(interpretHookOutput("PreToolUse", {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "policy",
        },
      }),
      stderr: "",
      timedOut: false,
    })).toEqual({ block: true, reason: "policy", additionalContext: undefined });
  });

  it("reads SessionStart additionalContext", () => {
    expect(interpretHookOutput("SessionStart", {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "FROM_HOOK",
        },
      }),
      stderr: "",
      timedOut: false,
    })).toEqual({ additionalContext: "FROM_HOOK" });
  });
});

describe("loadHooks", () => {
  it("loads project settings and warns on unsupported events", async () => {
    const root = await tempRoot("xio-hooks-load-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: "true" }],
        },
      ],
      Notification: [
        {
          hooks: [{ type: "command", command: "true" }],
        },
      ],
    });

    const warnings: string[] = [];
    const loaded = await loadHooks({
      cwd,
      home,
      config: config(),
      warn: (message) => warnings.push(message),
    });

    expect(loaded.events.PreToolUse).toHaveLength(1);
    expect(loaded.unsupported).toEqual(["Notification"]);
    expect(warnings.some((message) => message.includes("unsupported event \"Notification\""))).toBe(true);
  });

  it("lets project settings override user settings per event", async () => {
    const root = await tempRoot("xio-hooks-override-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSettings(home, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: "echo user" }],
        },
      ],
    });
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "write",
          hooks: [{ type: "command", command: "echo project" }],
        },
      ],
    });

    const loaded = await loadHooks({ cwd, home, config: config() });
    expect(loaded.events.PreToolUse).toHaveLength(1);
    expect(loaded.events.PreToolUse[0]?.matcher).toBe("write");
    expect(loaded.events.PreToolUse[0]?.hooks[0]?.command).toBe("echo project");
  });

  it("returns empty when disabled", async () => {
    const root = await tempRoot("xio-hooks-disabled-");
    const loaded = await loadHooks({
      cwd: root,
      home: path.join(root, "home"),
      config: config({ enabled: false }),
    });
    expect(loaded.sources).toEqual([]);
    expect(loaded.events.PreToolUse).toEqual([]);
  });

  it("converts Claude timeout seconds to milliseconds", async () => {
    const root = await tempRoot("xio-hooks-timeout-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: "true", timeout: 3 }],
        },
      ],
    });

    const loaded = await loadHooks({ cwd, home, config: config() });
    expect(loaded.events.PreToolUse[0]?.hooks[0]?.timeoutMs).toBe(3_000);
  });

  it("skips invalid settings JSON without throwing", async () => {
    const root = await tempRoot("xio-hooks-bad-json-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const filePath = path.join(cwd, ".claude", "settings.json");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not-json", "utf8");

    const warnings: string[] = [];
    const loaded = await loadHooks({
      cwd,
      home,
      config: config(),
      warn: (message) => warnings.push(message),
    });
    expect(loaded.sources).toEqual([]);
    expect(warnings.some((message) => message.includes("invalid JSON"))).toBe(true);
  });
});

describe("registerHooksBridge", () => {
  it("blocks PreToolUse via exit 2 and records the run", async () => {
    const root = await tempRoot("xio-hooks-block-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const script = await writeHookScript(
      cwd,
      "block-bash.sh",
      `#!/bin/sh
input=$(cat)
echo "$input" | grep -q '"tool_name":"bash"' || exit 0
echo "blocked by fixture" >&2
exit 2
`,
    );
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: script }],
        },
      ],
    });

    const host = new ExtensionHost();
    const bridge = registerHooksBridge(
      { on: (event, handler) => host.on(event, handler) },
      { cwd, home, config: config() },
    );

    await host.emit("session_start", {});
    const results = await host.emit("tool_call", {
      toolName: "bash",
      input: { command: "echo hi" },
      call: { id: "1", name: "bash", args: { command: "echo hi" } },
    });

    expect(results.some((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      return record?.block === true && String(record.reason).includes("blocked by fixture");
    })).toBe(true);
    expect(bridge.getLastRuns().some((run) => run.event === "PreToolUse" && run.blocked === true)).toBe(true);

    const allowed = await host.emit("tool_call", {
      toolName: "read",
      input: { path: "README.md" },
      call: { id: "2", name: "read", args: { path: "README.md" } },
    });
    expect(allowed.every((item) => item === undefined || item === null)).toBe(true);
  });

  it("injects SessionStart additionalContext into before_agent_start", async () => {
    const root = await tempRoot("xio-hooks-session-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const script = await writeHookScript(
      cwd,
      "session-start.sh",
      `#!/bin/sh
cat >/dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"HOOK_SESSION_CONTEXT"}}'
`,
    );
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: script }],
        },
      ],
    });

    const host = new ExtensionHost();
    const bridge = registerHooksBridge(
      { on: (event, handler) => host.on(event, handler) },
      { cwd, home, config: config() },
    );

    await host.emit("session_start", { source: "startup" });
    expect(bridge.getSessionContext()).toContain("HOOK_SESSION_CONTEXT");

    host.setSystemPrompt("BASE_PROMPT");
    const before = await host.emit("before_agent_start", { systemPrompt: "BASE_PROMPT" });
    const prompt = before
      .map((item) => (item && typeof item === "object" ? (item as { systemPrompt?: string }).systemPrompt : undefined))
      .find((value) => typeof value === "string");
    expect(prompt).toContain("BASE_PROMPT");
    expect(prompt).toContain("HOOK_SESSION_CONTEXT");
    expect(prompt).toContain("xio-hooks:session-start");
  });

  it("runs PostToolUse and Stop without blocking the session", async () => {
    const root = await tempRoot("xio-hooks-post-stop-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const marker = path.join(cwd, "hook-ran.txt");
    const post = await writeHookScript(
      cwd,
      "post.sh",
      `#!/bin/sh
cat >/dev/null
echo post >> "${marker}"
`,
    );
    const stop = await writeHookScript(
      cwd,
      "stop.sh",
      `#!/bin/sh
cat >/dev/null
echo stop >> "${marker}"
`,
    );
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PostToolUse: [
        {
          matcher: "read",
          hooks: [{ type: "command", command: post }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: stop }],
        },
      ],
    });

    const host = new ExtensionHost();
    registerHooksBridge(
      { on: (event, handler) => host.on(event, handler) },
      { cwd, home, config: config() },
    );

    await host.emit("session_start", {});
    await host.emit("tool_result", {
      call: { id: "1", name: "read", args: { path: "a.ts" } },
      result: { content: [{ type: "text", text: "ok" }], isError: false },
    });
    await host.emit("agent_end", { success: true });

    const { readFile } = await import("node:fs/promises");
    const text = await readFile(marker, "utf8");
    expect(text).toContain("post");
    expect(text).toContain("stop");
  });

  it("keeps baseline behavior when no hooks are configured", async () => {
    const root = await tempRoot("xio-hooks-none-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });

    const host = new ExtensionHost();
    const bridge = registerHooksBridge(
      { on: (event, handler) => host.on(event, handler) },
      { cwd, home, config: config() },
    );

    const start = await host.emit("session_start", {});
    expect(start[0]).toMatchObject({ hooks: { enabled: true, sources: [] } });
    expect(bridge.getSessionContext()).toBe("");

    const tool = await host.emit("tool_call", {
      toolName: "bash",
      input: { command: "true" },
      call: { id: "1", name: "bash", args: { command: "true" } },
    });
    expect(tool.every((item) => item === undefined)).toBe(true);
  });
});

describe("registerXioHygiene hooks wiring", () => {
  it("wires hooks through hygiene registration", async () => {
    const root = await tempRoot("xio-hooks-hygiene-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const script = await writeHookScript(
      cwd,
      "block.sh",
      `#!/bin/sh
cat >/dev/null
echo hygiene-block >&2
exit 2
`,
    );
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: script }],
        },
      ],
    });

    const host = new ExtensionHost();
    const reg = registerXioHygiene(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home,
        agentsMd: { enabled: false },
        skills: { enabled: false },
        hooks: config(),
      },
    );

    await host.emit("session_start", {});
    const results = await host.emit("tool_call", {
      toolName: "bash",
      input: { command: "rm -rf /" },
      call: { id: "1", name: "bash", args: { command: "rm -rf /" } },
    });
    expect(results.some((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      return record?.block === true;
    })).toBe(true);
    expect(reg.getHooks()?.getLastRuns().some((run) => run.blocked)).toBe(true);
  });

  it("does not register hooks when disabled", async () => {
    const root = await tempRoot("xio-hooks-off-");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await writeSettings(cwd, path.join(".claude", "settings.json"), {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: "echo should-not-run >&2; exit 2" }],
        },
      ],
    });

    const host = new ExtensionHost();
    const reg = registerXioHygiene(
      { on: (event, handler) => host.on(event, handler) },
      {
        cwd,
        home,
        agentsMd: { enabled: false },
        skills: { enabled: false },
        hooks: config({ enabled: false }),
      },
    );

    expect(reg.getHooks()).toBeUndefined();
    await host.emit("session_start", {});
    const results = await host.emit("tool_call", {
      toolName: "bash",
      input: { command: "true" },
      call: { id: "1", name: "bash", args: { command: "true" } },
    });
    expect(results.every((item) => item === undefined)).toBe(true);
  });
});
