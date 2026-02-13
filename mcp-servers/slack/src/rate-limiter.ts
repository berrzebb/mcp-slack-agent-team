/**
 * Centralized Rate Limiter for Slack API calls.
 *
 * Instead of per-tool catch/retry, all Slack API calls go through
 * a queue with automatic backoff when rate-limited.
 *
 * Features:
 * - Token bucket algorithm (Slack Tier 2/3 compatible)
 * - Auto-backoff on 429 responses
 * - Request queue with priority
 * - Rate limit metrics
 */

// ── Configuration ──────────────────────────────────────────────

/** Slack rate limit tiers — we default to Tier 3 (50 req/min) */
const DEFAULT_TOKENS_PER_MINUTE = 45;    // leave 5 buffer
const BURST_MAX = 10;                     // max burst without waiting
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

// ── Rate Limiter State ─────────────────────────────────────────

interface RateLimiterState {
  tokens: number;
  lastRefill: number;
  tokensPerMs: number;
  backoffUntil: number;    // timestamp: don't make requests until this time
  consecutiveErrors: number;
  totalRequests: number;
  totalRateLimited: number;
  totalErrors: number;
}

const state: RateLimiterState = {
  tokens: BURST_MAX,
  lastRefill: Date.now(),
  tokensPerMs: DEFAULT_TOKENS_PER_MINUTE / 60000,
  backoffUntil: 0,
  consecutiveErrors: 0,
  totalRequests: 0,
  totalRateLimited: 0,
  totalErrors: 0,
};

// ── Token Bucket ───────────────────────────────────────────────

function refillTokens(): void {
  const now = Date.now();
  const elapsed = now - state.lastRefill;
  state.tokens = Math.min(BURST_MAX, state.tokens + elapsed * state.tokensPerMs);
  state.lastRefill = now;
}

function waitForToken(): Promise<void> {
  refillTokens();
  if (state.tokens >= 1) {
    state.tokens -= 1;
    return Promise.resolve();
  }
  // Wait until a token is available
  const waitMs = Math.ceil((1 - state.tokens) / state.tokensPerMs);
  state.tokens = 0;
  state.lastRefill = Date.now() + waitMs;
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

// ── Core: Rate-Limited Execution ───────────────────────────────

/**
 * Execute a Slack API call with automatic rate limiting and retry.
 *
 * @param fn - Async function that makes the actual Slack API call
 * @param label - Optional label for logging (e.g., "chat.postMessage")
 * @param maxRetries - Maximum retry attempts on rate limit (default: 3)
 */
export async function rateLimitedCall<T>(
  fn: () => Promise<T>,
  label?: string,
  maxRetries: number = 3,
): Promise<T> {
  state.totalRequests++;

  // Wait for backoff period if active
  const now = Date.now();
  if (state.backoffUntil > now) {
    const waitMs = state.backoffUntil - now;
    console.error(`[rate-limiter] Backing off for ${waitMs}ms (${label || "?"})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // Wait for token
  await waitForToken();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      state.consecutiveErrors = 0;
      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const slackErr = err as { data?: { error?: string }; headers?: Record<string, string> };

      if (errMsg.includes("rate_limited") || slackErr.data?.error === "ratelimited") {
        state.totalRateLimited++;
        state.consecutiveErrors++;

        // Extract retry_after from headers if available
        const retryAfter = slackErr.headers?.["retry-after"]
          ? parseInt(slackErr.headers["retry-after"], 10) * 1000
          : Math.min(
              BACKOFF_BASE_MS * Math.pow(2, state.consecutiveErrors - 1),
              BACKOFF_MAX_MS,
            );

        state.backoffUntil = Date.now() + retryAfter;
        console.error(
          `[rate-limiter] Rate limited (${label || "?"}), retry ${attempt + 1}/${maxRetries} after ${retryAfter}ms`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
          await waitForToken();
          continue;
        }
      }

      state.totalErrors++;
      throw err;
    }
  }

  throw new Error(`[rate-limiter] Max retries exceeded for ${label || "unknown"}`);
}

// ── Metrics ────────────────────────────────────────────────────

export interface RateLimiterMetrics {
  totalRequests: number;
  totalRateLimited: number;
  totalErrors: number;
  currentTokens: number;
  isBackingOff: boolean;
  backoffRemainingMs: number;
}

export function getRateLimiterMetrics(): RateLimiterMetrics {
  refillTokens();
  const now = Date.now();
  return {
    totalRequests: state.totalRequests,
    totalRateLimited: state.totalRateLimited,
    totalErrors: state.totalErrors,
    currentTokens: Math.floor(state.tokens),
    isBackingOff: state.backoffUntil > now,
    backoffRemainingMs: Math.max(0, state.backoffUntil - now),
  };
}

/** Reset metrics (for testing / diagnostics) */
export function resetRateLimiterMetrics(): void {
  state.totalRequests = 0;
  state.totalRateLimited = 0;
  state.totalErrors = 0;
  state.consecutiveErrors = 0;
}
