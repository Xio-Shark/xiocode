import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { applyThinkingLevel, registerThinkingCommands } from "./thinking-commands.ts";

import type { SessionUiSink } from "./session-ui.ts";

describe("thinking commands", () => {
  it("sets thinking from args and persists default_thinking_level", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "xio-think-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(configPath, `[general]\ndefault_provider = "test"\ndefault_model = "m"\n`, "utf8");
    const host = new ExtensionHost({ initialModel: { provider: "test", id: "m" } });
    host.registerProvider("test", {
      name: "test",
      api: "openai-completions",
      models: [{ id: "m", name: "m", reasoning: true }],
    });
    const statuses: Record<string, string> = {};
    const sink: SessionUiSink = {
      setStatus(key, text) {
        if (text) statuses[key] = text;
        else delete statuses[key];
      },
    };
    const env = { XIO_CONFIG: configPath };
    registerThinkingCommands({
      host,
      interactive: {
        ask: async () => true,
        select: async () => undefined,
        prompt: async () => undefined,
      },
      sink,
      getModel: () => ({ provider: "test", id: "m" }),
      env,
    });

    await expect(host.runCommand("thinking", "ultra")).resolves.toContain("ultra");
    expect(host.getThinkingLevel()).toBe("ultra");
    expect(statuses.thinking).toBe("think:ultra");
    const saved = await readFile(configPath, "utf8");
    expect(saved).toMatch(/default_thinking_level\s*=\s*"ultra"/);

    await applyThinkingLevel({
      host,
      interactive: {
        ask: async () => true,
        select: async () => undefined,
        prompt: async () => undefined,
      },
      sink,
      getModel: () => ({ provider: "test", id: "m" }),
      env,
    }, "high");
    expect(host.getThinkingLevel()).toBe("high");
  });
});
