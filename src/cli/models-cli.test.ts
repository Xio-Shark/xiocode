import { describe, expect, it, vi } from "vitest";

import { runModelsCli } from "./models-cli.ts";

describe("runModelsCli", () => {
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
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^[^/\s]+\/\S+$/);
    }
  });

  it("merges credential-discovered models when a key is present", async () => {
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
    expect(out.join("")).toContain("openai/gpt-test-1");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
