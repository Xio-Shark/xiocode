import { describe, expect, it } from "vitest";

import { parseEvalArgs } from "./eval-cli.ts";

describe("parseEvalArgs", () => {
  it("parses --candidate-mode, --model, and --repeat", () => {
    const args = parseEvalArgs([
      "smoke",
      "--candidate-mode",
      "real",
      "--model",
      "deepseek/deepseek-chat",
      "--repeat",
      "3",
      "--json",
    ]);
    expect(args).toMatchObject({
      command: "smoke",
      candidateMode: "real",
      model: "deepseek/deepseek-chat",
      repeat: 3,
      json: true,
      deprecations: [],
    });
  });

  it("rejects combining --provider with --candidate-mode", () => {
    expect(() => parseEvalArgs([
      "smoke",
      "--candidate-mode=real",
      "--provider=stub",
      "--model=openrouter/anthropic/claude-3",
    ])).toThrow(/cannot be combined/);
  });

  it("accepts legacy --provider alone with a deprecation notice", () => {
    const args = parseEvalArgs(["smoke", "--provider", "stub"]);
    expect(args.candidateMode).toBe("stub");
    expect(args.repeat).toBe(1);
    expect(args.deprecations).toHaveLength(1);
  });

  it("rejects invalid --repeat and --model shapes", () => {
    expect(() => parseEvalArgs(["smoke", "--repeat", "0"])).toThrow(/integer from 1 to 10/);
    expect(() => parseEvalArgs(["smoke", "--model", "noprovider"])).toThrow(/provider\/model/);
  });

  it("rejects --model with stub candidate mode", () => {
    expect(() => parseEvalArgs([
      "smoke",
      "--candidate-mode",
      "stub",
      "--model",
      "deepseek/deepseek-chat",
    ])).toThrow(/--model requires --candidate-mode real/);
  });
});
