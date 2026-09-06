import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Db, DbLike } from "@referly/core";
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
import { rateLimit } from "./lib/ratelimit";
import { PRIVATE_PREFIX, type FileStorage } from "./storage";

export interface AppConfig {
  /** Base URL of this API, used to build tracking/join links. */
  baseUrl: string;
  /** Base URL of the affiliate portal / merchant web app. */
  webUrl: string;
  cookieSecure: boolean;
  /** Frozen clock for tests. */
  now?: () => Date;
  /** Requests per window per IP. Windows: redirect 1 min, public 10 min, auth 15 min. */
  rateLimits?: { redirect: number; public: number; auth: number };
}

export interface AppDeps {
  /** Root connection at construction; inside a request this is the request's transaction. */
  db: DbLike;
  email: messaging.EmailProvider;
  storage: FileStorage;
  config: AppConfig;
}

export function createApp(deps: AppDeps & { db: Db }) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
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
      return c.json({ ok: false, db: "down", error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  // Abuse protection on everything reachable without credentials (PRD s13).
  const rl = deps.config.rateLimits ?? { redirect: 300, public: 30, auth: 30 };
  app.use("/r/*", rateLimit({ name: "redirect", limit: rl.redirect, windowMs: 60_000 }));
  app.use("/join/*", rateLimit({ name: "public", limit: rl.public, windowMs: 10 * 60_000 }));
  app.use("/invite/*", rateLimit({ name: "public", limit: rl.public, windowMs: 10 * 60_000 }));
  app.use("/v1/auth/*", rateLimit({ name: "auth", limit: rl.auth, windowMs: 15 * 60_000 }));

  // Uploaded files (local storage only; S3 serves its own objects). Keys are unguessable and tenant-scoped.
  app.get("/files/*", async (c) => {
    const key = c.req.path.slice("/files/".length);
    if (key.startsWith(PRIVATE_PREFIX)) return c.notFound();
    const file = await deps.storage.get(key);
    if (!file) return c.notFound();
    return new Response(file.data as unknown as BodyInit, {
      headers: { "content-type": file.contentType, "cache-control": "public, max-age=31536000, immutable", "content-length": String(file.data.byteLength) },
    });
  });

  // Every data-touching route runs in one transaction with row-level security active.
  for (const prefix of ["/r/*", "/join/*", "/invite/*", "/v1/*", "/portal/*"]) app.use(prefix, rlsTransaction(deps.db));

  // Public, unauthenticated: tracking redirect, join/apply, invites, signup/login.
  app.route("/", publicRoutes());
  app.route("/v1/auth", authRoutes());

  // Everything below resolves a tenant context from a session or API key.
  app.use("/v1/*", authMiddleware());
  app.use("/portal/*", authMiddleware());
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
  app.route("/portal", portalRoutes());

  return app;
}

export type App = ReturnType<typeof createApp>;
