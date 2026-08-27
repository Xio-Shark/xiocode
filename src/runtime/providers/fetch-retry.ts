export type FetchRetryOptions = Readonly<{
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  retryStatusCodes?: readonly number[];
  onRetry?: (info: { attempt: number; delayMs: number; error?: unknown; status?: number }) => void;
}>;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_RETRY_STATUS_CODES = [429, 500, 502, 503, 504, 529] as const;

/**
 * Robust fetch with exponential backoff, full jitter, and Retry-After header support.
 * Designed for LLM API reliability against rate limits (429) and upstream overloads (5xx, 529).
 */
export async function fetchWithRetry(
  url: string | URL | Request,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryStatuses = new Set(options.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES);
  const signal = init?.signal;

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    try {
      const response = await fetchImpl(url, init);
      if (response.ok || !retryStatuses.has(response.status) || attempt >= maxRetries) {
        return response;
      }

      const retryAfterHeader = response.headers.get("retry-after");
      const delayMs = computeDelay(retryAfterHeader, attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt: attempt + 1, delayMs, status: response.status });

      await sleepWithSignal(delayMs, signal);
      attempt += 1;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
      if (attempt >= maxRetries) {
        throw error;
      }

      const delayMs = computeBackoffWithJitter(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });

      await sleepWithSignal(delayMs, signal);
      attempt += 1;
    }
  }
}

function computeDelay(
  retryAfterHeader: string | null,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(maxDelayMs, seconds * 1000);
    }
    const dateMs = Date.parse(retryAfterHeader);
    if (!Number.isNaN(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) {
        return Math.min(maxDelayMs, diff);
      }
    }
  }
  return computeBackoffWithJitter(attempt, baseDelayMs, maxDelayMs);
}

function computeBackoffWithJitter(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  // Full jitter: 75% - 125% of exp backoff
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(Math.min(maxDelayMs, exp * jitter));
}

function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "name" in error && (error as { name: string }).name === "AbortError";
}
