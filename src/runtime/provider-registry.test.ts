import { describe, expect, it } from "vitest";

import { resolveDefaultModel, registerConfiguredProviders } from "./provider-registry.ts";
import { ExtensionHost } from "./extension-host.ts";

import type { XioRuntimeConfig } from "../cli/config-parser.ts";

function stubConfig(overrides: Partial<XioRuntimeConfig> = {}): XioRuntimeConfig {
  return {
    general: {
      defaultProvider: "openai",
      defaultModel: "gpt-4.1",
      runRoot: "/tmp",
    },
    providers: {
      deepseek: {
        name: "deepseek",
        kind: "openai",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
      },
    },
    worktree: { enabled: false, allowDirty: false, retainOnReject: false },
    trust: { mode: "trust" },
    permissions: {},
    tools: {},
    explore: {},
    regress: { offerOnFailure: false },
    harness: {},
    ...overrides,
  } as unknown as XioRuntimeConfig;
}

describe("resolveDefaultModel", () => {
  it("uses general.defaultProvider when configured under providers", () => {
    const config = stubConfig({
      general: {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        runRoot: "/tmp",
      },
    });
    const model = resolveDefaultModel(config);
    expect(model).toEqual({
      provider: "deepseek",
      id: "deepseek-chat",
      name: "deepseek-chat",
      api: "openai-completions",
    });
  });

  it("falls back to first configured provider when defaultProvider is not registered", () => {
    const config = stubConfig({
      general: {
        defaultProvider: "openai",
        defaultModel: "gpt-4.1",
        runRoot: "/tmp",
      },
      providers: {
        deepseek: {
          name: "deepseek",
          kind: "openai",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-chat",
        },
      },
    });
    const model = resolveDefaultModel(config);
    expect(model.provider).toBe("deepseek");
    expect(model.id).toBe("deepseek-chat");
  });

  it("falls back to first configured provider when defaultProvider is omitted", () => {
    const config = stubConfig({
      general: {
        runRoot: "/tmp",
      },
      providers: {
        token: {
          name: "token",
          kind: "openai",
          model: "deepseek-v4",
        },
      },
    });
    const model = resolveDefaultModel(config);
    expect(model.provider).toBe("token");
    expect(model.id).toBe("deepseek-v4");
  });

  it("registers configured providers into host", () => {
    const host = new ExtensionHost();
    const config = stubConfig();
    registerConfiguredProviders(host, config);
    expect(host.getProvider("deepseek")).toBeDefined();
    expect(host.getProvider("deepseek")?.models[0]?.id).toBe("deepseek-chat");
  });
});
