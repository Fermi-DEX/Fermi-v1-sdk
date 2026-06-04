/**
 * Shared auth helpers for the Fermi v1 gateway.
 *
 * Every SDK client must carry an API key — the proxy uses it for identity,
 * per-key rate limiting, and quota accounting. Keys are UUID v4 strings sent
 * over HTTP as `x-api-key` and over gRPC as `x-api-key` metadata.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const API_KEY_HEADER = 'x-api-key';

/**
 * Validate and return a non-empty UUID API key. Throws synchronously at
 * client construction so misconfigured callers fail before any network I/O.
 */
export function requireApiKey(
  key: string | undefined | null,
  who: string,
): string {
  if (!key || !UUID_RE.test(key)) {
    throw new Error(
      `${who}: apiKey is required and must be a UUID (set FERMI_API_KEY and pass it as the x-api-key)`,
    );
  }
  return key;
}

export type RateLimitInfo = {
  limit?: number;
  remaining?: number;
  /** Seconds the client should wait before retrying, as reported by the gateway. */
  retryAfter?: number;
};

/**
 * Thrown when the gateway returns 429 (HTTP) or RESOURCE_EXHAUSTED (gRPC).
 * Callers — especially tight loops like the quoter — should back off using
 * `retryAfter` instead of retrying immediately.
 */
export class RateLimitedError extends Error {
  readonly status = 429;
  readonly limit?: number;
  readonly remaining?: number;
  readonly retryAfter?: number;
  readonly body?: string;

  constructor(message: string, info: RateLimitInfo & { body?: string } = {}) {
    super(message);
    this.name = 'RateLimitedError';
    this.limit = info.limit;
    this.remaining = info.remaining;
    this.retryAfter = info.retryAfter;
    this.body = info.body;
  }
}

function parseNumberHeader(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract `x-ratelimit-*` / `retry-after` headers from a fetch Response. */
export function readRateLimitHeaders(headers: Headers): RateLimitInfo {
  return {
    limit: parseNumberHeader(headers.get('x-ratelimit-limit')),
    remaining: parseNumberHeader(headers.get('x-ratelimit-remaining')),
    retryAfter: parseNumberHeader(headers.get('retry-after')),
  };
}
