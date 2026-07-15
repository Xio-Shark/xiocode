import path from "node:path";

/** Directory/file name segments excluded from workspace indexing. */
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  ".idea",
  ".xiocode",
]);

const EXCLUDED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  ".ds_store",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
]);

const SECRET_LINE = /(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*['\"]?[^\s'\"]{8,}/i;

export function isExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return false;
  const parts = normalized.split("/").filter(Boolean);
  for (const part of parts) {
    if (EXCLUDED_SEGMENTS.has(part.toLowerCase())) return true;
    if (part.startsWith(".env")) return true;
  }
  const base = parts.at(-1)?.toLowerCase() ?? "";
  if (EXCLUDED_BASENAMES.has(base)) return true;
  if (base === "credentials.json") return true;
  const ext = path.extname(base).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  return false;
}

/** Redact likely secrets in evidence text; never invent content. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? "[redacted]" : line))
    .join("\n");
}

export function sniffLanguage(relativePath: string): string | undefined {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    case ".toml":
      return "toml";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return undefined;
  }
}
