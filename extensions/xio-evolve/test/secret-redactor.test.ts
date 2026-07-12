import { describe, expect, it } from "vitest";

import { SecretRedactor } from "../src/secret-redactor.ts";

describe("SecretRedactor", () => {
  describe("API keys", () => {
    it("redacts OpenAI API keys", () => {
      const redactor = new SecretRedactor();
      const text = "My key is sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890AB";

      const redacted = redactor.redact(text);

      expect(redacted).toBe("My key is sk-***REDACTED***");
    });

    it("redacts OpenAI project keys", () => {
      const redactor = new SecretRedactor();
      const text = "Project key: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJK";

      const redacted = redactor.redact(text);

      expect(redacted).toBe("Project key: sk-proj-***REDACTED***");
    });

    it("redacts GitHub Personal Access Tokens", () => {
      const redactor = new SecretRedactor();
      const text = "GitHub PAT: ghp_1234567890abcdefghijklmnopqrstuv";

      const redacted = redactor.redact(text);

      expect(redacted).toBe("GitHub PAT: ghp_***REDACTED***");
    });

    it("redacts Anthropic API keys", () => {
      const redactor = new SecretRedactor();
      const text = "Anthropic: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1234567890abcd";

      const redacted = redactor.redact(text);

      expect(redacted).toBe("Anthropic: sk-ant-***REDACTED***");
    });

    it("redacts AWS access keys", () => {
      const redactor = new SecretRedactor();
      const text = "AWS: AKIAIOSFODNN7EXAMPLE";

      const redacted = redactor.redact(text);

      expect(redacted).toBe("AWS: AKIA***REDACTED***");
    });

    it("redacts multiple keys in one string", () => {
      const redactor = new SecretRedactor();
      const text = "OpenAI: sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890AB and GitHub: ghp_1234567890abcdefghijklmnopqrstuv";

      const redacted = redactor.redact(text);

      expect(redacted).toBe("OpenAI: sk-***REDACTED*** and GitHub: ghp_***REDACTED***");
    });
  });

  describe("environment variables", () => {
    it("redacts sensitive env var keys in objects", () => {
      const redactor = new SecretRedactor();
      const obj = {
        API_KEY: "secret123",
        DATABASE_URL: "postgres://user:pass@host/db",
        OPENAI_API_KEY: "sk-test",
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.API_KEY).toBe("***REDACTED***");
      expect(redacted.DATABASE_URL).toBe("postgres://user:pass@host/db");
      expect(redacted.OPENAI_API_KEY).toBe("***REDACTED***");
    });

    it("redacts *SECRET pattern keys", () => {
      const redactor = new SecretRedactor();
      const obj = {
        CLIENT_SECRET: "secret123",
        JWT_SECRET: "jwt456",
        WEBHOOK_SECRET: "webhook789",
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.CLIENT_SECRET).toBe("***REDACTED***");
      expect(redacted.JWT_SECRET).toBe("***REDACTED***");
      expect(redacted.WEBHOOK_SECRET).toBe("***REDACTED***");
    });

    it("redacts *TOKEN pattern keys", () => {
      const redactor = new SecretRedactor();
      const obj = {
        ACCESS_TOKEN: "token123",
        REFRESH_TOKEN: "token456",
        AUTH_TOKEN: "token789",
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.ACCESS_TOKEN).toBe("***REDACTED***");
      expect(redacted.REFRESH_TOKEN).toBe("***REDACTED***");
      expect(redacted.AUTH_TOKEN).toBe("***REDACTED***");
    });

    it("preserves provider usage token counters", () => {
      const redactor = new SecretRedactor();
      const obj = {
        usage: {
          inputTokens: 9905,
          outputTokens: 17,
          cacheTokens: 3712,
          reasoningTokens: 15,
        },
        accessToken: "secret-access",
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;
      const usage = redacted.usage as Record<string, unknown>;

      expect(usage.inputTokens).toBe(9905);
      expect(usage.outputTokens).toBe(17);
      expect(usage.cacheTokens).toBe(3712);
      expect(usage.reasoningTokens).toBe(15);
      expect(redacted.accessToken).toBe("***REDACTED***");
    });

    it("redacts *PASSWORD pattern keys", () => {
      const redactor = new SecretRedactor();
      const obj = {
        DB_PASSWORD: "pass123",
        ADMIN_PASSWORD: "pass456",
        USER_PASSWORD: "pass789",
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.DB_PASSWORD).toBe("***REDACTED***");
      expect(redacted.ADMIN_PASSWORD).toBe("***REDACTED***");
      expect(redacted.USER_PASSWORD).toBe("***REDACTED***");
    });
  });

  describe("sensitive files", () => {
    it("redacts .env file paths", () => {
      const redactor = new SecretRedactor();
      const obj = {
        path: ".env",
        content: "API_KEY=secret",
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.path).toBe("***REDACTED SENSITIVE FILE***");
    });

    it("redacts .pem and .key files", () => {
      const redactor = new SecretRedactor();
      const obj1 = { file_path: "/path/to/private.pem" };
      const obj2 = { file_path: "/path/to/secret.key" };

      const redacted1 = redactor.redact(obj1) as Record<string, unknown>;
      const redacted2 = redactor.redact(obj2) as Record<string, unknown>;

      expect(redacted1.file_path).toBe("***REDACTED SENSITIVE FILE***");
      expect(redacted2.file_path).toBe("***REDACTED SENSITIVE FILE***");
    });

    it("redacts credentials.json", () => {
      const redactor = new SecretRedactor();
      const obj = { path: "/app/config/credentials.json" };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.path).toBe("***REDACTED SENSITIVE FILE***");
    });

    it("does not redact non-sensitive files", () => {
      const redactor = new SecretRedactor();
      const obj = { path: "/app/src/index.ts" };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect(redacted.path).toBe("/app/src/index.ts");
    });
  });

  describe("nested objects and arrays", () => {
    it("redacts secrets in nested objects", () => {
      const redactor = new SecretRedactor();
      const obj = {
        config: {
          API_KEY: "secret123",
          database: {
            PASSWORD: "pass456",
          },
        },
      };

      const redacted = redactor.redact(obj) as Record<string, unknown>;

      expect((redacted.config as Record<string, unknown>).API_KEY).toBe("***REDACTED***");
      expect(((redacted.config as Record<string, unknown>).database as Record<string, unknown>).PASSWORD).toBe("***REDACTED***");
    });

    it("redacts secrets in arrays", () => {
      const redactor = new SecretRedactor();
      const arr = [
        "My key is sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890AB",
        { API_KEY: "secret" },
      ];

      const redacted = redactor.redact(arr) as unknown[];

      expect(redacted[0]).toBe("My key is sk-***REDACTED***");
      expect((redacted[1] as Record<string, unknown>).API_KEY).toBe("***REDACTED***");
    });
  });

  describe("debug mode", () => {
    it("does not redact when debug mode is enabled", () => {
      const redactor = new SecretRedactor({ debugMode: true });
      const text = "My key is sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890AB";
      const obj = { API_KEY: "secret123" };

      const redactedText = redactor.redact(text);
      const redactedObj = redactor.redact(obj);

      expect(redactedText).toBe(text);
      expect(redactedObj).toEqual(obj);
    });
  });

  describe("edge cases", () => {
    it("handles null and undefined", () => {
      const redactor = new SecretRedactor();

      expect(redactor.redact(null)).toBe(null);
      expect(redactor.redact(undefined)).toBe(undefined);
    });

    it("handles numbers and booleans", () => {
      const redactor = new SecretRedactor();

      expect(redactor.redact(123)).toBe(123);
      expect(redactor.redact(true)).toBe(true);
      expect(redactor.redact(false)).toBe(false);
    });

    it("handles empty strings and objects", () => {
      const redactor = new SecretRedactor();

      expect(redactor.redact("")).toBe("");
      expect(redactor.redact({})).toEqual({});
      expect(redactor.redact([])).toEqual([]);
    });
  });
});
