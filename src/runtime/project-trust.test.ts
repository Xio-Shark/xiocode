import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decideTrust,
  defaultTrustStorePath,
  ensureProjectTrust,
  grantTrust,
  loadTrustStore,
  normalizeTrustPath,
  parseTrustMode,
  revokeTrust,
  allowsProjectResources,
} from "./project-trust.ts";
import { ExtensionHost } from "./extension-host.ts";
import { registerToolPermissionGate, toolNeedsTrustGate } from "./tool-permission.ts";
import { discoverSkills } from "../../extensions/xio-hygiene/src/skills.ts";
import { loadHooks } from "../../extensions/xio-hygiene/src/hooks.ts";
import { loadAgentsMd } from "../../extensions/xio-hygiene/src/agents-md.ts";
import { loadMcpConfigs } from "../../extensions/xio-hygiene/src/mcp.ts";
import { parseXioConfig } from "../cli/config-parser.ts";

import type { InteractiveIO } from "./interactive-io.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeIo(answers: boolean[] = []): InteractiveIO & { asks: string[] } {
  const queue = [...answers];
  const asks: string[] = [];
  return {
    asks,
    ask: async (question) => {
      asks.push(question);
      return queue.shift() ?? false;
    },
    select: async () => undefined,
    prompt: async () => undefined,
  };
}

function blocked(results: readonly unknown[]): boolean {
  return results.some((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { block?: boolean }).block === true;
  });
}

describe("parseTrustMode / config", () => {
  it("parses [trust] mode with ask default", () => {
    expect(parseTrustMode("ASK")).toBe("ask");
    expect(parseTrustMode("off")).toBe("off");
    expect(parseXioConfig("", { cwd: "/repo" }).runtimeConfig.trust).toEqual({ mode: "ask" });
    expect(parseXioConfig(`[trust]\nmode = "trust"\n`, { cwd: "/repo" }).runtimeConfig.trust)
      .toEqual({ mode: "trust" });
    expect(() => parseXioConfig(`[trust]\nmode = "maybe"\n`, { cwd: "/repo" }))
      .toThrow(/trust\.mode/);
  });
});

describe("TrustStore", () => {
  it("persists and revokes trust by normalized path", async () => {
    const home = await tempRoot("xio-trust-home-");
    const cwd = await tempRoot("xio-trust-cwd-");
    const storePath = defaultTrustStorePath(home);

    const granted = await grantTrust({ cwd, storePath, home });
    expect(granted.decision).toBe("trusted");
    expect(granted.persisted).toBe(true);

    const store = await loadTrustStore(storePath);
    expect(store.entries[normalizeTrustPath(cwd)]?.level).toBe("trusted");

    const decided = decideTrust({ cwd, mode: "ask", store });
    expect(decided.decision).toBe("trusted");

    await revokeTrust({ cwd, storePath, home });
    const after = await loadTrustStore(storePath);
    expect(after.entries[normalizeTrustPath(cwd)]).toBeUndefined();
    expect(decideTrust({ cwd, mode: "ask", store: after }).decision).toBe("untrusted");
  });

  it("covers children when coverChildren is set", async () => {
    const { mkdir } = await import("node:fs/promises");
    const home = await tempRoot("xio-trust-parent-");
    const parent = await tempRoot("xio-trust-parent-cwd-");
    const child = path.join(parent, "pkg");
    await mkdir(child, { recursive: true });
    const storePath = defaultTrustStorePath(home);
    await grantTrust({ cwd: parent, storePath, home, coverChildren: true });
    const store = await loadTrustStore(storePath);
    expect(decideTrust({ cwd: child, mode: "ask", store }).decision).toBe("trusted");
  });

  it("mode trust/off always trusts; ask unknown stays untrusted without prompt", async () => {
    const cwd = await tempRoot("xio-trust-mode-");
    expect(decideTrust({ cwd, mode: "trust" }).decision).toBe("trusted");
    expect(decideTrust({ cwd, mode: "off" }).decision).toBe("trusted");
    expect(decideTrust({ cwd, mode: "ask" }).decision).toBe("untrusted");
    expect(allowsProjectResources("untrusted")).toBe(false);
    expect(allowsProjectResources("session_only")).toBe(true);
  });

  it("ensureProjectTrust asks once and persists on yes", async () => {
    const home = await tempRoot("xio-trust-ask-");
    const cwd = await tempRoot("xio-trust-ask-cwd-");
    const storePath = defaultTrustStorePath(home);
    const io = fakeIo([true]);
    const notices: string[] = [];

    const state = await ensureProjectTrust({
      cwd,
      mode: "ask",
      home,
      storePath,
      interactiveSession: true,
      ask: (q, d) => io.ask(q, d),
      notify: (m) => notices.push(m),
    });
    expect(state.decision).toBe("trusted");
    expect(io.asks).toHaveLength(1);
    expect(notices.some((n) => n.includes("granted"))).toBe(true);

    const again = await ensureProjectTrust({
      cwd,
      mode: "ask",
      home,
      storePath,
      interactiveSession: true,
      ask: () => {
        throw new Error("should not ask again");
      },
    });
    expect(again.decision).toBe("trusted");
    expect(again.persisted).toBe(true);
  });

  it("non-interactive ask mode stays untrusted without crashing", async () => {
    const home = await tempRoot("xio-trust-np-");
    const cwd = await tempRoot("xio-trust-np-cwd-");
    const state = await ensureProjectTrust({
      cwd,
      mode: "ask",
      home,
      storePath: defaultTrustStorePath(home),
      interactiveSession: false,
    });
    expect(state.decision).toBe("untrusted");
  });
});

