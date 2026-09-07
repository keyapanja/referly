import { Hono } from "hono";
import { platform, forbidden, setRlsBypass, type Tx } from "@referly/core";
import type { AppEnv } from "../lib/auth";

/**
 * Platform admin API (PRD s15: cross-tenant operational access reserved for the SaaS operator
 * team). Requires the platform_admin role; the request transaction is switched to RLS bypass
 * because every handler here reads across tenants on purpose.
 */
export function adminRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    const p = c.get("principal");
    if (p.kind !== "user" || p.role !== "platform_admin") throw forbidden("platform admin only");
    await setRlsBypass(c.get("deps").db as Tx);
    await next();
  });

  r.get("/overview", async (c) => c.json(await platform.platformOverview(c.get("deps").db, c.get("now")())));
  r.get("/tenants", async (c) => c.json({ tenants: await platform.listTenants(c.get("deps").db, { q: c.req.query("q"), limit: Number(c.req.query("limit") ?? 100) }, c.get("now")()) }));
  r.get("/tenants/:id", async (c) => c.json(await platform.getTenantDetail(c.get("deps").db, c.req.param("id"), c.get("now")())));
  r.patch("/tenants/:id", async (c) => {
    const p = c.get("principal");
    const userId = p.kind === "user" ? p.userId : "";
    return c.json({ tenant: await platform.updateTenantByAdmin(c.get("deps").db, { userId }, c.req.param("id"), await c.req.json(), c.get("now")()) });
  });
  r.get("/jobs", async (c) => c.json({ jobs: await platform.listProblemJobs(c.get("deps").db) }));
  r.post("/jobs/:id/retry", async (c) => c.json({ job: await platform.retryJob(c.get("deps").db, c.req.param("id"), c.get("now")()) }));
  return r;
}
