/**
 * Actionable next steps for provider failures.
 *
 * A first-run user who hits 401 or 429 gets a number and nothing else; the
 * useful part is what to type next. One source of truth so `xio doctor`, the
 * TUI notice and `-p` stderr all say the same thing.
 *
 * Guidance never echoes response bodies — those can contain the API key.
 */
export type ProviderErrorInput = Readonly<{
  /** HTTP status when the failure came from a response. */
  status?: number;
  /** Error message (already redacted of bodies). */
  message?: string;
  /** Model id, when the failure is model-specific (404s). */
  model?: string;
}>;

/**
 * One line the user can act on, or undefined when nothing better than the raw
 * error is known — an invented next step is worse than none.
 */
export function providerErrorGuidance(input: ProviderErrorInput): string | undefined {
  const status = input.status;
  const text = (input.message ?? "").toLowerCase();

  if (status === 401 || status === 403 || matches(text, ["401", "403", "unauthorized", "forbidden", "invalid api key", "invalid_api_key"])) {
    return "The API key was rejected. Run /connect to re-enter it, or check the provider key env var. `xio doctor` verifies it.";
  }
  if (matches(text, ["missing api key env"])) {
    return "Export that variable (e.g. `export DEEPSEEK_API_KEY=sk-...`), or run /connect to store the key in ~/.xiocode/credentials.json.";
  }
  if (matches(text, ["no apikey configured"])) {
    return "This provider has no key. Run /connect, or set api_key_env under [providers.*] in ~/.xiocode/config.toml.";
  }
  if (status === 404 || matches(text, ["404", "model not found", "unknown model", "does not exist"])) {
    const model = input.model ? ` (${input.model})` : "";
    return `The model${model} was not found on this provider. Run \`xio models\` for valid ids, or /model to switch.`;
  }
  if (status === 429 || matches(text, ["429", "rate limit", "too many requests", "quota"])) {
    return "Rate limited or out of quota. Wait a minute and retry, or check your provider's billing/limits page.";
  }
  if (status === 402 || matches(text, ["402", "insufficient balance", "insufficient_quota"])) {
    return "The provider account is out of credit. Top it up, or switch provider with /model.";
  }
  if (status === 400 || matches(text, ["400", "bad request", "invalid_request"])) {
    // The most common first-run failure on a custom gateway: the model id or
    // request shape is not what that endpoint accepts.
    return "The provider rejected the request — usually an unsupported model id or base URL. "
      + "Check `xio models`, switch with /model, or verify base_url for a custom gateway (`xio doctor`).";
  }
  if ((status !== undefined && status >= 500) || matches(text, ["500", "502", "503", "504", "bad gateway", "service unavailable"])) {
    return "The provider is failing on its side. Retry in a moment; if it persists, check the provider's status page.";
  }
  if (matches(text, ["enotfound", "econnrefused", "econnreset", "fetch failed", "network", "timeout", "etimedout", "socket hang up"])) {
    return "Network unreachable. Check your connection and proxy settings (HTTPS_PROXY), then run `xio doctor`.";
  }
  if (matches(text, ["context length", "context_length", "too many tokens", "maximum context"])) {
    return "The conversation outgrew the model's context window. Run /compact, or switch to a larger-context model with /model.";
  }
  return undefined;
}

/**
 * Append guidance to an error message as a `→` next-step line. Returns the
 * original message unchanged when no specific guidance applies — the raw
 * failure always stays visible, it is never replaced.
 */
export function withProviderGuidance(message: string, input: ProviderErrorInput = {}): string {
  const guidance = providerErrorGuidance({ message, ...input });
  return guidance ? `${message}\n  → ${guidance}` : message;
}

function matches(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
