import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadCredentials, saveProviderCredential } from "./credentials.ts";
import { runModelsCli } from "./models-cli.ts";

describe("runModelsCli", () => {
  it("reports refresh failures and refuses contradictory flags", async () => {
    const out: string[] = [];
    const writeErr = (s: string) => { out.push(s); };
    expect(await runModelsCli({ env: {}, refresh: true, catalogOnly: true, writeErr })).toBe(1);
    expect(out.join("")).toContain("cannot be combined");
    out.length = 0;
    expect(await runModelsCli({ env: { OPENAI_API_KEY: "test" }, refresh: true,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
      write: () => undefined, writeErr })).toBe(1);
    expect(out.join("")).toContain("503");
  });
  it("prints catalog provider/model lines without launching a session", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runModelsCli({
      env: {},
      catalogOnly: true,
      write: (chunk) => out.push(chunk),
      writeErr: (chunk) => err.push(chunk),
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("");
    expect(text).toContain("deepseek/deepseek-chat");
    expect(text).toContain("anthropic/claude-sonnet-4-20250514");
    expect(text).toContain("openai/gpt-4.1");
    expect(text).toContain("$0.27");
    expect(text).toContain("(default)");
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^[^/\s]+\/\S+\s+\S+/);
    }
  });

  it("merges credential-discovered models when a key is present and labels unpriced models", async () => {
    const out: string[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-test-1" }, { id: "gpt-test-2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const code = await runModelsCli({
      env: { OPENAI_API_KEY: "sk-test" },
      write: (chunk) => out.push(chunk),
      writeErr: () => undefined,
      fetchImpl,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("openai/gpt-test-1");
    expect(text).toContain("未计价");
    expect(text).toContain("[configured]");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("marks saved models the gateway no longer lists, shows each model's endpoint, and --refresh drops them", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "xio-models-"));
    await mkdir(home, { recursive: true });
    const env = { XIO_HOME: home, XIO_CONFIG: path.join(home, "config.toml") };
    await writeFile(env.XIO_CONFIG, [
      "[general]", "default_provider = \"opencode\"", "default_model = \"kimi-k3\"",
      "[providers.opencode]", "kind = \"openai\"", "base_url = \"https://opencode.ai/zen/go/v1\"", "model = \"kimi-k3\"",
    ].join("\n"));
    await saveProviderCredential("opencode", { apiKey: "k", models: ["kimi-k3", "gpt-6-luna", "old-model"], baseUrl: "https://opencode.ai/zen/go/v1" }, env);
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.startsWith("https://opencode.ai") ? { data: [{ id: "kimi-k3" }, { id: "gpt-6-luna" }, { id: "minimax-m3" }] } : { data: [] },
    ), { status: 200 })) as unknown as typeof fetch;

    const out: string[] = [];
    await runModelsCli({ env, fetchImpl, write: (chunk) => out.push(chunk), writeErr: () => undefined });
    const line = (id: string) => out.join("").split("\n").find((row) => row.startsWith(`${id} `)) ?? "";
    expect(line("opencode/old-model")).toContain("[offline]");
    expect(line("opencode/kimi-k3")).toMatch(/\/chat\/completions\s+\(default\) \[configured\]$/);
    expect(line("opencode/gpt-6-luna")).toContain("/responses");
    expect(line("opencode/minimax-m3")).toContain("/messages");
    expect(line("opencode/minimax-m3")).not.toContain("[offline]");

    const err: string[] = [];
    await runModelsCli({ env, fetchImpl, refresh: true, write: () => undefined, writeErr: (chunk) => err.push(chunk) });
    expect(err.join("")).toContain("opencode: saved model list refreshed (3 models; removed old-model; added minimax-m3)");
    expect((await loadCredentials(env)).providers.opencode?.models).toEqual(["gpt-6-luna", "kimi-k3", "minimax-m3"]);
  });
});
