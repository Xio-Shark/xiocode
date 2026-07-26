import { describe, expect, it } from "vitest";

import { providerErrorGuidance, withProviderGuidance } from "./error-guidance.ts";

describe("providerErrorGuidance", () => {
  it("maps auth failures to /connect", () => {
    expect(providerErrorGuidance({ status: 401 })).toContain("/connect");
    expect(providerErrorGuidance({ message: "LLM request failed (403)" })).toContain("/connect");
  });

  it("maps a missing key env to the export command", () => {
    expect(providerErrorGuidance({ message: "missing API key env: DEEPSEEK_API_KEY" }))
      .toContain("export DEEPSEEK_API_KEY");
  });

  it("maps model-not-found to xio models, naming the model when known", () => {
    const guidance = providerErrorGuidance({ status: 404, model: "gpt-9" });
    expect(guidance).toContain("xio models");
    expect(guidance).toContain("gpt-9");
  });

  it("maps a rejected request to model / base URL checks", () => {
    const guidance = providerErrorGuidance({ status: 400 });
    expect(guidance).toContain("xio models");
    expect(guidance).toContain("base_url");
  });

  it("maps rate limits and empty balance to distinct next steps", () => {
    expect(providerErrorGuidance({ status: 429 })).toContain("Rate limited");
    expect(providerErrorGuidance({ status: 402 })).toContain("out of credit");
  });

  it("maps provider-side 5xx and network failures apart", () => {
    expect(providerErrorGuidance({ status: 503 })).toContain("status page");
    expect(providerErrorGuidance({ message: "fetch failed" })).toContain("HTTPS_PROXY");
  });

  it("maps context overflow to /compact", () => {
    expect(providerErrorGuidance({ message: "maximum context length exceeded" }))
      .toContain("/compact");
  });

  it("returns undefined rather than inventing a step for unknown errors", () => {
    expect(providerErrorGuidance({ message: "something entirely new" })).toBeUndefined();
    expect(providerErrorGuidance({})).toBeUndefined();
  });
});

describe("withProviderGuidance", () => {
  it("keeps the original message and appends the next step", () => {
    const result = withProviderGuidance("LLM request failed (429)", { status: 429 });
    expect(result.split("\n")[0]).toBe("LLM request failed (429)");
    expect(result).toContain("  → Rate limited");
  });

  it("leaves messages untouched when no guidance applies", () => {
    expect(withProviderGuidance("weird failure")).toBe("weird failure");
  });
});
