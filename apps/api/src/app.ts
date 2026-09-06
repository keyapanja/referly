import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Db } from "@referly/core";
import type { messaging } from "@referly/core";
import { errorHandler } from "./lib/errors";
import { authMiddleware, type AppEnv } from "./lib/auth";
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

export interface AppConfig {
  /** Base URL of this API, used to build tracking/join links. */
  baseUrl: string;
  /** Base URL of the affiliate portal / merchant web app. */
  webUrl: string;
  cookieSecure: boolean;
  /** Frozen clock for tests. */
  now?: () => Date;
}

export interface AppDeps {
  db: Db;
  email: messaging.EmailProvider;
  config: AppConfig;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", cors({ origin: deps.config.webUrl, credentials: true }));
  if (process.env.NODE_ENV !== "test") app.use("*", logger());
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("now", deps.config.now ?? (() => new Date()));
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

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
  app.route("/portal", portalRoutes());

  return app;
}

export type App = ReturnType<typeof createApp>;
