/**
 * Default RuntimeEvent payload redaction: strip obvious secrets and cap large strings.
 * Trajectory store may apply additional SecretRedactor; this is the bus-level floor.
 */

/** Whole-key match only — avoid false positives on `inputTokens` / `outputTokens`. */
const SECRET_KEY = /^(?:api[_-]?key|authorization|password|secret|token|access_token|refresh_token|cookie|credential)s?$/i;
const MAX_STRING = 8_000;
const MAX_DEPTH = 6;

export function redactRuntimePayload(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactValue(payload, 0) as Record<string, unknown>;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return "[max-depth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = redactValue(child, depth + 1);
    }
    return out;
  }
  return String(value);
}
