import { describe, expect, it } from "vitest";

import { classifyPrompt, ModelRouter, resolveRouteModel } from "../src/model-router.ts";

describe("classifyPrompt", () => {
  it("marks short non-code prompts as simple", () => {
    expect(classifyPrompt("hi").taskClass).toBe("simple");
  });

  it("marks code-related prompts as code", () => {
    expect(classifyPrompt("fix the typescript lint error in config").taskClass).toBe("code");
  });

  it("ModelRouter delegates to classifyPrompt", () => {
    const router = new ModelRouter({ codeModel: "openai/codex", defaultModel: "deepseek/chat" });
    const decision = router.route("refactor the agent loop");
    expect(decision.taskClass).toBe("code");
    expect(resolveRouteModel(decision)).toBe("openai/codex");
  });
});
