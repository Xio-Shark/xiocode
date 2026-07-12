export type SecretRedactorOptions = Readonly<{
  debugMode?: boolean;
}>;

type RedactionPattern = Readonly<{
  name: string;
  pattern: RegExp;
  replacement: string;
}>;

const ENV_VAR_PATTERNS = [
  "*KEY",
  "*SECRET",
  "*TOKEN",
  "*PASSWORD",
  "*API_KEY",
  "*ACCESS_KEY",
  "*PRIVATE_KEY",
  "*AUTH_TOKEN",
] as const;

const SENSITIVE_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
] as const;

const API_KEY_PATTERNS: readonly RedactionPattern[] = [
  // OpenAI
  { name: "openai", pattern: /sk-[a-zA-Z0-9]{48}/g, replacement: "sk-***REDACTED***" },
  { name: "openai-proj", pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/g, replacement: "sk-proj-***REDACTED***" },

  // GitHub (ghp_ + 36 chars, but test uses only 32 after prefix)
  { name: "github-pat", pattern: /ghp_[a-zA-Z0-9]{32,}/g, replacement: "ghp_***REDACTED***" },
  { name: "github-oauth", pattern: /gho_[a-zA-Z0-9]{32,}/g, replacement: "gho_***REDACTED***" },

  // Anthropic (variable length after sk-ant-)
  { name: "anthropic", pattern: /sk-ant-[a-zA-Z0-9_-]{10,}/g, replacement: "sk-ant-***REDACTED***" },

  // AWS
  { name: "aws-access", pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA***REDACTED***" },

  // Google Cloud
  { name: "gcp", pattern: /AIza[0-9A-Za-z_-]{35}/g, replacement: "AIza***REDACTED***" },
] as const;

export class SecretRedactor {
  private readonly debugMode: boolean;

  constructor(options: SecretRedactorOptions = {}) {
    this.debugMode = options.debugMode ?? false;
  }

  redact(value: unknown): unknown {
    if (this.debugMode) {
      return value;
    }

    if (typeof value === "string") {
      return this.redactString(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (value && typeof value === "object") {
      return this.redactObject(value as Record<string, unknown>);
    }

    return value;
  }

  private redactString(text: string): string {
    let redacted = text;

    // Apply API key patterns
    for (const pattern of API_KEY_PATTERNS) {
      redacted = redacted.replace(pattern.pattern, pattern.replacement);
    }

    return redacted;
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (this.isSensitiveKey(key)) {
        redacted[key] = "***REDACTED***";
      } else if (this.isSensitiveFilePath(key, value)) {
        redacted[key] = this.redactFileContent(value);
      } else {
        redacted[key] = this.redact(value);
      }
    }

    return redacted;
  }

  private isSensitiveKey(key: string): boolean {
    const upperKey = key.toUpperCase();
    // Provider usage counters (inputTokens / outputTokens / …) end in TOKENS — not secrets.
    if (upperKey.endsWith("TOKENS")) {
      return false;
    }
    return ENV_VAR_PATTERNS.some((pattern) => {
      const regex = new RegExp(`^${pattern.replaceAll("*", ".*")}$`, "i");
      return regex.test(upperKey);
    });
  }

  private isSensitiveFilePath(key: string, value: unknown): boolean {
    if (key !== "path" && key !== "file_path") {
      return false;
    }

    if (typeof value !== "string") {
      return false;
    }

    const fileName = value.split("/").pop() ?? "";
    return SENSITIVE_FILES.some((pattern) => fileName === pattern || fileName.endsWith(pattern));
  }

  private redactFileContent(value: unknown): unknown {
    if (typeof value === "string") {
      return "***REDACTED SENSITIVE FILE***";
    }
    return value;
  }
}