describe("hygiene includeProject=false", () => {
  it("skips project skills/hooks/agents/mcp while keeping user paths loadable", async () => {
    const { mkdir } = await import("node:fs/promises");
    const home = await tempRoot("xio-trust-hyg-home-");
    const cwd = await tempRoot("xio-trust-hyg-cwd-");

    await mkdir(path.join(cwd, ".claude", "skills", "proj-skill"), { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "# project agents\n", "utf8");
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { proj: { command: "echo", args: ["1"] } } }),
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo block" }] }],
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".claude", "skills", "proj-skill", "SKILL.md"),
      "---\nname: proj-skill\ndescription: project only\n---\nbody\n",
      "utf8",
    );

    const agents = await loadAgentsMd({
      cwd,
      home,
      config: { enabled: true, readClaudeDirs: true, maxBytes: 65_536, maxImportDepth: 3 },
      includeProject: false,
    });
    expect(agents.text).not.toContain("project agents");

    const skills = await discoverSkills({
      cwd,
      home,
      config: { enabled: true, readClaude: true, readCursor: true, maxBodyBytes: 32_768 },
      includeProject: false,
    });
    expect(skills.skills.map((s) => s.name)).not.toContain("proj-skill");

    const hooks = await loadHooks({
      cwd,
      home,
      config: { enabled: true, readClaude: true, timeoutMs: 5_000 },
      includeProject: false,
    });
    expect(hooks.sources.every((s) => !s.startsWith(cwd))).toBe(true);
    expect(hooks.events.PreToolUse).toEqual([]);

    const mcp = await loadMcpConfigs({
      cwd,
      home,
      config: {
        enabled: true,
        readClaude: false,
        readCursor: false,
        failClosed: false,
        unknownSourceFailClosed: false,
        timeoutMs: 30_000,
      },
      includeProject: false,
    });
    expect(mcp.servers.map((s) => s.name)).not.toContain("proj");

    // Trusted path still loads project resources.
    const agentsTrusted = await loadAgentsMd({
      cwd,
      home,
      config: { enabled: true, readClaudeDirs: true, maxBytes: 65_536, maxImportDepth: 3 },
      includeProject: true,
    });
    expect(agentsTrusted.text).toContain("project agents");
  });
});

describe("tool permission + trust", () => {
  it("marks write/exec tools as trust-gated", () => {
    expect(toolNeedsTrustGate("write")).toBe(true);
    expect(toolNeedsTrustGate("bash")).toBe(true);
    expect(toolNeedsTrustGate("mcp__x__y")).toBe(true);
    expect(toolNeedsTrustGate("read")).toBe(false);
    expect(toolNeedsTrustGate("grep")).toBe(false);
  });

  it("denies write/exec when untrusted in non-interactive session", async () => {
    const host = new ExtensionHost();
    registerToolPermissionGate({
      host,
      interactive: fakeIo(),
      sink: {},
      getMode: () => "auto",
      interactiveSession: false,
      getTrust: () => "untrusted",
    });

    const writeBlocked = await host.emit("tool_call", {
      toolName: "write",
      call: { id: "1", name: "write", args: { path: "a.ts", content: "x" } },
    });
    expect(blocked(writeBlocked)).toBe(true);

    const bashBlocked = await host.emit("tool_call", {
      toolName: "bash",
      call: { id: "2", name: "bash", args: { command: "echo hi" } },
    });
    expect(blocked(bashBlocked)).toBe(true);

    const readOk = await host.emit("tool_call", {
      toolName: "read",
      call: { id: "3", name: "read", args: { path: "a.ts" } },
    });
    expect(blocked(readOk)).toBe(false);
  });

  it("allows write/exec when trusted (normal high-risk path)", async () => {
    const host = new ExtensionHost();
    registerToolPermissionGate({
      host,
      interactive: fakeIo(),
      sink: {},
      getMode: () => "auto",
      interactiveSession: false,
      getTrust: () => "trusted",
      highRiskPolicy: "deny",
    });

    const writeOk = await host.emit("tool_call", {
      toolName: "write",
      call: { id: "1", name: "write", args: {} },
    });
    expect(blocked(writeOk)).toBe(false);

    const bashBlocked = await host.emit("tool_call", {
      toolName: "bash",
      call: { id: "2", name: "bash", args: {} },
    });
    expect(blocked(bashBlocked)).toBe(true);
  });
});

describe("zero-threshold non-git cwd", () => {
  it("decideTrust works without a git repository", async () => {
    const cwd = await tempRoot("xio-trust-nogit-");
    // No git init — still a valid trust target.
    const state = decideTrust({ cwd, mode: "off" });
    expect(state.decision).toBe("trusted");
    expect(state.normalizedPath).toBe(normalizeTrustPath(cwd));
  });
});
