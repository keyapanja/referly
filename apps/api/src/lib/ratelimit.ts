import type { Context, MiddlewareHandler } from "hono";
import { DomainError } from "@referly/core";

/**
 * Fixed-window rate limiter keyed by client IP (PRD s13: abuse protection on public
 * referral/application endpoints). In-memory, so limits are per process; put a shared store
 * behind this interface when running more than one API instance.
 */
export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  windowMs: number;
  /** Bucket name so different route groups do not share counters. */
  name: string;
  keyOf?: (c: Context) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || c.req.header("cf-connecting-ip") || "local";
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const now = Date.now();
    sweep(now);
    const key = `${opts.name}:${(opts.keyOf ?? clientIp)(c)}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    const remaining = Math.max(0, opts.limit - b.count);
    c.header("x-ratelimit-limit", String(opts.limit));
    c.header("x-ratelimit-remaining", String(remaining));
    if (b.count > opts.limit) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      c.header("retry-after", String(retry));
      throw new DomainError("rate_limited", "too many requests, slow down", { retryAfterSeconds: retry });
    }
    await next();
  };
}

/** Test hook. */
export function resetRateLimits() {
  buckets.clear();
}
