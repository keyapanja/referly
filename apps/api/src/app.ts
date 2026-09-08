import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Db, DbLike, integrations, Lookup } from "@referly/core";
import type { messaging } from "@referly/core";
import { errorHandler } from "./lib/errors";
import { authMiddleware, type AppEnv } from "./lib/auth";
import { rlsTransaction } from "./lib/rls";
import { authRoutes } from "./routes/auth";
import { tenantRoutes } from "./routes/tenant";
import { offerRoutes } from "./routes/offers";
import { programRoutes } from "./routes/programs";
import { affiliateRoutes } from "./routes/affiliates";
import { conversionRoutes } from "./routes/conversions";
import { commissionRoutes } from "./routes/commissions";
import { payoutRoutes } from "./routes/payouts";
import { publicRoutes } from "./routes/public";
import { portalRoutes } from "./routes/portal";
import { messageRoutes } from "./routes/messages";
import { analyticsRoutes } from "./routes/analytics";
import { assetRoutes } from "./routes/assets";
import { adminRoutes } from "./routes/admin";
import { campaignRoutes } from "./routes/campaigns";
import { automationRoutes } from "./routes/automation";
import { groupRoutes } from "./routes/groups";
import { disputeRoutes } from "./routes/disputes";
import { webhookRoutes } from "./routes/webhooks";
import { rateLimit, accountKey, setTrustedProxyHops } from "./lib/ratelimit";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { MAX_UPLOAD_BYTES, PRIVATE_PREFIX, type FileStorage } from "./storage";

export interface AppConfig {
  /** Base URL of this API, used to build tracking/join links. */
  baseUrl: string;
  /** Base URL of the affiliate portal / merchant web app. */
  webUrl: string;
  cookieSecure: boolean;
  /** Frozen clock for tests. */
  now?: () => Date;
  /** Shown to merchants who need a plan change. */
  supportEmail?: string;
  /** Requests per window per IP. Windows: redirect 1 min, public 10 min, auth 15 min. */
  rateLimits?: { redirect: number; public: number; auth: number };
  /** Number of reverse proxies in front of the API whose X-Forwarded-For entries are trusted (0 = use the socket address). */
  trustedProxyHops?: number;
}

/** JSON bodies are small; only the multipart upload route may carry a real file. */
const JSON_BODY_LIMIT = 256 * 1024;

export interface AppDeps {
  /** Root connection at construction; inside a request this is the request's transaction. */
  db: DbLike;
  email: messaging.EmailProvider;
  storage: FileStorage;
  config: AppConfig;
  /** Overrides for payout provider construction (tests inject an in-memory provider). */
  payoutProviders?: integrations.IntegrationDeps;
  /** fetch used for outbound webhook deliveries and tests (tests inject a stub). */
  webhookFetch?: typeof fetch;
  /** DNS resolver for the outbound-webhook SSRF check (tests inject one). */
  webhookLookup?: Lookup;
  /** Text (SMS/WhatsApp) provider construction and platform fallback. */
  text?: integrations.TextDeps;
}

