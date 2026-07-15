import { describe, expect, it } from "vitest";

import { isExcludedPath, redactSecrets, sniffLanguage } from "./privacy.ts";

describe("workspace privacy", () => {
  it("excludes secrets and dependency trees", () => {
    expect(isExcludedPath("node_modules/foo/index.js")).toBe(true);
    expect(isExcludedPath(".git/config")).toBe(true);
    expect(isExcludedPath(".env")).toBe(true);
    expect(isExcludedPath("secrets/key.pem")).toBe(true);
    expect(isExcludedPath("src/runtime/agent-loop.ts")).toBe(false);
  });

  it("redacts secret-looking lines", () => {
    const text = "const x = 1\napi_key = sk-live-abcdef123456\nkeep";
    expect(redactSecrets(text)).toContain("[redacted]");
    expect(redactSecrets(text)).toContain("const x = 1");
    expect(redactSecrets(text)).not.toContain("sk-live");
  });

  it("sniffs languages from extensions", () => {
    expect(sniffLanguage("a.ts")).toBe("typescript");
    expect(sniffLanguage("b.py")).toBe("python");
    expect(sniffLanguage("c.go")).toBe("go");
  });
});
