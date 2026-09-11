import { Hono } from "hono";
import { journeys } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Website journeys recorded by the site snippet (TRK-09): sessions from affiliate traffic and what each visitor did. */
export function journeyRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    const days = q.days ? Number(q.days) : 30;
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const [sessions, summary] = await Promise.all([
      journeys.listSessions(db, ctx, { days, affiliateId: q.affiliateId || undefined, converted: q.converted === "1", limit: q.limit ? Number(q.limit) : undefined }),
      journeys.journeySummary(db, ctx, days),
    ]);
    return c.json({ sessions, summary });
  });

  r.get("/sessions/:visitorId/:sessionId", async (c) => c.json({ events: await journeys.sessionEvents(c.get("deps").db, c.get("ctx"), c.req.param("visitorId"), c.req.param("sessionId")) }));
  r.get("/visitors/:visitorId", async (c) => c.json({ events: await journeys.visitorEvents(c.get("deps").db, c.get("ctx"), c.req.param("visitorId")) }));

  return r;
}