export function createApp(deps: AppDeps & { db: Db }) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  if (deps.config.trustedProxyHops !== undefined) setTrustedProxyHops(deps.config.trustedProxyHops);
  app.use("*", secureHeaders({ xFrameOptions: "DENY", referrerPolicy: "no-referrer", strictTransportSecurity: deps.config.cookieSecure ? "max-age=31536000; includeSubDomains" : false, crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false, xXssProtection: false }));
  app.use("*", async (c, next) => {
    const max = c.req.path === "/v1/assets/upload" ? MAX_UPLOAD_BYTES + 64 * 1024 : JSON_BODY_LIMIT;
    return bodyLimit({ maxSize: max, onError: (ctx) => ctx.json({ error: { code: "payload_too_large", message: `request body exceeds ${max} bytes` } }, 413) })(c, next);
  });
  app.use("*", cors({ origin: deps.config.webUrl, credentials: true }));
  if (process.env.NODE_ENV !== "test") app.use("*", logger());
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("now", deps.config.now ?? (() => new Date()));
    await next();
  });

  app.get("/health", async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ ok: true, db: "up" });
    } catch (err) {
      console.error("[health] database check failed", err instanceof Error ? err.message : err);
      return c.json({ ok: false, db: "down" }, 503);
    }
  });

  // Abuse protection on everything reachable without credentials (PRD s13).
  const rl = deps.config.rateLimits ?? { redirect: 300, public: 30, auth: 30 };
  app.use("/r/*", rateLimit({ name: "redirect", limit: rl.redirect, windowMs: 60_000 }));
  app.use("/join/*", rateLimit({ name: "public", limit: rl.public, windowMs: 10 * 60_000 }));
  app.use("/invite/*", rateLimit({ name: "public", limit: rl.public, windowMs: 10 * 60_000 }));
  app.use("/hooks/*", rateLimit({ name: "redirect", limit: rl.redirect, windowMs: 60_000 }));
  app.use("/v1/auth/*", rateLimit({ name: "auth", limit: rl.auth, windowMs: 15 * 60_000 }));
  // A second, per-account bucket on the two endpoints an attacker aims at a specific user.
  app.use("/v1/auth/login", rateLimit({ name: "auth-account", limit: Math.max(rl.auth, 20), windowMs: 15 * 60_000, keyOf: accountKey }));
  app.use("/v1/auth/forgot-password", rateLimit({ name: "auth-account", limit: 5, windowMs: 15 * 60_000, keyOf: accountKey }));
  app.use("/files/*", rateLimit({ name: "files", limit: rl.redirect * 2, windowMs: 60_000 }));

  // Uploaded files (local storage only; S3 serves its own objects). Keys are unguessable and tenant-scoped.
  // Files share the API origin with the session cookie, so nothing served here may run script:
  // a sandboxed CSP, nosniff, and download-only for the two formats that can carry markup.
  app.get("/files/*", async (c) => {
    const key = c.req.path.slice("/files/".length);
    if (key.toLowerCase().startsWith(PRIVATE_PREFIX)) return c.notFound();
    const file = await deps.storage.get(key);
    if (!file) return c.notFound();
    const type = file.contentType.toLowerCase();
    const inline = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/.test(type);
    return new Response(file.data as unknown as BodyInit, {
      headers: {
        "content-type": inline || type === "image/svg+xml" || type === "application/pdf" ? type : "application/octet-stream",
        "content-disposition": inline ? "inline" : `attachment; filename="${key.split("/").pop() ?? "file"}"`,
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": String(file.data.byteLength),
      },
    });
  });

  // Every data-touching route runs in one transaction with row-level security active.
  for (const prefix of ["/r/*", "/join/*", "/invite/*", "/hooks/*", "/v1/*", "/portal/*", "/admin/*"]) app.use(prefix, rlsTransaction(deps.db));

  // Public, unauthenticated: tracking redirect, join/apply, invites, signup/login.
  app.route("/", publicRoutes());
  app.route("/v1/auth", authRoutes());

  // Everything below resolves a tenant context from a session or API key.
  app.use("/v1/*", authMiddleware());
  app.use("/portal/*", authMiddleware());
  app.use("/admin/*", authMiddleware());
  app.route("/admin", adminRoutes());
  app.route("/v1/tenant", tenantRoutes());
  app.route("/v1/offers", offerRoutes());
  app.route("/v1/programs", programRoutes());
  app.route("/v1/affiliates", affiliateRoutes());
  app.route("/v1/conversions", conversionRoutes());
  app.route("/v1/commissions", commissionRoutes());
  app.route("/v1/payouts", payoutRoutes());
  app.route("/v1/messages", messageRoutes());
  app.route("/v1/analytics", analyticsRoutes());
  app.route("/v1/assets", assetRoutes());
  app.route("/v1/campaigns", campaignRoutes());
  app.route("/v1/automation", automationRoutes());
  app.route("/v1/groups", groupRoutes());
  app.route("/v1/disputes", disputeRoutes());
  app.route("/v1/webhooks", webhookRoutes());
  app.route("/portal", portalRoutes());

  return app;
}

export type App = ReturnType<typeof createApp>;
