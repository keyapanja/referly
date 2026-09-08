import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { DomainError } from "@referly/core";

/**
 * Fixed-window rate limiter keyed by client IP (PRD s13: abuse protection on public
 * referral/application endpoints). In-memory, so limits are per process; put a shared store
 * behind this interface when running more than one API instance.
 *
 * The client address comes from the socket. `X-Forwarded-For` is honoured only for the number of
 * proxy hops the operator declares (TRUSTED_PROXY_HOPS), counted from the right, because anything
 * further left is whatever the client chose to send.
 */
export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  windowMs: number;
  /** Bucket name so different route groups do not share counters. */
  name: string;
  keyOf?: (c: Context) => string | Promise<string>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 200_000;
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number, force = false) {
  if (!force && now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

let trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0) || 0;
/** Test/boot hook. */
export function setTrustedProxyHops(n: number) {
  trustedProxyHops = Math.max(0, Math.floor(n));
}

export function clientIp(c: Context): string {
  if (trustedProxyHops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // With n trusted proxies the client is the n-th address from the right.
    const idx = chain.length - trustedProxyHops;
    if (idx >= 0 && chain[idx]) return chain[idx]!.slice(0, 64);
  }
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch {
    /* not on a socket (tests, embedded) */
  }
  return "local";
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const now = Date.now();
    sweep(now);
    if (buckets.size >= MAX_BUCKETS) {
      sweep(now, true);
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    const key = `${opts.name}:${await (opts.keyOf ?? clientIp)(c)}`;
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

/** Per-account key for login and password reset, so one address cannot hammer a single account through many proxies. */
export async function accountKey(c: Context): Promise<string> {
  try {
    const body = (await c.req.json()) as { email?: unknown };
    if (typeof body.email === "string") return `acct:${body.email.trim().toLowerCase().slice(0, 254)}`;
  } catch {
    /* not JSON; fall through to ip */
  }
  return `ip:${clientIp(c)}`;
}

/** Test hook. */
export function resetRateLimits() {
  buckets.clear();
}
