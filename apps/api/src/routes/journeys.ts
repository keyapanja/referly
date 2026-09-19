import { Hono } from "hono";
import { journeys } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Website journeys (TRK-09) as totals: how many of the people affiliates sent arrived, read, reached the checkout and bought. */
export function journeyRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    return c.json(await journeys.journeyReport(c.get("deps").db, c.get("ctx"), { days: q.days ? Number(q.days) : 30, affiliateId: q.affiliateId || undefined }));
  });

  return r;
}
