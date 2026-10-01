import { describe, expect, it } from "vitest";

import { createLlmClient, providerRequestHeaders } from "./client.ts";
import { defaultSessionHeader, registerConfiguredProviders } from "../provider-registry.ts";
import { ExtensionHost } from "../extension-host.ts";

import type { ProviderRegistration } from "../types.ts";
import type { XioRuntimeConfig } from "../../cli/config-parser.ts";

function registration(api: string, extra: Partial<ProviderRegistration> = {}, headers?: Record<string, string>): ProviderRegistration {
  return {
    name: "go",
    api,
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, ...(headers ? { headers } : {}) }],
    ...extra,
  };
}

const identity = { userAgent: "xiocode/9.9.9", sessionId: "sess-1" };

describe("client identity headers", () => {
  it("sends the user agent and the conversation id in the configured header", () => {
    const headers = providerRequestHeaders({ registration: registration("openai-completions", { sessionHeader: "x-opencode-session" }), apiKey: "k", identity }, { authorization: "Bearer k" });
    expect(headers).toMatchObject({ authorization: "Bearer k", "user-agent": "xiocode/9.9.9", "x-opencode-session": "sess-1" });
  });

  it("lets the conversation id win over a static header pinned in config, but keeps a configured user agent", () => {
    const reg = registration("openai-completions", { sessionHeader: "x-opencode-session" },
      { "x-opencode-session": "xiocode-1.3.0", "user-agent": "custom/1" });
    const headers = providerRequestHeaders({ registration: reg, apiKey: "k", identity }, {});
    expect(headers["x-opencode-session"]).toBe("sess-1");
    expect(headers["user-agent"]).toBe("custom/1");
  });

  it("sends no session header without a header name or a session id", () => {
    expect(providerRequestHeaders({ registration: registration("openai-completions"), apiKey: "k", identity }, {})).not.toHaveProperty("x-opencode-session");
    expect(Object.keys(providerRequestHeaders({ registration: registration("openai-completions", { sessionHeader: "" }), apiKey: "k", identity }, {})))
      .toEqual(["user-agent"]);
    expect(providerRequestHeaders({ registration: registration("openai-completions", { sessionHeader: "x-s" }), apiKey: "k" }, {})).not.toHaveProperty("x-s");
  });

  it.each(["openai-completions", "anthropic-messages"])("puts them on the wire (%s)", async (api) => {
    let seen: Headers | undefined;
    const client = createLlmClient({
      registration: registration(api, { sessionHeader: "x-opencode-session" }),
      apiKey: "k",
      identity,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers);
        return new Response(JSON.stringify(api === "anthropic-messages"
          ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }
          : { choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(seen?.get("user-agent")).toBe("xiocode/9.9.9");
    expect(seen?.get("x-opencode-session")).toBe("sess-1");
  });
});

describe("default session header", () => {
  it("is x-opencode-session for OpenCode endpoints only", () => {
    expect(defaultSessionHeader("https://opencode.ai/zen/go/v1")).toBe("x-opencode-session");
    expect(defaultSessionHeader("https://api.opencode.ai/v1")).toBe("x-opencode-session");
    expect(defaultSessionHeader("https://api.deepseek.com")).toBeUndefined();
    expect(defaultSessionHeader("https://opencode.ai.evil.example/v1")).toBeUndefined();
    expect(defaultSessionHeader(undefined)).toBeUndefined();
    expect(defaultSessionHeader("not a url")).toBeUndefined();
  });

  it("follows config: session_header overrides the default, an empty one turns it off", () => {
    const host = new ExtensionHost();
    registerConfiguredProviders(host, {
      providers: {
        go: { name: "go", kind: "openai", baseUrl: "https://opencode.ai/zen/go/v1", model: "m" },
        off: { name: "off", kind: "openai", baseUrl: "https://opencode.ai/zen/go/v1", model: "m", sessionHeader: "" },
        own: { name: "own", kind: "openai", baseUrl: "https://gw.example/v1", model: "m", sessionHeader: "x-conv" },
      },
    } as unknown as XioRuntimeConfig);
    expect(host.getProvider("go")?.sessionHeader).toBe("x-opencode-session");
    expect(host.getProvider("off")?.sessionHeader).toBe("");
    expect(host.getProvider("own")?.sessionHeader).toBe("x-conv");
  });
});
